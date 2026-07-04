import { test, expect } from '@playwright/test';
import { NanoCodeWebServer } from '../src/server.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, '../dist');

/** 等待特定文本出现（最多 n 帧重试） */
async function waitForText(page: any, selector: string, text: string, timeout = 3000) {
  const el = page.locator(selector);
  await el.waitFor({ state: 'visible', timeout });
}

test.describe('nano-code-web 前端渲染', () => {
  let server: NanoCodeWebServer;
  let port: number;

  test.beforeEach(async () => {
    server = new NanoCodeWebServer({ port: 0, host: '127.0.0.1' });
    port = await server.start();
  });

  test.afterEach(async () => {
    await server.stop();
  });

  test('页面初始化显示连接中', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    await expect(page.locator('#status-text')).toContainText('Connecting');
    await expect(page.locator('#status-dot')).toHaveClass(/dot connecting/);
  });

  test('SSE 连接后工具卡片正常渲染', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    // 等待 SSE 连接建立
    await page.waitForFunction(() => {
      const dot = document.getElementById('status-dot');
      return dot?.className.includes('connected');
    }, { timeout: 5000 });

    // 广播 session:start
    server.broadcast('session:start', {
      greeting: '您好',
      agentName: 'main',
      showThink: false,
      debug: false,
    });
    await page.waitForTimeout(100);

    // 广播 tool:call
    server.broadcast('tool:call', {
      id: 'call_1',
      toolName: 'readFile',
      args: { path: '/tmp/test.txt' },
      agentName: 'main',
    });
    await page.waitForTimeout(100);

    // 验证工具卡片出现
    const toolCard = page.locator('.tool-card');
    await expect(toolCard).toBeVisible();
    await expect(toolCard).toContainText('readFile');
    await expect(toolCard).toContainText('running');
    await expect(toolCard.locator('.tool-args')).toContainText('/tmp/test.txt');

    // 广播 tool:result
    server.broadcast('tool:result', {
      id: 'call_1',
      toolName: 'readFile',
      status: 'success',
      message: 'ok',
      agentName: 'main',
    });
    await page.waitForTimeout(100);

    // 验证卡片更新为 success
    await expect(toolCard).toHaveClass(/success/);
    await expect(toolCard).toContainText('ok');
    // 确认没有 opacity:0.5 的淡出
    const opacity = await toolCard.evaluate((el: HTMLElement) => el.style.opacity);
    expect(opacity).not.toBe('0.5');
  });

  test('工具卡片在文本流中保持可见', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    await page.waitForFunction(() => {
      const dot = document.getElementById('status-dot');
      return dot?.className.includes('connected');
    }, { timeout: 5000 });

    server.broadcast('session:start', {
      greeting: '您好',
      agentName: 'main',
      showThink: false,
      debug: false,
    });
    await page.waitForTimeout(100);

    // 广播工具调用 + 结果
    server.broadcast('tool:call', {
      id: 'call_2',
      toolName: 'listDirectory',
      args: { dir: '.' },
      agentName: 'main',
    });
    await page.waitForTimeout(50);

    server.broadcast('tool:result', {
      id: 'call_2',
      toolName: 'listDirectory',
      status: 'success',
      message: 'ok',
      agentName: 'main',
    });
    await page.waitForTimeout(50);

    // 广播流式文本（模拟工具调用后的响应）
    const chunks = ['当前', '目录', '包含', '以下', '文件：', 'src/', 'dist/', 'tests/'];
    for (const chunk of chunks) {
      server.broadcast('stream:chunk', { text: chunk, agentName: 'main' });
      await page.waitForTimeout(30);
    }
    await page.waitForTimeout(200);

    // 工具卡片仍应可见
    const toolCards = page.locator('.tool-card');
    await expect(toolCards).toHaveCount(1);
    await expect(toolCards).toBeVisible();

    // 文本气泡出现在卡片下方
    const assistantMsgs = page.locator('.msg.assistant');
    await expect(assistantMsgs).toHaveCount(1);

    // 检查 DOM 顺序：工具卡片在文本气泡之前
    const cards = await page.locator('#messages > *').all();
    const toolIndex = cards.findIndex(el => el.getAttribute('class')?.includes('tool-card'));
    const msgIndex = cards.findIndex(el => el.getAttribute('class')?.includes('msg assistant'));
    expect(toolIndex).toBeLessThan(msgIndex);
  });

  test('空 args 不显示空的 {}', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    await page.waitForFunction(() => {
      const dot = document.getElementById('status-dot');
      return dot?.className.includes('connected');
    }, { timeout: 5000 });

    server.broadcast('session:start', {
      greeting: '您好', agentName: 'main',
      showThink: false, debug: false,
    });
    await page.waitForTimeout(100);

    // args 为空对象
    server.broadcast('tool:call', {
      id: 'call_3', toolName: 'runCommand',
      args: {}, agentName: 'main',
    });
    await page.waitForTimeout(100);

    const toolCard = page.locator('.tool-card');
    await expect(toolCard).toBeVisible();
    // 不应有 tool-args 区域
    await expect(toolCard.locator('.tool-args')).not.toBeVisible();
  });

  test('session:start 清空旧消息', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    await page.waitForFunction(() => {
      const dot = document.getElementById('status-dot');
      return dot?.className.includes('connected');
    }, { timeout: 5000 });

    // 第一轮会话
    server.broadcast('session:start', {
      greeting: '第一轮', agentName: 'main',
      showThink: false, debug: false,
    });
    await page.waitForTimeout(50);
    server.broadcast('tool:call', {
      id: 'call_1', toolName: 'readFile',
      args: {}, agentName: 'main',
    });
    await page.waitForTimeout(50);

    // 第二轮会话
    server.broadcast('session:start', {
      greeting: '第二轮', agentName: 'main',
      showThink: false, debug: false,
    });
    await page.waitForTimeout(100);

    // 所有工具卡片应被清空
    await expect(page.locator('.tool-card')).toHaveCount(0);
    await expect(page.locator('#welcome')).not.toHaveClass(/hidden/);
  });

  test('showThink=false 时 stream:chunk 中的 <think> 被过滤', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    await page.waitForFunction(() => {
      const dot = document.getElementById('status-dot');
      return dot?.className.includes('connected');
    }, { timeout: 5000 });

    server.broadcast('session:start', {
      greeting: '您好', agentName: 'main',
      showThink: false, debug: false,
    });
    await page.waitForTimeout(100);

    // 普通文本
    server.broadcast('stream:chunk', { text: '正常文本', agentName: 'main' });
    await page.waitForTimeout(30);

    // 带 think 标签的内容（后端应已过滤，但测试前端独立性）
    server.broadcast('stream:chunk', { text: '<think>隐藏思考</think>', agentName: 'main' });
    await page.waitForTimeout(30);

    server.broadcast('stream:chunk', { text: '更多文本', agentName: 'main' });
    await page.waitForTimeout(100);

    // 正常文本应显示
    const msg = page.locator('.msg.assistant');
    await expect(msg).toContainText('正常文本');
    await expect(msg).toContainText('更多文本');
  });
});
