import * as path from 'node:path';
import { NanoCodeWebServer } from './server.js';
import { getToolDisplayName, getToolArgsPreview, type ToolDef } from './tool-display.js';

// ── ThinkFilter: 按 showThink 配置过滤 <think>...</think> 块（可跨 chunk）──

export class ThinkFilter {
  inThink = false;
  private pending = '';

  filter(text: string, showThink: boolean): string {
    if (showThink) return text;
    // 将上一 chunk 未完成的标签前缀拼接回来
    text = this.pending + text;
    this.pending = '';
    let result = '';
    let remaining = text;

    while (remaining) {
      if (this.inThink) {
        const end = remaining.indexOf('</think>');
        if (end === -1) {
          // 全部是 think 内容，只保留尾部可能的 </think> 前缀
          this.pending = partialTagPrefix(remaining, '</think>');
          return result;
        }
        remaining = remaining.slice(end + 8);
        this.inThink = false;
      } else {
        const start = remaining.indexOf('<think>');
        if (start === -1) {
          // 没有 think 标签，检查尾部是否可能是 <think> 或 </think> 前缀
          const thinkPending = partialTagPrefix(remaining, '<think>');
          const closeThinkPending = partialTagPrefix(remaining, '</think>');
          this.pending = thinkPending || closeThinkPending;
          return result + remaining.slice(0, remaining.length - this.pending.length).replace(/<\/think>/g, '');
        }
        result += remaining.slice(0, start);
        remaining = remaining.slice(start + 7);
        this.inThink = true;
      }
    }
    result = result.replace(/<\/think>/g, '');
    return result;
  }

  reset() {
    this.inThink = false;
    this.pending = '';
  }
}

// ── ToolCallBroadcaster: 工具调用事件广播（带双向路径去重）──

export class ToolCallBroadcaster {
  private bcIds = new Set<string>();
  private historyCb: ((type: string, data: Record<string, unknown>) => void) | null = null;

  setHistoryCallback(cb: (type: string, data: Record<string, unknown>) => void) {
    this.historyCb = cb;
  }

  /** 返回是否真正广播了（false = 重复跳过） */
  broadcastCall(server: NanoCodeWebServer, id: string, toolName: string | null, args: unknown, agentName: string, extra?: Record<string, unknown>): boolean {
    if (this.bcIds.has(id)) return false;
    this.bcIds.add(id);
    const data: Record<string, unknown> = { id, toolName, args, agentName, ...extra };
    server.broadcast('tool:call', data);
    this.historyCb?.('tool:call', data);
    return true;
  }

  /** 返回是否真正广播了（false = 没有对应的 call） */
  broadcastResult(server: NanoCodeWebServer, id: string, toolName: string | null, status: string, message: string | undefined | null, agentName: string): boolean {
    if (!this.bcIds.has(id)) return false;
    this.bcIds.delete(id);
    const data: Record<string, unknown> = { id, toolName, status, message, agentName };
    server.broadcast('tool:result', data);
    this.historyCb?.('tool:result', data);
    return true;
  }

  reset() { this.bcIds.clear(); }
}

/** 检查 text 尾部是否匹配 tag 的前缀（即可能跨 chunk 的标签起始部分），返回匹配长度 */
function partialTagPrefix(text: string, tag: string): string {
  const maxLen = Math.min(tag.length - 1, text.length);
  for (let len = maxLen; len >= 1; len--) {
    if (tag.startsWith(text.slice(-len))) return text.slice(-len);
  }
  return '';
}

// ── Store key 常量（与 nano-code store-keys.ts 对齐）──
const agentCancelledKey = (name: string) => `agent:cancelled:${name}`;
const agentAbortKey = (name: string) => `agent:abort:${name}`;
const SK_MODE = 'task-plan:mode';
const SK_PRE_MODE = 'task-plan:preMode';

// ── 敏感文件检测（禁止下载隐藏文件/系统文件）──

function isSensitiveFile(filePath: string): boolean {
  const base = path.basename(filePath);
  if (base.startsWith('.')) return true;
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.includes('/.git/')) return true;
  if (normalized.includes('/node_modules/')) return true;
  if (normalized.includes('/.nano-code')) return true;
  return false;
}

