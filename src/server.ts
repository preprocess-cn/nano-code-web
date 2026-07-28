import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { Readable } from 'node:stream';
import Busboy from 'busboy';

export type InputCallback = (text: string) => void;
export type CancelCallback = () => void;
export type ConfirmCallback = (id: string, approved: boolean) => void;
export type QuestionAnswerCallback = (id: string, answers: Record<string, string>) => void;
export type ModeToggleCallback = () => void;
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
  private questionAnswerCb: QuestionAnswerCallback | null = null;
  private modeToggleCb: ModeToggleCallback | null = null;
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
  onQuestionAnswer(cb: QuestionAnswerCallback): void { this.questionAnswerCb = cb; }
  onModeToggle(cb: ModeToggleCallback): void { this.modeToggleCb = cb; }
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
    // 倒序遍历，方便在写失败时移除失效客户端
    for (let i = this.clients.length - 1; i >= 0; i--) {
      try {
        this.clients[i].res.write(msg);
      } catch {
        this.clients.splice(i, 1);
      }
    }
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
        if (req.method === 'POST' && sUrl.pathname === '/question-answer') return this.handleQuestionAnswer(req, res);
        if (req.method === 'POST' && sUrl.pathname === '/mode-toggle') return this.handleModeToggle(req, res);
        if (req.method === 'GET' && sUrl.pathname === '/health') return this.handleHealth(res);
        if (req.method === 'POST' && sUrl.pathname === '/upload') return this.handleUpload(req, res);
        if (req.method === 'GET' && sUrl.pathname === '/download') return this.handleDownload(req, res, sUrl);
        if (req.method === 'POST' && sUrl.pathname === '/input-with-files') return this.handleInputWithFiles(req, res);
        if (req.method === 'GET' && sUrl.pathname.startsWith('/web-files/')) return this.handleFile(req, res, sUrl.pathname);
        if (req.method === 'GET' && sUrl.pathname.startsWith('/vendor/')) return this.handleVendor(res, sUrl.pathname);
        // 通用静态文件: 在 public/ 或 dist/ 下查找，存在即返回，否则走 index.html
        if (req.method === 'GET') {
          const found = this.resolvePublicFile(sUrl.pathname);
          if (found) return this.serveStaticFile(res, sUrl.pathname, found);
        }
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
    res.on('close', onClose);
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

  private handleQuestionAnswer(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        if (typeof parsed?.id === 'string' && typeof parsed?.answers === 'object' && this.questionAnswerCb) {
          this.questionAnswerCb(parsed.id, parsed.answers);
        }
      } catch { /* ignore parse errors */ }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true }));
    });
  }

  private handleModeToggle(_req: http.IncomingMessage, res: http.ServerResponse): void {
    if (this.modeToggleCb) this.modeToggleCb();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true }));
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

  // ── 文件上传（multipart/form-data）──

  private handleUpload(req: http.IncomingMessage, res: http.ServerResponse): void {
    const MAX_SIZE = 50 * 1024 * 1024;
    const bb = Busboy({ headers: req.headers, limits: { fileSize: MAX_SIZE, files: 20 } });
    const uploadDir = path.join(this.fileDir, 'uploads');
    const results: { id: string; name: string; size: number }[] = [];
    let abortedBySize = false;
    let pendingWrites = 0;
    let bbFinished = false;
    let finished = false;

    const tryFinish = () => {
      if (finished) return;
      if (!bbFinished || pendingWrites > 0) return;
      finished = true;
      if (abortedBySize) {
        res.writeHead(413, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: false, error: 'File too large, max 50MB' }));
        return;
      }
      for (const f of results) {
        this.broadcast('file:uploaded', { id: f.id, name: f.name, size: f.size });
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, files: results }));
    };

    bb.on('file', (_fieldname: string, stream: Readable, info: { filename: string }) => {
      const safeName = path.basename(info.filename).replace(/[/\\]/g, '_');
      if (!safeName) { stream.resume(); return; }
      const id = crypto.randomUUID();
      const destDir = path.join(uploadDir, id);
      fs.mkdirSync(destDir, { recursive: true });
      const filePath = path.join(destDir, safeName);
      const ws = fs.createWriteStream(filePath);
      pendingWrites++;
      stream.pipe(ws);
      ws.on('finish', () => {
        let size = 0;
        try { size = fs.statSync(filePath).size; } catch { /* ignore */ }
        results.push({ id, name: safeName, size });
        pendingWrites--;
        tryFinish();
      });
      stream.on('limit', () => {
        abortedBySize = true;
        stream.destroy();
        ws.end();  // 触发 ws.on('finish') → pendingWrites--，这里不再重复递减
        try { fs.rmSync(destDir, { recursive: true, force: true }); } catch { /* ignore */ }
      });
    });

    bb.on('finish', () => {
      bbFinished = true;
      tryFinish();
    });

    bb.on('error', () => {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: false, error: 'Upload failed' }));
    });

    req.pipe(bb);
  }

  // ── 文件下载（从本地文件系统）──

  private handleDownload(_req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    const filePath = url.searchParams.get('path');
    if (!filePath) {
      res.writeHead(400); res.end('Missing path');
      return;
    }

    // 安全：禁止目录遍历
    if (filePath.includes('..')) {
      res.writeHead(403); res.end('Forbidden');
      return;
    }
    const resolved = path.resolve(filePath);
    const cwd = process.cwd() + path.sep;
    if (resolved !== process.cwd() && !resolved.startsWith(cwd)) {
      res.writeHead(403); res.end('Forbidden');
      return;
    }
    // 安全：禁止隐藏文件
    const base = path.basename(resolved);
    if (base.startsWith('.')) {
      res.writeHead(403); res.end('Forbidden');
      return;
    }
    // 安全：禁止敏感路径
    const normalized = resolved.replace(/\\/g, '/');
    if (normalized.includes('/.git/') || normalized.includes('/node_modules/') || normalized.includes('/.nano-code')) {
      res.writeHead(403); res.end('Forbidden');
      return;
    }

    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) {
        res.writeHead(404); res.end('Not Found');
        return;
      }
      const ext = path.extname(base);
      const mimeTypes: Record<string, string> = {
        '.js': 'application/javascript', '.ts': 'application/typescript',
        '.json': 'application/json', '.html': 'text/html',
        '.css': 'text/css', '.md': 'text/markdown',
        '.py': 'text/x-python', '.go': 'text/x-go',
        '.rs': 'text/x-rust', '.yaml': 'text/yaml',
        '.yml': 'text/yaml', '.xml': 'application/xml',
        '.sh': 'text/x-shellscript', '.txt': 'text/plain',
      };
      res.writeHead(200, {
        'Content-Type': mimeTypes[ext] || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${base.replace(/"/g, '\\"')}"`,
        'Content-Length': stat.size,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(resolved).pipe(res);
    } catch {
      res.writeHead(404); res.end('Not Found');
    }
  }

  // ── 带附件的用户输入 ──

  private handleInputWithFiles(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const text = typeof parsed?.text === 'string' ? parsed.text : '';
        const fileIds: string[] = Array.isArray(parsed?.fileIds) ? parsed.fileIds : [];

        let enriched = text;
        if (fileIds.length > 0) {
          const uploadDir = path.join(this.fileDir, 'uploads');
          let extra = '\n\n---\n';
          for (const id of fileIds) {
            // 安全：验证 UUID 格式，防止路径遍历
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) continue;
            const dir = path.join(uploadDir, id);
            try {
              const files = fs.readdirSync(dir);
              for (const f of files) {
                const filePath = path.join(dir, f);
                // 限制单个附件 1MB
                let stat;
                try { stat = fs.statSync(filePath); } catch { continue; }
                if (stat.size > 1024 * 1024) {
                  extra += `**附件: ${f}** (file too large: ${stat.size}B, skipped)\n\n`;
                  continue;
                }
                const content = fs.readFileSync(filePath, 'utf-8');
                const ext = path.extname(f).slice(1);
                extra += `**附件: ${f}**\n\`\`\`${ext}\n${content}\n\`\`\`\n\n`;
              }
            } catch { /* 跳过已删除的文件 */ }
          }
          enriched = text + extra;
        }

        if (enriched.trim() && this.inputCb) this.inputCb(enriched);
      } catch {
        if (body.trim() && this.inputCb) this.inputCb(body.trim());
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true }));
    });
  }

  private resolvePublicFile(pathname: string): string | null {
    const fileName = pathname.replace(/^\//, '');
    if (!fileName) return null;
    const scriptDir = new URL('.', import.meta.url).pathname;
    const candidates = [
      path.join(scriptDir, fileName),
      path.join(scriptDir, '..', 'public', fileName),
      path.join(scriptDir, '..', '..', 'public', fileName),
    ];
    for (const p of candidates) {
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch { /* try next */ }
    }
    return null;
  }

  private serveStaticFile(res: http.ServerResponse, pathname: string, filePath: string): void {
    const ext = path.extname(pathname);
    const mime: Record<string, string> = {
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.html': 'text/html; charset=utf-8',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.woff2': 'font/woff2',
      '.json': 'application/json',
    };
    res.writeHead(200, {
      'Content-Type': mime[ext] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
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
