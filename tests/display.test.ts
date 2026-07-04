import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ThinkFilter, ToolCallBroadcaster } from '../src/display.js';
import { NanoCodeWebServer } from '../src/server.js';

/** 连接 SSE，返回事件收集数组 */
async function collectSSE(url: string): Promise<{ events: Array<{ type: string; data: string }>; close: () => void }> {
  const events: Array<{ type: string; data: string }> = [];
  return new Promise((resolve, reject) => {
    const req = http.get(url, { agent: false }, (res) => {
      let buf = '';
      let eventType = '';
      res.on('data', (chunk: string) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = '';
        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i];
          if (line.startsWith('event: ')) eventType = line.slice(7);
          else if (line.startsWith('data: ')) {
            events.push({ type: eventType, data: line.slice(6) });
            eventType = '';
          }
        }
        buf = lines[lines.length - 1] ?? '';
      });
      resolve({ events, close: () => { req.destroy(); } });
    });
    req.on('error', reject);
  });
}

// ── 事件历史环形缓冲区 ──

describe('Event History Ring Buffer', { concurrency: true }, () => {
  /** 创建一个隔离的环形缓冲区模拟 display.ts 中的实现 */
  function createRing(capacity: number) {
    const ring: Array<{ type: string; data: Record<string, unknown> }> = new Array(capacity);
    let head = 0;
    let count = 0;
    return {
      push(type: string, data: Record<string, unknown>) {
        ring[(head + count) % capacity] = { type, data };
        if (count < capacity) count++;
        else head = (head + 1) % capacity;
      },
      replay(): Array<{ type: string; data: Record<string, unknown> }> {
        const result: Array<{ type: string; data: Record<string, unknown> }> = [];
        for (let i = 0; i < count; i++) result.push(ring[(head + i) % capacity]);
        return result;
      },
      clear() { head = 0; count = 0; },
      get count() { return count; },
    };
  }

  it('事件按推入顺序重放', () => {
    const buf = createRing(10);
    buf.push('a', { n: 1 });
    buf.push('b', { n: 2 });
    buf.push('c', { n: 3 });
    const replayed = buf.replay();
    assert.equal(replayed.length, 3);
    assert.equal(replayed[0].type, 'a');
    assert.equal(replayed[1].type, 'b');
    assert.equal(replayed[2].type, 'c');
  });

  it('空缓冲区重放为空数组', () => {
    const buf = createRing(10);
    assert.deepEqual(buf.replay(), []);
  });

  it('clear() 后重放为空，可重新写入', () => {
    const buf = createRing(10);
    buf.push('a', { n: 1 });
    buf.push('b', { n: 2 });
    buf.clear();
    assert.deepEqual(buf.replay(), []);
    buf.push('c', { n: 3 });
    assert.equal(buf.replay().length, 1);
    assert.equal(buf.replay()[0].data.n, 3);
  });

  it('超出容量时丢弃最旧事件', () => {
    const buf = createRing(3);
    buf.push('a', { n: 1 });
    buf.push('b', { n: 2 });
    buf.push('c', { n: 3 });
    buf.push('d', { n: 4 });
    const replayed = buf.replay();
    assert.equal(replayed.length, 3);
    assert.equal(replayed[0].data.n, 2);
    assert.equal(replayed[1].data.n, 3);
    assert.equal(replayed[2].data.n, 4);
  });

  it('填满容量时全部保留', () => {
    const buf = createRing(3);
    buf.push('a', { n: 1 });
    buf.push('b', { n: 2 });
    buf.push('c', { n: 3 });
    assert.equal(buf.replay().length, 3);
  });

  it('超出容量后继续推入保持固定长度', () => {
    const buf = createRing(3);
    buf.push('a', { n: 1 });
    buf.push('b', { n: 2 });
    buf.push('c', { n: 3 });
    buf.push('d', { n: 4 });
    buf.push('e', { n: 5 });
    assert.equal(buf.replay().length, 3);
    assert.deepEqual(buf.replay().map(e => e.data.n), [3, 4, 5]);
  });

  it('500 容量推入 501 条不崩溃，保留最新 500 条', () => {
    const buf = createRing(500);
    for (let i = 1; i <= 501; i++) buf.push('evt', { n: i });
    assert.equal(buf.replay().length, 500);
    assert.equal(buf.replay()[0].data.n, 2);   // 第 2 ~ 501
    assert.equal(buf.replay()[499].data.n, 501);
  });

  it('容量 1 的极端情况', () => {
    const buf = createRing(1);
    buf.push('a', { n: 1 });
    assert.equal(buf.replay().length, 1);
    buf.push('b', { n: 2 });
    assert.equal(buf.replay().length, 1);
    assert.equal(buf.replay()[0].data.n, 2);
  });

  it('容量 500 推入正好 500 条全部保留', () => {
    const buf = createRing(500);
    for (let i = 1; i <= 500; i++) buf.push('evt', { n: i });
    assert.equal(buf.replay().length, 500);
    assert.equal(buf.replay()[0].data.n, 1);
    assert.equal(buf.replay()[499].data.n, 500);
  });
});

