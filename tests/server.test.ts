import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { NanoCodeWebServer, type SSEClient } from '../src/server.js';

// ── Helpers ──

async function request(url: string, opts?: http.RequestOptions & { body?: string }): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const { body, ...reqOpts } = opts ?? {};
    const req = http.request(url, { agent: false, ...reqOpts }, (res) => {
      let buf = '';
      res.on('data', (chunk: string) => { buf += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body: buf, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function postJSON(url: string, data: unknown): Promise<{ status: number; body: string }> {
  return request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify(data)).toString() },
    body: JSON.stringify(data),
  });
}

/** 连接 SSE 端点，返回 { close, onEvent } */
function connectSSE(url: string): Promise<{ close: () => void; onEvent: (cb: (event: { type: string; data: string }) => void) => void }> {
  return new Promise((resolve, reject) => {
    const listeners: Array<(event: { type: string; data: string }) => void> = [];
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
            const ev = { type: eventType, data: line.slice(6) };
            for (const cb of listeners) cb(ev);
            eventType = '';
          }
        }
        buf = lines[lines.length - 1] ?? '';
      });
      resolve({
        close: () => { req.destroy(); },
        onEvent: (cb) => { listeners.push(cb); },
      });
    });
    req.on('error', reject);
  });
}

// ── Tests ──

describe('NanoCodeWebServer constructor', { concurrency: true }, () => {
  it('should use default options', () => {
    const s = new NanoCodeWebServer();
    assert.equal((s as any).port, 3030);
    assert.equal((s as any).host, '0.0.0.0');
  });

  it('should accept custom options', () => {
    const s = new NanoCodeWebServer({ port: 9999, host: '127.0.0.1' });
    assert.equal((s as any).port, 9999);
    assert.equal((s as any).host, '127.0.0.1');
  });
});

