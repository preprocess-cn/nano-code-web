/**
 * Playwright 前端集成测试
 * 启动独立 NanoCodeWebServer + 用 Playwright 浏览器验证前端渲染
 *
 * 用法: npx tsx --test tests/frontend.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { NanoCodeWebServer } from '../src/server.js';
import { chromium, type Browser, type Page } from 'playwright';

/** 等待 SSE 连接就绪 */
async function waitForConnected(page: Page, timeout = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const connected = await page.evaluate(() => {
      const dot = document.getElementById('status-dot');
      return dot?.className.includes('connected') ?? false;
    });
    if (connected) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('SSE 连接超时');
}

/** 通过 evaluate 直接让 #messages 容器可见，绕过输入框状态 */
async function showMessages(page: Page): Promise<void> {
  await page.evaluate(() => {
    const msgArea = document.getElementById('messages');
    if (msgArea) {
      msgArea.classList.add('show');
      document.getElementById('welcome')?.classList.add('hidden');
    }
  });
}

describe('前端渲染测试', { concurrency: false }, () => {
  let server: NanoCodeWebServer;
  let port: number;
  let browser: Browser;
  let page: Page;

  before(async () => {
    server = new NanoCodeWebServer({ port: 0, host: '127.0.0.1' });
    port = await server.start();
    browser = await chromium.launch({ headless: true });
  });

  after(async () => {
    await page?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await server?.stop().catch(() => {});
  });

  /** 每个测试前打开新页面并显示消息容器 */
  async function newPage(): Promise<Page> {
    if (page) await page.close().catch(() => {});
    page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded' });
    await waitForConnected(page);
    await showMessages(page);
    return page;
  }

  it('页面加载后显示连接状态', async () => {
    const p = await newPage();
    const text = await p.locator('#status-text').textContent();
    assert.ok(text?.includes('Connected') || text?.includes('Connecting'));
  });

  it('tool:call 事件渲染工具卡片', async () => {
    const p = await newPage();

    server.broadcast('tool:call', {
      id: 'call_1', toolName: 'readFile',
      args: { path: '/tmp/test.txt' }, agentName: 'main',
    });
    await p.waitForTimeout(300);

    const card = p.locator('.tool-card');
    assert.ok(await card.isVisible(), '工具卡片应可见');
    const text = await card.textContent();
    assert.ok(text?.includes('readFile'), `卡片应包含工具名 readFile, 实际: ${text}`);
    assert.ok(text?.includes('running'), `卡片应包含 running 状态, 实际: ${text}`);

    const argsEl = card.locator('.tool-section-content').first();
    const argsText = await argsEl.textContent();
    assert.ok(argsText?.includes('/tmp/test.txt'), `args 应显示路径, 实际: ${argsText}`);
  });

  it('tool:result 更新卡片状态', async () => {
    const p = await newPage();

    server.broadcast('tool:call', {
      id: 'call_2', toolName: 'listDirectory',
      args: { dir: '.' }, agentName: 'main',
    });
    await p.waitForTimeout(50);

    server.broadcast('tool:result', {
      id: 'call_2', toolName: 'listDirectory',
      status: 'success', message: 'ok', agentName: 'main',
    });
    await p.waitForTimeout(200);

    const card = p.locator('.tool-card');
    // 确认没有 opacity:0.5 的淡出
    const opacity = await card.evaluate((el: HTMLElement) => el.style.opacity);
    assert.equal(opacity, '', '工具卡片不应有 opacity 淡出');
    // 状态文字更新为 ok
    const text = await card.textContent();
    assert.ok(text?.includes('ok'), `卡片应显示 ok, 实际: ${text}`);
  });

  it('工具卡片在文本流中保持可见', async () => {
    const p = await newPage();

    // 工具调用
    server.broadcast('tool:call', {
      id: 'call_3', toolName: 'readFile',
      args: { path: '/tmp/data.txt' }, agentName: 'main',
    });
    await p.waitForTimeout(50);

    server.broadcast('tool:result', {
      id: 'call_3', toolName: 'readFile',
      status: 'success', message: 'ok', agentName: 'main',
    });
    await p.waitForTimeout(50);

    // 流式输出文本（模拟工具调用后的响应）
    const chunks = ['文件', '内容', '如下：', 'line1', 'line2'];
    for (const chunk of chunks) {
      server.broadcast('stream:chunk', { text: chunk, agentName: 'main' });
      await p.waitForTimeout(20);
    }
    await p.waitForTimeout(300);

    // 工具卡片仍在
    const cards = p.locator('.tool-card');
    assert.equal(await cards.count(), 1, '应只有一张工具卡片');
    assert.ok(await cards.first().isVisible(), '工具卡片应可见');

    // 文本气泡出现在卡片之后（通过 evaluate 获取 DOM 类名顺序）
    const order = await p.evaluate(() => {
      const children = document.querySelectorAll('#messages > *');
      const classes = Array.from(children).map(el => el.className);
      const toolIdx = classes.findIndex(c => c.includes('tool-card'));
      const msgIdx = classes.findIndex(c => c.includes('msg assistant'));
      return { toolIdx, msgIdx, classes };
    });
    assert.ok(order.toolIdx >= 0, '应存在工具卡片');
    assert.ok(order.msgIdx >= 0, '应存在助理消息');
    assert.ok(order.toolIdx < order.msgIdx, `工具卡片应在助理消息之前, 类列表: ${order.classes.join(', ')}`);
  });

  it('空 args 不渲染 tool-args 区域', async () => {
    const p = await newPage();

    server.broadcast('tool:call', {
      id: 'call_4', toolName: 'runCommand',
      args: {}, agentName: 'main',
    });
    await p.waitForTimeout(300);

    const card = p.locator('.tool-card');
    assert.ok(await card.isVisible(), '工具卡片应可见');
    // args 为空时不应渲染 Arguments 标签区域
    const hasArgsLabel = await card.locator('.tool-section-label').evaluateAll(labels => labels.some(l => l.textContent === 'Arguments'));
    assert.ok(!hasArgsLabel, '空 args 不应显示 Arguments 区域');
  });

  it('session:start 清空旧消息和工具卡片', async () => {
    const p = await newPage();

    // 第一轮会话
    server.broadcast('session:start', {
      greeting: '第一轮', agentName: 'main',
      showThink: false, debug: false,
    });
    await p.waitForTimeout(50);
    await showMessages(p); // session:start 会隐藏 messages，重新显示

    server.broadcast('tool:call', {
      id: 'call_5', toolName: 'readFile',
      args: { path: '/tmp/a.txt' }, agentName: 'main',
    });
    await p.waitForTimeout(100);
    assert.ok(await p.locator('.tool-card').isVisible(), '第一轮工具卡片应可见');

    // 第二轮会话——应清空卡片
    server.broadcast('session:start', {
      greeting: '第二轮', agentName: 'main',
      showThink: false, debug: false,
    });
    await p.waitForTimeout(200);

    assert.equal(await p.locator('.tool-card').count(), 0, '新会话应清空工具卡片');
    // welcome 可见（hidden 类不存在）
    const welcomeHidden = await p.locator('#welcome').evaluate(el => el.classList.contains('hidden'));
    assert.ok(!welcomeHidden, '新会话应显示欢迎页');
  });

  it('debug:true 时显示 debug 事件', async () => {
    const p = await newPage();

    server.broadcast('session:start', {
      greeting: '您好', agentName: 'main',
      showThink: false, debug: true,
    });
    await p.waitForTimeout(100);

    server.broadcast('debug', {
      data: '这是调试信息',
      agentName: 'main',
    });
    await p.waitForTimeout(200);

    const sysMsg = p.locator('.msg.system');
    const text = await sysMsg.textContent();
    assert.ok(text?.includes('[debug]'), `system 消息应包含 [debug], 实际: ${text}`);
    assert.ok(text?.includes('这是调试信息'), `system 消息应显示调试内容, 实际: ${text}`);
  });

  it('debug:false 时隐藏 debug 事件', async () => {
    const p = await newPage();

    server.broadcast('session:start', {
      greeting: '您好', agentName: 'main',
      showThink: false, debug: false,
    });
    await p.waitForTimeout(100);

    server.broadcast('debug', {
      data: '不该显示',
      agentName: 'main',
    });
    await p.waitForTimeout(200);

    const allText = await p.locator('#messages').textContent();
    assert.ok(!allText?.includes('不该显示'), 'debug=false 时不应显示 debug 信息');
  });

  it('user:input 事件渲染用户消息气泡', async () => {
    const p = await newPage();

    server.broadcast('session:start', {
      greeting: '您好', agentName: 'main',
      showThink: false, debug: false,
    });
    await p.waitForTimeout(50);

    server.broadcast('user:input', { text: '测试用户消息', agentName: 'main' });
    await p.waitForTimeout(200);

    const userMsg = p.locator('.msg.user');
    assert.ok(await userMsg.isVisible(), '用户消息气泡应可见');
    assert.ok((await userMsg.textContent())?.includes('测试用户消息'), '消息内容应正确');
  });
});