// ── SSE 事件重放集成测试 ──

/** 连接 SSE，返回 { events, close }，等待 waitMs 让初始数据到达后 resolve */
function connectSSE(url: string, waitMs = 200): Promise<{ events: Array<{ type: string; data: string }>; close: () => void }> {
  return new Promise((resolve, reject) => {
    const events: Array<{ type: string; data: string }> = [];
    const req = http.get(url, { agent: false }, (res) => {
      let buf = '';
      let eventType = '';
      res.on('data', (chunk: string) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = '';
        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i];
          if (line.startsWith('event: ')) eventType = line.slice(7);
          else if (line.startsWith('data: ')) {
            events.push({ type: eventType, data: line.slice(6) });
            eventType = '';
          }
        }
        buf = lines[lines.length - 1] ?? '';
      });
      setTimeout(() => resolve({ events, close: () => { req.destroy(); } }), waitMs);
    });
    req.on('error', reject);
  });
}

describe('SSE 事件重放', { concurrency: true }, () => {
  /** 创建带环形缓冲区和重放逻辑的服务器（模拟 display.ts 的 onConnect 行为） */
  function createReplayServer() {
    const server = new NanoCodeWebServer({ port: 0, host: '127.0.0.1' });
    const MAX = 500;
    const ring: Array<{ type: string; data: Record<string, unknown> }> = new Array(MAX);
    let head = 0, count = 0;

    function pushHistory(type: string, data: Record<string, unknown>) {
      ring[(head + count) % MAX] = { type, data };
      if (count < MAX) count++;
      else head = (head + 1) % MAX;
    }

    server.onConnect((client) => {
      // 重放历史事件，合并连续的 stream:chunk
      let i = 0;
      while (i < count) {
        const evt = ring[(head + i) % MAX];
        if (evt.type === 'stream:chunk') {
          let text = '';
          const agentName = evt.data.agentName;
          while (i < count && ring[(head + i) % MAX].type === 'stream:chunk') {
            text += ring[(head + i) % MAX].data.text;
            i++;
          }
          client.res.write(`event: stream:chunk\ndata: ${JSON.stringify({ text, agentName })}\n\n`);
        } else {
          client.res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt.data)}\n\n`);
          i++;
        }
      }
    });

    return { server, pushHistory, reset() { head = 0; count = 0; } };
  }

  it('新客户端连入时重放历史事件', async () => {
    const { server, pushHistory } = createReplayServer();
    const port = await server.start();
    const baseUrl = `http://127.0.0.1:${port}`;

    pushHistory('user:input', { text: '你好', agentName: 'main' });
    pushHistory('status', { level: 'info', message: '思考中', agentName: 'main' });
    pushHistory('stream:chunk', { text: 'Hel', agentName: 'main' });
    pushHistory('stream:chunk', { text: 'lo', agentName: 'main' });

    const { events, close } = await connectSSE(`${baseUrl}/events`);

    assert.ok(events.some(e => e.type === 'user:input'), '应重放 user:input');
    assert.equal(JSON.parse(events.find(e => e.type === 'user:input')!.data).text, '你好');
    assert.ok(events.some(e => e.type === 'status'), '应重放 status');

    const chunks = events.filter(e => e.type === 'stream:chunk');
    assert.equal(chunks.length, 1, '连续的 stream:chunk 应合并为 1 条');
    assert.equal(JSON.parse(chunks[0].data).text, 'Hello');

    close();
    await server.stop();
  });

  it('空历史不发送重放事件', async () => {
    const { server } = createReplayServer();
    const port = await server.start();
    const baseUrl = `http://127.0.0.1:${port}`;

    const { events, close } = await connectSSE(`${baseUrl}/events`);

    const eventTypes = events.map(e => e.type).filter(t => t);
    assert.equal(eventTypes.length, 0);

    close();
    await server.stop();
  });

  it('非连续的 stream:chunk 不合并', async () => {
    const { server, pushHistory } = createReplayServer();
    const port = await server.start();
    const baseUrl = `http://127.0.0.1:${port}`;

    pushHistory('stream:chunk', { text: 'Hel', agentName: 'main' });
    pushHistory('tool:call', { id: 't1', toolName: 'read', agentName: 'main' });
    pushHistory('stream:chunk', { text: 'lo ', agentName: 'main' });
    pushHistory('status', { level: 'info', message: 'x', agentName: 'main' });
    pushHistory('stream:chunk', { text: '世', agentName: 'main' });
    pushHistory('user:input', { text: 'hi', agentName: 'main' });
    pushHistory('stream:chunk', { text: '界', agentName: 'main' });

    const { events, close } = await connectSSE(`${baseUrl}/events`);

    const chunks = events.filter(e => e.type === 'stream:chunk');
    assert.equal(chunks.length, 4, '被其他事件分隔的 chunk 不应合并');
    assert.equal(JSON.parse(chunks[0].data).text, 'Hel');
    assert.equal(JSON.parse(chunks[1].data).text, 'lo ');
    assert.equal(JSON.parse(chunks[2].data).text, '世');
    assert.equal(JSON.parse(chunks[3].data).text, '界');

    close();
    await server.stop();
  });

  it('reset 后重放为空', async () => {
    const { server, pushHistory, reset } = createReplayServer();
    const port = await server.start();
    const baseUrl = `http://127.0.0.1:${port}`;

    pushHistory('user:input', { text: '旧消息', agentName: 'main' });
    reset();

    const { events, close } = await connectSSE(`${baseUrl}/events`);

    assert.equal(events.find(e => e.type === 'user:input'), undefined, 'reset 后不应重放旧事件');

    close();
    await server.stop();
  });
});

describe('ToolCallBroadcaster', { concurrency: true }, () => {
  it('broadcastCall 首次广播返回 true', () => {
    const bc = new ToolCallBroadcaster();
    // 用 NanoCodeWebServer 验证
    const server = new NanoCodeWebServer({ port: 0, host: '127.0.0.1' });
    assert.ok(bc.broadcastCall(server, 'call_1', 'readFile', { path: '.' }, 'main'));
    server.stop();
  });

  it('相同 ID 重复广播返回 false（去重）', () => {
    const bc = new ToolCallBroadcaster();
    const server = new NanoCodeWebServer({ port: 0, host: '127.0.0.1' });
    assert.ok(bc.broadcastCall(server, 'call_1', 'readFile', {}, 'main'));
    assert.equal(bc.broadcastCall(server, 'call_1', 'readFile', {}, 'main'), false);
    server.stop();
  });

  it('broadcastResult 对应已广播的 ID 返回 true', () => {
    const bc = new ToolCallBroadcaster();
    const server = new NanoCodeWebServer({ port: 0, host: '127.0.0.1' });
    bc.broadcastCall(server, 'call_1', 'readFile', {}, 'main');
    assert.ok(bc.broadcastResult(server, 'call_1', 'readFile', 'success', 'ok', 'main'));
    server.stop();
  });

  it('broadcastResult 对应未广播的 ID 返回 false', () => {
    const bc = new ToolCallBroadcaster();
    const server = new NanoCodeWebServer({ port: 0, host: '127.0.0.1' });
    assert.equal(bc.broadcastResult(server, 'call_x', 'readFile', 'success', 'ok', 'main'), false);
    server.stop();
  });

  it('广播后 Call/Result 的 ID 从集合中移除，可重复广播下一轮', () => {
    const bc = new ToolCallBroadcaster();
    const server = new NanoCodeWebServer({ port: 0, host: '127.0.0.1' });
    // 第一轮
    assert.ok(bc.broadcastCall(server, 'call_1', 'readFile', {}, 'main'));
    assert.ok(bc.broadcastResult(server, 'call_1', 'readFile', 'success', 'ok', 'main'));
    // 第二轮相同 ID（模拟新 session）
    assert.ok(bc.broadcastCall(server, 'call_1', 'readFile', {}, 'main'));
    server.stop();
  });

  it('reset() 清空集合', () => {
    const bc = new ToolCallBroadcaster();
    const server = new NanoCodeWebServer({ port: 0, host: '127.0.0.1' });
    bc.broadcastCall(server, 'call_1', 'readFile', {}, 'main');
    bc.reset();
    // reset 后同一 ID 可再次广播
    assert.ok(bc.broadcastCall(server, 'call_1', 'readFile', {}, 'main'));
    server.stop();
  });

  it('SSE 客户端真正收到去重后的 tool:call 事件', async () => {
    const server = new NanoCodeWebServer({ port: 0, host: '127.0.0.1' });
    const port = await server.start();
    const bc = new ToolCallBroadcaster();

    const { events, close } = await collectSSE(`http://127.0.0.1:${port}/events`);
    await new Promise((r) => setTimeout(r, 50));

    // 模拟 NanoPlugin + DisplayPlugin 重复广播同一工具调用
    bc.broadcastCall(server, 'tool_1', 'listDirectory', { dir: '.' }, 'main'); // 首次 → 广播
    bc.broadcastCall(server, 'tool_1', 'listDirectory', { dir: '.' }, 'main'); // 重复 → 不广播
    bc.broadcastResult(server, 'tool_1', 'listDirectory', 'success', 'ok', 'main');

    await new Promise((r) => setTimeout(r, 50));

    const callEvents = events.filter((e) => e.type === 'tool:call');
    assert.equal(callEvents.length, 1, 'tool:call 只应广播一次，第二次被去重');
    assert.equal(JSON.parse(callEvents[0].data).id, 'tool_1');

    close();
    await server.stop();
  });

  it('setHistoryCallback broadcastCall 首次广播时回调被调用', () => {
    const bc = new ToolCallBroadcaster();
    const server = new NanoCodeWebServer({ port: 0, host: '127.0.0.1' });
    const calls: Array<{ type: string; data: any }> = [];
    bc.setHistoryCallback((type, data) => calls.push({ type, data }));

    bc.broadcastCall(server, 'call_1', 'readFile', { path: '.' }, 'main');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].type, 'tool:call');
    assert.equal(calls[0].data.id, 'call_1');
    server.stop();
  });

  it('setHistoryCallback broadcastCall 重复时不回调', () => {
    const bc = new ToolCallBroadcaster();
    const server = new NanoCodeWebServer({ port: 0, host: '127.0.0.1' });
    const calls: Array<{ type: string; data: any }> = [];
    bc.setHistoryCallback((type, data) => calls.push({ type, data }));

    bc.broadcastCall(server, 'call_1', 'readFile', {}, 'main');
    bc.broadcastCall(server, 'call_1', 'readFile', {}, 'main');

    assert.equal(calls.length, 1, '重复广播不应触发回调');
    server.stop();
  });

  it('setHistoryCallback broadcastResult 对应 ID 存在时回调被调用', () => {
    const bc = new ToolCallBroadcaster();
    const server = new NanoCodeWebServer({ port: 0, host: '127.0.0.1' });
    const calls: Array<{ type: string; data: any }> = [];
    bc.setHistoryCallback((type, data) => calls.push({ type, data }));

    bc.broadcastCall(server, 'call_1', 'readFile', {}, 'main');
    bc.broadcastResult(server, 'call_1', 'readFile', 'success', 'ok', 'main');

    assert.equal(calls.length, 2);
    assert.equal(calls[0].type, 'tool:call');
    assert.equal(calls[1].type, 'tool:result');
    assert.equal(calls[1].data.status, 'success');
    server.stop();
  });

  it('setHistoryCallback broadcastResult 对应 ID 不存在时不被调用', () => {
    const bc = new ToolCallBroadcaster();
    const server = new NanoCodeWebServer({ port: 0, host: '127.0.0.1' });
    const calls: Array<{ type: string; data: any }> = [];
    bc.setHistoryCallback((type, data) => calls.push({ type, data }));

    bc.broadcastResult(server, 'call_x', 'readFile', 'error', 'not found', 'main');

    assert.equal(calls.length, 0, '不存在的 ID 不应触发回调');
    server.stop();
  });

  it('setHistoryCallback 收到正确的 tool:result 数据', () => {
    const bc = new ToolCallBroadcaster();
    const server = new NanoCodeWebServer({ port: 0, host: '127.0.0.1' });
    let captured: any = null;
    bc.setHistoryCallback((type, data) => { if (type === 'tool:result') captured = data; });

    bc.broadcastCall(server, 'call_1', 'readFile', {}, 'main');
    bc.broadcastResult(server, 'call_1', 'readFile', 'error', 'file not found', 'main');

    assert.ok(captured);
    assert.equal(captured.id, 'call_1');
    assert.equal(captured.status, 'error');
    assert.equal(captured.message, 'file not found');
    assert.equal(captured.toolName, 'readFile');
    server.stop();
  });
});

