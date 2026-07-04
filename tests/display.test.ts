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
});
