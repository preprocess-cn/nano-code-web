/**
 * 工具卡片滚动后高度坍塌问题复现
 * 模拟：tool:call + tool:result + 大量文本 → 滚动到底再滚回顶部 → 检查卡片高度
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { NanoCodeWebServer } from '../src/server.js';
import { chromium, type Browser, type Page } from 'playwright';

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

describe('工具卡片滚动后高度', { concurrency: false }, () => {
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

  it('大量文本滚动后工具卡片高度不应坍塌', async () => {
    page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded' });
    await waitForConnected(page);

    // 发送用户消息（使 #messages 可见）
    await page.evaluate(() => {
      const input = document.getElementById('input') as HTMLTextAreaElement;
      input.value = '查看目录';
      (document.getElementById('send-btn') as HTMLButtonElement).click();
    });
    await page.waitForTimeout(200);

    // 发送工具调用
    server.broadcast('tool:call', {
      id: 'call_test_1', toolName: 'list_project_files',
      args: { dir: '.' }, agentName: 'main',
    });
    await page.waitForTimeout(100);

    // 获取卡片高度
    let h1 = await page.evaluate(() => {
      const c = document.querySelector('.tool-card');
      return c?.getBoundingClientRect().height || 0;
    });
    console.log('卡片初始高度:', h1);
    assert.ok(h1 > 20, `卡片初始高度应大于 20px, 实际: ${h1}`);

    // 工具结果
    server.broadcast('tool:result', {
      id: 'call_test_1', toolName: 'list_project_files',
      status: 'success', message: 'ok', agentName: 'main',
    });
    await page.waitForTimeout(100);

    // 模拟大量流式文本（撑满容器，触发滚动）
    for (let i = 0; i < 50; i++) {
      server.broadcast('stream:chunk', {
        text: `这是第${i}行内容，用来填充滚动区域。\n`,
        agentName: 'main',
      });
    }
    await page.waitForTimeout(500);

    // 滚动到底部
    await page.evaluate(() => {
      const msg = document.getElementById('messages')!;
      msg.scrollTop = msg.scrollHeight;
    });
    await page.waitForTimeout(100);

    // 记录滚动后的卡片高度
    let h2 = await page.evaluate(() => {
      const c = document.querySelector('.tool-card');
      return c?.getBoundingClientRect().height || 0;
    });
    console.log('滚动到底后卡片高度:', h2);

    // 滚回顶部
    await page.evaluate(() => {
      const msg = document.getElementById('messages')!;
      msg.scrollTop = 0;
    });
    await page.waitForTimeout(200);

    // 滚回顶部后卡片高度
    let h3 = await page.evaluate(() => {
      const c = document.querySelector('.tool-card');
      return c?.getBoundingClientRect().height || 0;
    });
    console.log('滚回顶部后卡片高度:', h3);

    // 高度不应坍塌为 0
    assert.ok(h3 > 20, `滚回顶部后卡片高度应 > 20px, 实际: ${h3}`);
  });
});