// ── 工厂函数：创建 DisplayPlugin 实例 ──

function createWebDisplay() {
  const envPort = process.env.NANO_CODE_WEB_PORT;
  const envHost = process.env.NANO_CODE_WEB_HOST;
  const port = envPort ? parseInt(envPort, 10) || undefined : undefined;
  const host = envHost || undefined;
  const server = new NanoCodeWebServer({ port, host });
  let promptResolve: ((text: string | null) => void) | null = null;
  let registry: any = null;
  let agentName = 'main';
  let schemas: ToolDef[] = [];
  let toolDefsSent = false;

  // 授权确认状态
  let confirmState: { id: string; resolve: (v: boolean) => void } | null = null;
  let confirmIdCounter = 0;

  // 问询对话框状态
  let questionDialogResolve: ((answers: Record<string, string>) => void) | null = null;

  // 工具调用 ID 追踪（串行场景下完全正确）
  let currentToolId: string | null = null;
  let currentToolName: string | null = null;

  // 写文件工具参数追踪（用于下载触发）
  const toolCallArgs = new Map<string, { filePath: string; toolName: string }>();

  let showThink = false;
  const thinkFilter = new ThinkFilter();
  const toolCallBc = new ToolCallBroadcaster();
  toolCallBc.setHistoryCallback(pushHistory);

  // 事件历史环形缓冲区（用于前端重连时回放）
  const MAX_EVENT_HISTORY = 500;
  const eventRing: { type: string; data: Record<string, unknown> }[] = new Array(MAX_EVENT_HISTORY);
  let ringHead = 0;
  let ringCount = 0;
  function pushHistory(type: string, data: Record<string, unknown>) {
    eventRing[(ringHead + ringCount) % MAX_EVENT_HISTORY] = { type, data };
    if (ringCount < MAX_EVENT_HISTORY) ringCount++;
    else ringHead = (ringHead + 1) % MAX_EVENT_HISTORY;
  }

  // 会话状态快照（用于新 SSE 客户端连入时重放）
  let lastSessionStart: any = null;
  let isReady = false;

  // 新 SSE 客户端连入时发送当前状态
  server.onConnect((client) => {
    if (lastSessionStart) {
      const msg = `event: session:start\ndata: ${JSON.stringify(lastSessionStart)}\n\n`;
      client.res.write(msg);
    }
    // 发送工具定义（含 displayName），供前端友好展示
    if (schemas.length > 0) {
      client.res.write(`event: tool:definitions\ndata: ${JSON.stringify({ definitions: schemas })}\n\n`);
    }
    // 重放历史事件，合并连续的 stream:chunk（大量小块合并为一条完整消息）
    let i = 0;
    while (i < ringCount) {
      const evt = eventRing[(ringHead + i) % MAX_EVENT_HISTORY];
      if (evt.type === 'stream:chunk') {
        let text = '';
        const agentName = evt.data.agentName;
        while (i < ringCount && eventRing[(ringHead + i) % MAX_EVENT_HISTORY].type === 'stream:chunk') {
          text += eventRing[(ringHead + i) % MAX_EVENT_HISTORY].data.text;
          i++;
        }
        client.res.write(`event: stream:chunk\ndata: ${JSON.stringify({ text, agentName })}\n\n`);
      } else {
        client.res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt.data)}\n\n`);
        i++;
      }
    }
    if (isReady) {
      client.res.write('event: session:ready\ndata: {}\n\n');
    }
    // 新客户端连入时发送当前 mode 状态（兜底，以防历史缓冲区中无 status:bar）
    const curMode = registry?.store?.get(SK_MODE) || 'normal';
    if (curMode === 'plan') {
      client.res.write(`event: status:bar\ndata: ${JSON.stringify({ segments: { mode: '● PLAN' } })}\n\n`);
    }
  });

  // ── SIGINT 处理（Ctrl+C 退出提示状态）──
  let sigintHandler: (() => void) | null = null;

  function cleanupPrompt() {
    promptResolve = null;
    isReady = false;
    if (sigintHandler) {
      process.removeListener('SIGINT', sigintHandler);
      sigintHandler = null;
    }
  }

  // ── 注册 HTTP 回调 ──

  server.onInput((text: string) => {
    if (promptResolve) {
      const r = promptResolve;
      cleanupPrompt();
      r(text);
    }
  });

  server.onCancel(() => {
    if (!registry) return;
    registry.store.set(agentCancelledKey(agentName), true);
    const abortCtrl = registry.store.get(agentAbortKey(agentName));
    if (abortCtrl && !abortCtrl.signal.aborted) abortCtrl.abort();
  });

  // ── DisplayPlugin 对象 ──

  const display: Record<string, any> = {
    name: 'nano-code-web',
    ownsOutput: true,
    rawInput: false,

    async onInit(r: any): Promise<void> {
      registry = r;

      // 获取工具定义（含 displayName），供前端友好展示
      schemas = registry.getAllSchemas?.() ?? [];
      if (schemas.length > 0 && !toolDefsSent) {
        server.broadcast('tool:definitions', { definitions: schemas });
        toolDefsSent = true;
      }

      // 注册工具调用追踪 NanoPlugin
      const toolTracker = {
        name: 'web-tool-tracker',
        description: '转发工具调用事件到 SSE（带 ID）',
        getTools: () => [],
        execute: async (_name: string, _args: any, _ctx: any) => ({
          status: 'error' as const,
          message: 'tool-tracker 不提供任何工具',
        }),

        onBeforeToolCall(toolCall: any): any {
          currentToolName = toolCall.function?.name || 'unknown';
          currentToolId = toolCall.id;

          let args: any;
          try { args = JSON.parse(toolCall.function?.arguments || '{}'); } catch { args = {}; }

          // 追踪写文件工具的文件路径，用于 onAfterToolCall 中触发下载
          if (currentToolName && toolCall.id && args.path) {
            const writeTools = ['write_file_content', 'patch_file'];
            if (writeTools.includes(currentToolName)) {
              toolCallArgs.set(toolCall.id, { filePath: args.path, toolName: currentToolName });
            }
          }

          // 将 displayName 和 argsPreview 附加到广播中
          const displayName = getToolDisplayName(currentToolName ?? 'unknown', schemas);
          const argsPreview = getToolArgsPreview(args);
          const extra = { displayName, argsPreview: argsPreview ?? undefined };
          toolCallBc.broadcastCall(server, toolCall.id || 'no-id', currentToolName, args, agentName, extra);
          return toolCall;
        },

        onAfterToolCall(result: any): any {
          if (currentToolId) {
            toolCallBc.broadcastResult(server, currentToolId, currentToolName, result.status, result.message, agentName);

            // 写文件工具成功 → 广播 file:changed 供前端下载
            if (result.status === 'success') {
              const tracked = toolCallArgs.get(currentToolId);
              if (tracked && !isSensitiveFile(tracked.filePath)) {
                server.broadcast('file:changed', {
                  filePath: tracked.filePath,
                  toolName: tracked.toolName,
                  agentName,
                  toolCallId: currentToolId,
                });
              }
              toolCallArgs.delete(currentToolId);
            } else {
              toolCallArgs.delete(currentToolId);
            }

            currentToolId = null;
            // 保留 currentToolName — DisplayPlugin.onToolResult 仍可能引用
          }
          return result;
        },
      };

      await registry.register(toolTracker);

      // 注册授权确认回调
      registry.setConfirmCallback(async (req: any) => {
        // 如有旧的 pending 确认，先拒绝
        if (confirmState) { confirmState.resolve(false); confirmState = null; }
        const id = 'cf_' + (++confirmIdCounter) + '_' + Date.now().toString(36);
        return new Promise(resolve => {
          confirmState = { id, resolve };
          const confirmData = {
            id, toolName: req.toolName, displayName: req.displayName, message: req.message,
            details: req.details, diff: req.diff, filePath: req.filePath, agentName,
          };
          server.broadcast('confirmation:request', confirmData);
          pushHistory('confirmation:request', confirmData);
        });
      });

      // 处理前端发回的确认结果
      server.onConfirm((id: string, approved: boolean) => {
        if (confirmState && confirmState.id === id) {
          const r = confirmState.resolve;
          confirmState = null;
          r(approved);
          server.broadcast('confirmation:resolved', { id });
          pushHistory('confirmation:resolved', { id });
        }
      });

      // 注册 ask_user_question 交互式 handler
      registry.registerInteractiveHandler('ask_user_question', async (args: any) => {
        const { questions } = args || {};
        return new Promise(resolve => {
          const id = 'qd_' + (++confirmIdCounter) + '_' + Date.now().toString(36);
          questionDialogResolve = (answers: Record<string, string>) => {
            resolve({ status: 'success', data: JSON.stringify({ questions, answers }) });
          };
          server.broadcast('question:dialog', { id, questions });
          pushHistory('question:dialog', { id, questions });
        });
      });

      // 处理前端发回的对话框答案
      server.onQuestionAnswer((id: string, answers: Record<string, string>) => {
        if (questionDialogResolve) {
          const r = questionDialogResolve;
          questionDialogResolve = null;
          r(answers);
          server.broadcast('question:resolved', { id });
          pushHistory('question:resolved', { id });
        }
      });

      // 注册 mode toggle 回调
      server.onModeToggle(() => {
        const currentMode = registry.store.get(SK_MODE) || 'normal';
        if (currentMode === 'plan') {
          const preMode = registry.store.get(SK_PRE_MODE) || 'normal';
          registry.store.set(SK_MODE, preMode);
          registry.store.set(SK_PRE_MODE, undefined);
        } else {
          registry.store.set(SK_PRE_MODE, currentMode);
          registry.store.set(SK_MODE, 'plan');
        }
        // 通知所有在线客户端 mode 变化
        const newMode = registry.store.get(SK_MODE) || 'normal';
        server.broadcast('status:bar', { segments: { mode: newMode === 'plan' ? '● PLAN' : '○ normal' } });
      });

      // 注册 output handler：将命令 stdout/stderr 转发为 SSE，避免直写终端
      r.setOutputHandler({
        stdout(chunk: string) {
          server.broadcast('tool:stdout', { text: chunk, agentName });
        },
        stderr(chunk: string) {
          server.broadcast('tool:stderr', { text: chunk, agentName });
        },
      });

      // 启动 HTTP/SSE 服务器
      try {
        const port = await server.start();
        process.stderr.write(`\n  nano-code-web UI: http://localhost:${port} （远程访问使用服务器 IP）\n\n`);
      } catch (err: any) {
        const portHint = err?.port ? `端口 ${err.port}` : '端口';
        if (err?.code === 'EADDRINUSE') {
          process.stderr.write(`\n  错误：${portHint} 已被占用，请关闭其他进程后重试\n\n`);
        } else {
          process.stderr.write(`\n  错误：无法启动 Web 服务器 - ${err?.message || err}\n\n`);
        }
        process.exit(1);
      }
    },

    // ── 会话生命周期 ──

    onStart(config: any): void {
      agentName = config.agentName || 'main';
      showThink = config.showThink === true;
      thinkFilter.reset();
      toolCallBc.reset();
      isReady = false;
      ringHead = 0; ringCount = 0; // 新 session / /clear 时清空历史缓冲区
      lastSessionStart = {
        greeting: config.greeting,
        agentName,
        profileName: config.profileName,
        hasTools: config.hasTools,
        showThink: config.showThink,
        debug: config.debug,
      };
      server.broadcast('session:start', lastSessionStart);
    },

    onStop(message: string): void {
      server.broadcast('session:stop', { message });
      server.stop();
    },

    prompt(): Promise<string | null> {
      cleanupPrompt();
      return new Promise(resolve => {
        promptResolve = resolve;
        isReady = true;
        server.broadcast('session:ready', {});

        // Ctrl+C → 退出
        const onSigint = () => {
          process.stderr.write('\n');
          if (promptResolve) {
            const r = promptResolve;
            cleanupPrompt();
            r(null);
          }
        };
        sigintHandler = onSigint;
        process.on('SIGINT', onSigint);

        // 30 秒无客户端连入则退出
        const timer = setTimeout(() => {
          if (!server.hasClients() && promptResolve) {
            const r = promptResolve;
            cleanupPrompt();
            r(null);
          }
        }, 30000);

        // 有客户端连入时取消超时
        const ival = setInterval(() => {
          if (server.hasClients()) {
            clearTimeout(timer);
            clearInterval(ival);
          }
        }, 500);
      });
    },

    onUserInput(_input: string, _sourcePlugin: string): void {
      currentToolId = null;
      currentToolName = null;
      server.broadcast('user:input', { text: _input, agentName });
      pushHistory('user:input', { text: _input, agentName });
    },

    // ── 显示事件（全部转发为 SSE）──

    onStatus(event: any): void {
      const data = { level: event.level, message: event.message, agentName: event.agentName };
      server.broadcast('status', data);
      pushHistory('status', data);
    },

    onStreamChunk(event: any): void {
      const text = thinkFilter.filter(event.text, showThink);
      if (text) {
        server.broadcast('stream:chunk', { text, agentName: event.agentName });
        pushHistory('stream:chunk', { text, agentName: event.agentName });
      }
    },

    onToolCall(event: any): void {
      const id = event.id || event.toolCallId;
      if (!id) return;
      currentToolId = id;
      currentToolName = event.toolName || event.name || event.function?.name || 'unknown';
      const args = event.args || event.input || {};
      const displayName = getToolDisplayName(currentToolName ?? 'unknown', schemas);
      const argsPreview = getToolArgsPreview(args);
      toolCallBc.broadcastCall(server, id, currentToolName, args, agentName, { displayName, argsPreview: argsPreview ?? undefined });
    },

    onToolResult(event: any): void {
      const id = event.id || event.toolCallId;
      if (!id) return;
      // ToolResultEvent 已无 toolName 字段，使用 currentToolName（由 onToolCall/NanoPlugin 设置）
      toolCallBc.broadcastResult(server, id, currentToolName, event.status, event.message || event.error, agentName);
    },

    onError(event: any): void {
      const data = { message: event.message, stack: event.stack, agentName: event.agentName };
      server.broadcast('error', data);
      pushHistory('error', data);
    },

    onDebug(event: any): void {
      server.broadcast('debug', {
        data: event.data,
        agentName: event.agentName,
      });
    },

    onBackgroundTask(event: any): void {
      server.broadcast('background:task', {
        taskId: event.taskId,
        taskStatus: event.taskStatus,
        message: event.message,
        agentName: event.agentName,
      });
    },

    onNotify(notification: { source: string; message: string } | null): void {
      if (notification) {
        server.broadcast('notify', {
          source: notification.source,
          message: notification.message,
        });
      } else {
        server.broadcast('notify:clear', {});
      }
    },

    onAgentTurnStart(event: any): void {
      const data = { agentName: event.agentName };
      server.broadcast('agent:turn_start', data);
      pushHistory('agent:turn_start', data);
    },

    onAgentTurnEnd(event: any): void {
      const data = { agentName: event.agentName };
      server.broadcast('agent:turn_end', data);
      pushHistory('agent:turn_end', data);
    },

    onStateSnapshot(snapshot: any): void {
      server.broadcast('state:snapshot', {
        agentName: snapshot.agentName,
        messageCount: snapshot.messageCount,
      });
    },

    onContextAnalysis(analysis: any): void {
      server.broadcast('context:analysis', {
        modelName: analysis.modelName,
        contextWindow: analysis.contextWindow,
        totalTokens: analysis.totalTokens,
        usageSource: analysis.usageSource,
        percentage: analysis.percentage,
        dimensions: analysis.dimensions,
        freeTokens: analysis.freeTokens,
      });
    },

    setStatusBar(segments: Record<string, string>): void {
      server.broadcast('status:bar', { segments });
    },
  };

  return display;
}

const plugin = createWebDisplay();
export default plugin;
