import { NanoCodeWebServer } from './server.js';

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

  /** 返回是否真正广播了（false = 重复跳过） */
  broadcastCall(server: NanoCodeWebServer, id: string, toolName: string | null, args: unknown, agentName: string): boolean {
    if (this.bcIds.has(id)) return false;
    this.bcIds.add(id);
    server.broadcast('tool:call', { id, toolName, args, agentName });
    return true;
  }

  /** 返回是否真正广播了（false = 没有对应的 call） */
  broadcastResult(server: NanoCodeWebServer, id: string, toolName: string | null, status: string, message: string | undefined | null, agentName: string): boolean {
    if (!this.bcIds.has(id)) return false;
    this.bcIds.delete(id);
    server.broadcast('tool:result', { id, toolName, status, message, agentName });
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

// ── Store key 常量（与 nano-code 的 SK 对齐） ──
const SK = {
  AgentCancelled: 'agent:cancelled',
  AgentAbort: 'agent:abort',
} as const;

// ── 工厂函数：创建 DisplayPlugin 实例 ──

function createWebDisplay() {
  const server = new NanoCodeWebServer();
  let promptResolve: ((text: string | null) => void) | null = null;
  let registry: any = null;
  let agentName = 'main';

  // 授权确认状态
  let confirmState: { id: string; resolve: (v: boolean) => void } | null = null;
  let confirmIdCounter = 0;

  // 工具调用 ID 追踪（串行场景下完全正确）
  let currentToolId: string | null = null;
  let currentToolName: string | null = null;
  let showThink = false;
  const thinkFilter = new ThinkFilter();
  const toolCallBc = new ToolCallBroadcaster();

  // 会话状态快照（用于新 SSE 客户端连入时重放）
  let lastSessionStart: any = null;
  let isReady = false;

  // 新 SSE 客户端连入时发送当前状态
  server.onConnect((client) => {
    if (lastSessionStart) {
      const msg = `event: session:start\ndata: ${JSON.stringify(lastSessionStart)}\n\n`;
      client.res.write(msg);
    }
    if (isReady) {
      client.res.write('event: session:ready\ndata: {}\n\n');
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
    registry.store.set(SK.AgentCancelled, true);
    const abortCtrl = registry.store.get(SK.AgentAbort);
    if (abortCtrl && !abortCtrl.signal.aborted) abortCtrl.abort();
  });

  // ── DisplayPlugin 对象 ──

  const display: Record<string, any> = {
    name: 'nano-code-web',
    ownsOutput: true,
    rawInput: false,

    async onInit(r: any): Promise<void> {
      registry = r;

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

          toolCallBc.broadcastCall(server, toolCall.id || 'no-id', currentToolName, args, agentName);
          return toolCall;
        },

        onAfterToolCall(result: any): any {
          if (currentToolId) {
            toolCallBc.broadcastResult(server, currentToolId, currentToolName, result.status, result.message, agentName);
            currentToolId = null;
            currentToolName = null;
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
          server.broadcast('confirmation:request', {
            id, toolName: req.toolName, message: req.message,
            details: req.details, agentName,
          });
        });
      });

      // 处理前端发回的确认结果
      server.onConfirm((id: string, approved: boolean) => {
        if (confirmState && confirmState.id === id) {
          const r = confirmState.resolve;
          confirmState = null;
          r(approved);
        }
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
      // 新用户输入时清空追踪状态
      currentToolId = null;
      currentToolName = null;
      // 不广播 user:input — 前端已在 sendInput() 中乐观渲染
    },

    // ── 显示事件（全部转发为 SSE）──

    onStatus(event: any): void {
      server.broadcast('status', {
        level: event.level,
        message: event.message,
        agentName: event.agentName,
      });
    },

    onStreamChunk(event: any): void {
      const text = thinkFilter.filter(event.text, showThink);
      if (text) {
        server.broadcast('stream:chunk', { text, agentName: event.agentName });
      }
    },

    onToolCall(event: any): void {
      const id = event.id || event.toolCallId;
      if (!id) return;
      currentToolId = id;
      currentToolName = event.toolName || event.name || event.function?.name || 'unknown';
      toolCallBc.broadcastCall(server, id, currentToolName, event.args || event.input || {}, agentName);
    },

    onToolResult(event: any): void {
      const id = event.id || event.toolCallId;
      if (!id) return;
      toolCallBc.broadcastResult(server, id, event.toolName || event.name, event.status, event.message || event.error, agentName);
      // 不重置 currentToolId/currentToolName — NanoPlugin 的 onAfterToolCall 可能依赖它们
    },

    onError(event: any): void {
      server.broadcast('error', {
        message: event.message,
        stack: event.stack,
        agentName: event.agentName,
      });
    },

    onDebug(event: any): void {
      server.broadcast('debug', {
        data: event.data,
        agentName: event.agentName,
      });
    },

    onAgentTurnStart(event: any): void {
      server.broadcast('agent:turn_start', { agentName: event.agentName });
    },

    onAgentTurnEnd(event: any): void {
      server.broadcast('agent:turn_end', { agentName: event.agentName });
    },

    onStateSnapshot(snapshot: any): void {
      server.broadcast('state:snapshot', {
        agentName: snapshot.agentName,
        messageCount: snapshot.messageCount,
      });
    },
  };

  return display;
}

const plugin = createWebDisplay();
export default plugin;