describe('ThinkFilter', { concurrency: true }, () => {
  it('showThink=true 时不过滤任何内容', () => {
    const f = new ThinkFilter();
    assert.equal(f.filter('hello <think>hidden</think> world', true), 'hello <think>hidden</think> world');
    assert.equal(f.filter('<think>test</think>', true), '<think>test</think>');
    assert.equal(f.filter('no tags', true), 'no tags');
  });

  it('showThink=false 时过滤完整 <think> 块', () => {
    const f = new ThinkFilter();
    assert.equal(f.filter('hello <think>hidden</think> world', false), 'hello  world');
    assert.equal(f.filter('<think>hidden</think>', false), '');
    assert.equal(f.filter('no tags', false), 'no tags');
  });

  it('过滤开头和结尾的 <think> 块', () => {
    const f = new ThinkFilter();
    assert.equal(f.filter('<think>first</think>visible', false), 'visible');
    assert.equal(f.filter('visible<think>last</think>', false), 'visible');
  });

  it('多个 <think> 块全部过滤', () => {
    const f = new ThinkFilter();
    assert.equal(f.filter('a<think>1</think>b<think>2</think>c', false), 'abc');
  });

  it('空内容或纯 think 内容返回空字符串', () => {
    const f = new ThinkFilter();
    assert.equal(f.filter('', false), '');
    assert.equal(f.filter('<think>full content</think>', false), '');
  });

  it('跨 chunk 的 <think> 块正确过滤', () => {
    const f = new ThinkFilter();
    assert.equal(f.filter('start ', false), 'start ');
    assert.equal(f.filter('<think>mid', false), '');
    assert.equal(f.filter('dle</think> end', false), ' end');
    // 新会话应重置状态
    f.reset();
    assert.equal(f.filter('fresh', false), 'fresh');
  });

  it('跨 chunk 且 think 块切割在标签中间', () => {
    const f = new ThinkFilter();
    assert.equal(f.filter('before <thi', false), 'before ');
    assert.equal(f.filter('nk>hidden', false), '');
    assert.equal(f.filter(' text</think> after', false), ' after');
  });

  it('reset() 重置状态', () => {
    const f = new ThinkFilter();
    f.filter('<think>partial', false);
    assert.ok(f.inThink);
    f.reset();
    assert.equal(f.inThink, false);
    assert.equal(f.filter('normal text', false), 'normal text');
  });

  it('无 <think> 标签时原样返回', () => {
    const f = new ThinkFilter();
    assert.equal(f.filter('ordinary text', false), 'ordinary text');
    assert.equal(f.filter('line1\nline2\nline3', false), 'line1\nline2\nline3');
  });

  it('不完整的 <think> 被丢弃', () => {
    const f = new ThinkFilter();
    // 只有 <think> 开始没有结束
    assert.equal(f.filter('before <think>no end tag', false), 'before ');
  });

  it('残留的 </think> 在非 think 模式下被剥离', () => {
    const f = new ThinkFilter();
    // 模拟 nano-code 上游已处理 <think> 但留下 </think>
    assert.equal(f.filter('text</think> rest', false), 'text rest');
    assert.equal(f.filter('</think>leading', false), 'leading');
    assert.equal(f.filter('mid</think>dle</think>end', false), 'middleend');
  });

  it('</think> 标签跨 chunk 切割时不泄漏', () => {
    const f = new ThinkFilter();
    // 模拟 </think> 在 chunk 边界被切成 </thi 和 nk>
    assert.equal(f.filter('text</thi', false), 'text');
    assert.equal(f.filter('nk> rest', false), ' rest');
    // 正常情况：完整的 </think> 被剥离
    f.reset();
    assert.equal(f.filter('a</think>b', false), 'ab');
  });
});