describe('HTTP routes', () => {
  const server = new NanoCodeWebServer({ port: 0, host: '127.0.0.1' });
  let baseUrl: string;

  before(async () => {
    const port = await server.start();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => { await server.stop(); });

  it('GET / 返回 HTML', async () => {
    const { status, headers, body } = await request(baseUrl);
    assert.equal(status, 200);
    assert.ok((headers['content-type'] as string)?.includes('text/html'));
    assert.ok(body.includes('<!DOCTYPE html>'));
  });

  it('GET /health 返回 JSON', async () => {
    const { status, body } = await request(`${baseUrl}/health`);
    assert.equal(status, 200);
    assert.deepEqual(JSON.parse(body), { status: 'ok', clients: 0 });
  });

  it('POST /input 触发 onInput 回调', async () => {
    const inputReceived = new Promise<string>((resolve) => {
      server.onInput((text) => resolve(text));
    });

    const { status } = await postJSON(`${baseUrl}/input`, { text: 'hello world' });
    assert.equal(status, 200);
    assert.equal(await inputReceived, 'hello world');
  });

  it('POST /input 非 JSON 也触发回调', async () => {
    const inputReceived = new Promise<string>((resolve) => {
      server.onInput((text) => resolve(text));
    });

    const { status } = await request(`${baseUrl}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'Content-Length': '14' },
      body: 'raw text input',
    });
    assert.equal(status, 200);
    assert.equal(await inputReceived, 'raw text input');
  });

  it('POST /cancel 触发 onCancel 回调', async () => {
    let cancelled = false;
    server.onCancel(() => { cancelled = true; });

    const { status } = await postJSON(`${baseUrl}/cancel`, {});
    assert.equal(status, 200);
    assert.ok(cancelled);
  });

  it('POST /confirm 触发 onConfirm 回调', async () => {
    const confirmResult = new Promise<{ id: string; approved: boolean }>(resolve => {
      server.onConfirm((id, approved) => resolve({ id, approved }));
    });
    const { status } = await postJSON(`${baseUrl}/confirm`, { id: 'cf_test', approved: true });
    assert.equal(status, 200);
    assert.deepEqual(await confirmResult, { id: 'cf_test', approved: true });
  });

  it('POST /question-answer 触发 onQuestionAnswer 回调', async () => {
    const qaResult = new Promise<{ id: string; answers: Record<string, string> }>(resolve => {
      server.onQuestionAnswer((id, answers) => resolve({ id, answers }));
    });
    const { status } = await postJSON(`${baseUrl}/question-answer`, { id: 'qd_test', answers: { q1: 'option A' } });
    assert.equal(status, 200);
    assert.deepEqual(await qaResult, { id: 'qd_test', answers: { q1: 'option A' } });
  });

  it('POST /mode-toggle 触发 onModeToggle 回调', async () => {
    let toggled = false;
    server.onModeToggle(() => { toggled = true; });
    const { status } = await postJSON(`${baseUrl}/mode-toggle`, {});
    assert.equal(status, 200);
    assert.ok(toggled);
  });
});

describe('SSE 单客户端广播', () => {
  const server = new NanoCodeWebServer({ port: 0, host: '127.0.0.1' });
  let baseUrl: string;

  before(async () => {
    const port = await server.start();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => { await server.stop(); });

  it('连接 SSE 并接收 broadcast 事件', async () => {
    const conn = await connectSSE(`${baseUrl}/events`);
    const received: Array<{ type: string; data: string }> = [];
    conn.onEvent((ev) => { received.push(ev); });

    await new Promise((r) => setTimeout(r, 100));
    server.broadcast('test:event', { foo: 'bar' });
    await new Promise((r) => setTimeout(r, 50));

    const ev = received.find((e) => e.type === 'test:event');
    assert.ok(ev, '应收到 test:event');
    assert.equal(JSON.parse(ev!.data).foo, 'bar');
    conn.close();
  });
});

describe('SSE 多客户端广播', () => {
  const server = new NanoCodeWebServer({ port: 0, host: '127.0.0.1' });
  let baseUrl: string;

  before(async () => {
    const port = await server.start();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => { await server.stop(); });

  it('broadcast 到达所有连接客户端', async () => {
    const events1: string[] = [];
    const events2: string[] = [];

    const c1 = await connectSSE(`${baseUrl}/events`);
    const c2 = await connectSSE(`${baseUrl}/events`);
    c1.onEvent((ev) => { if (ev.type) events1.push(ev.type); });
    c2.onEvent((ev) => { if (ev.type) events2.push(ev.type); });

    await new Promise((r) => setTimeout(r, 100));
    server.broadcast('broad:test', { msg: 'hello' });
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(events1.includes('broad:test'), 'client 1 应收到');
    assert.ok(events2.includes('broad:test'), 'client 2 应收到');
    c1.close();
    c2.close();
  });
});

describe('SSE hasClients', () => {
  const server = new NanoCodeWebServer({ port: 0, host: '127.0.0.1' });
  let baseUrl: string;

  before(async () => {
    const port = await server.start();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => { await server.stop(); });

  it('hasClients() 在有连接时返回 true', async () => {
    const conn = await connectSSE(`${baseUrl}/events`);
    // handleSSE 中同步 push 了 client，连接建立后 hasClients 应为 true
    assert.ok(server.hasClients(), '连接后 hasClients 应为 true');
    conn.close();
  });
});

describe('SSE onConnect', () => {
  const server = new NanoCodeWebServer({ port: 0, host: '127.0.0.1' });
  let baseUrl: string;

  before(async () => {
    const port = await server.start();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => { await server.stop(); });

  it('onConnect 回调在新客户端连接时触发', async () => {
    let connectedId: string | null = null;
    server.onConnect((client: SSEClient) => { connectedId = client.id; });

    const conn = await connectSSE(`${baseUrl}/events`);
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(connectedId, 'onConnect 应触发');
    conn.close();
  });
});

describe('文件写入与 HTTP 文件服务', () => {
  const server = new NanoCodeWebServer({ port: 0, host: '127.0.0.1' });
  let baseUrl: string;

  before(async () => {
    const port = await server.start();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => { await server.stop(); });

  it('writeContent() 创建临时文件并返回 URL', async () => {
    const { uuid, url } = await server.writeContent('test content', '.txt');
    assert.ok(uuid);
    assert.ok(url.startsWith('/web-files/'));
    assert.ok(url.endsWith('.txt'));
  });

  it('GET /web-files/:uuid 返回文件内容', async () => {
    const { url } = await server.writeContent('hello file content', '.txt');
    const { status, body } = await request(`${baseUrl}${url}`);
    assert.equal(status, 200);
    assert.equal(body, 'hello file content');
  });

  it('GET /web-files/:uuid 不存在的文件返回 404', async () => {
    const { status } = await request(`${baseUrl}/web-files/nonexistent-uuid.txt`);
    assert.equal(status, 404);
  });

  it('目录遍历攻击返回 403', async () => {
    // 使用 raw path 避免客户端 URL 标准化移除 `..`
    const urlObj = new URL(baseUrl);
    const { status } = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        { hostname: urlObj.hostname, port: urlObj.port, path: '/web-files/../../../etc/passwd', agent: false },
        (res) => { resolve({ status: res.statusCode! }); res.resume(); },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  });
});

describe('Server 生命周期', () => {
  it('start + stop 正常', async () => {
    const s = new NanoCodeWebServer({ port: 0, host: '127.0.0.1' });
    const port = await s.start();
    assert.ok(port > 0);
    assert.equal(s.portUsed, port);

    // 运行时能响应请求
    const { status } = await request(`http://127.0.0.1:${port}/health`);
    assert.equal(status, 200);

    await s.stop();
    // 关闭后应拒绝连接
    await assert.rejects(async () => {
      await request(`http://127.0.0.1:${port}/health`);
    });
  });

  it('多个 server 实例端口不冲突', async () => {
    const servers = await Promise.all([0, 0, 0].map(async () => {
      const s = new NanoCodeWebServer({ port: 0, host: '127.0.0.1' });
      await s.start();
      return s;
    }));
    const ports = servers.map((s) => s.portUsed);
    assert.equal(new Set(ports).size, servers.length, '端口应各不相同');
    await Promise.all(servers.map((s) => s.stop()));
  });
});
