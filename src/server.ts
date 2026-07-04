import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

export type InputCallback = (text: string) => void;
export type CancelCallback = () => void;
export type ConfirmCallback = (id: string, approved: boolean) => void;
export type ConnectCallback = (client: SSEClient) => void;

export interface SSEClient {
  id: string;
  res: http.ServerResponse;
}

export class NanoCodeWebServer {
  private server: http.Server;
  private clients: SSEClient[] = [];
  private fileDir: string;
  private port: number;
  private host: string;
  private htmlContent: string | null = null;
  private inputCb: InputCallback | null = null;
  private cancelCb: CancelCallback | null = null;
  private confirmCb: ConfirmCallback | null = null;
  private connectCb: ConnectCallback | null = null;
  /** 实际监听端口（start 后设置） */
  portUsed: number = 0;

  constructor(opts?: { port?: number; host?: string; fileDir?: string }) {
    this.port = opts?.port ?? 3030;
    this.host = opts?.host ?? '0.0.0.0';
    this.fileDir = opts?.fileDir ?? path.join(os.tmpdir(), 'nano-code-web-files');
    this.server = this.createServer();
  }

  onInput(cb: InputCallback): void { this.inputCb = cb; }
  onCancel(cb: CancelCallback): void { this.cancelCb = cb; }
  onConfirm(cb: ConfirmCallback): void { this.confirmCb = cb; }
  /** 新 SSE 客户端连入时回调，可发送初始状态 */
  onConnect(cb: ConnectCallback): void { this.connectCb = cb; }

  async start(): Promise<number> {
    await fs.promises.mkdir(this.fileDir, { recursive: true });
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, this.host, () => {
        const addr = this.server.address();
        this.portUsed = addr && typeof addr === 'object' ? addr.port : this.port;
        resolve(this.portUsed);
      });
      this.server.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    for (const c of this.clients) c.res.end();
    this.clients = [];
    this.server.closeAllConnections?.();
    this.server.close();
    await fs.promises.rm(this.fileDir, { recursive: true, force: true }).catch(() => {});
  }

  hasClients(): boolean {
    return this.clients.length > 0;
  }

  /** 向所有 SSE 客户端广播事件 */
  broadcast(type: string, data: Record<string, unknown>): void {
    const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) c.res.write(msg);
  }

  /** 写入大内容到临时文件，返回 URL */
  async writeContent(content: string, ext = '.txt'): Promise<{ uuid: string; url: string }> {
    const uuid = crypto.randomUUID();
    const filePath = path.join(this.fileDir, `${uuid}${ext}`);
    await fs.promises.writeFile(filePath, content, 'utf-8');
    setTimeout(() => fs.promises.unlink(filePath).catch(() => {}), 10 * 60 * 1000);
    return { uuid, url: `/web-files/${uuid}${ext}` };
  }

  // ── HTTP 路由 ──

  private createServer(): http.Server {
    return http.createServer((req, res) => {
      try {
        // 目录遍历防护：必须在 URL 解析之前检查原始路径
        if (req.url?.includes('..')) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }
        const sUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

        if (req.method === 'GET' && sUrl.pathname === '/events') return this.handleSSE(req, res);
        if (req.method === 'POST' && sUrl.pathname === '/input') return this.handleInput(req, res);
        if (req.method === 'POST' && sUrl.pathname === '/cancel') return this.handleCancel(req, res);
        if (req.method === 'POST' && sUrl.pathname === '/confirm') return this.handleConfirm(req, res);
        if (req.method === 'GET' && sUrl.pathname === '/health') return this.handleHealth(res);
        if (req.method === 'GET' && sUrl.pathname.startsWith('/web-files/')) return this.handleFile(req, res, sUrl.pathname);
        if (req.method === 'GET' && sUrl.pathname.startsWith('/vendor/')) return this.handleVendor(res, sUrl.pathname);
        return this.handleIndex(res);
      } catch {
        res.writeHead(500);
        res.end('Internal Server Error');
      }
    });
  }

  private handleSSE(_req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.flushHeaders();

    const client: SSEClient = { id: crypto.randomUUID(), res };

    // 新客户端连入时，发送当前状态（用于浏览器晚于 server 启动的场景）
    this.connectCb?.(client);

    // 初始化完成后才加入广播列表，避免初始化期间收到 broadcast 写入
    this.clients.push(client);

    const keepAlive = setInterval(() => { res.write(':keepalive\n\n'); }, 15000);

    const onClose = () => {
      clearInterval(keepAlive);
      this.clients = this.clients.filter(c => c.id !== client.id);
    };
    // SSE 连接永不结束，需要用 socket close 检测客户端断开
    _req.socket?.on('close', onClose);
  }

  private handleInput(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const text = typeof parsed?.text === 'string' ? parsed.text : '';
        if (text && this.inputCb) this.inputCb(text);
      } catch {
        // 非 JSON 格式，直接作为文本
        if (body.trim() && this.inputCb) this.inputCb(body.trim());
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true }));
    });
  }

  private handleCancel(_req: http.IncomingMessage, res: http.ServerResponse): void {
    if (this.cancelCb) this.cancelCb();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true }));
  }

  private handleConfirm(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        if (typeof parsed?.id === 'string' && typeof parsed?.approved === 'boolean' && this.confirmCb) {
          this.confirmCb(parsed.id, parsed.approved);
        }
      } catch { /* ignore parse errors */ }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true }));
    });
  }

  private handleHealth(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ status: 'ok', clients: this.clients.length }));
  }

  private handleFile(_req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
    const fileName = pathname.slice('/web-files/'.length);
    // 目录遍历防护
    if (fileName.includes('..') || fileName.includes('/')) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    const filePath = path.join(this.fileDir, fileName);
    if (!filePath.startsWith(this.fileDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    let stream: fs.ReadStream;
    try {
      fs.statSync(filePath);
      stream = fs.createReadStream(filePath);
    } catch {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=300',
    });
    stream.pipe(res);
  }

  private handleVendor(res: http.ServerResponse, pathname: string): void {
    const fileName = pathname.slice('/vendor/'.length);
    if (fileName.includes('..') || fileName.includes('/')) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    const scriptDir = new URL('.', import.meta.url).pathname;
    const candidates = [
      path.join(scriptDir, 'vendor', fileName),
      path.join(scriptDir, '..', 'dist', 'vendor', fileName),
    ];
    let content: Buffer | null = null;
    for (const p of candidates) {
      try { content = fs.readFileSync(p); break; } catch { /* try next */ }
    }
    if (!content) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const ext = path.extname(fileName);
    const mime: Record<string, string> = { '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
    res.writeHead(200, {
      'Content-Type': mime[ext] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(content);
  }

  private handleIndex(res: http.ServerResponse): void {
    if (!this.htmlContent) {
      const scriptDir = new URL('.', import.meta.url).pathname;
      // 尝试多个路径: 同目录 (dist/) → ../public/ (tsx 开发模式)
      const candidates = [
        path.join(scriptDir, 'index.html'),
        path.join(scriptDir, '..', 'public', 'index.html'),
        path.join(scriptDir, '..', '..', 'public', 'index.html'),
      ];
      for (const p of candidates) {
        try {
          this.htmlContent = fs.readFileSync(p, 'utf-8');
          break;
        } catch { /* try next */ }
      }
      if (!this.htmlContent) {
        this.htmlContent = '<!DOCTYPE html><html lang="zh"><meta charset="utf-8"><title>nano-code-web</title><body><h1>nano-code-web</h1><p>index.html 未找到</p></body></html>';
      }
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(this.htmlContent);
  }
}
