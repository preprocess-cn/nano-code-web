# nano-code Web 模式架构设计

> 基于 nano-code 现有 DisplayPlugin + NanoPlugin 体系，实现前后端分离。
> 后端作为 nano-code 的一个显示插件/插件集，前端（nano-code-web）完全解耦。

---

## 1. 架构概览

```
┌──────────────────────────────────────────────────────┐
│                    nano-code 后端                       │
│                                                       │
│  ┌─────────────────────────────────────────────┐      │
│  │         PluginRegistry + Agent Loop          │      │
│  │  (fs, command, memory, mcp, skills ...)      │      │
│  └──────────┬──────────────────────┬────────────┘      │
│             │ DisplayPlugin 事件   │ input              │
│             ▼                      ▼                    │
│  ┌──────────────────┐  ┌──────────────────────┐        │
│  │  StreamManager   │  │   WebSocketServer     │        │
│  │  (DisplayPlugin) │  │   (NanoPlugin)        │        │
│  │  · 事件→JSON     │  │   · 连接管理          │        │
│  │  · ThinkStream   │  │   · 消息路由          │        │
│  │  · 大内容→URL    │  │   · 心跳/ping         │        │
│  └────────┬─────────┘  └──────────┬───────────┘        │
│           │                       │                     │
│           └──────┬────────────────┘                     │
│                  ▼                                      │
│  ┌──────────────────────────────┐                       │
│  │    共享 HTTP 服务器            │                       │
│  │  WS Upgrade + REST 端点       │                       │
│  │  /web-files/:uuid  /health    │                       │
│  └──────────────┬───────────────┘                       │
└─────────────────┼──────────────────────────────────────┘
                  │ WebSocket (JSON 帧) + HTTP (大文件)
                  ▼
┌─────────────────────────────────────┐
│           nano-code-web 前端          │
│  · WebSocket 客户端                  │
│  · 流式渲染 + Markdown               │
│  · 文件 URL 懒加载                   │
│  · 斜杠命令/!bang 输入               │
│  · Think/调试面板                    │
└─────────────────────────────────────┘
```

### 核心设计原则

- **后端是 nano-code 的一个显示插件** — 利用现有 `DisplayPlugin` 接口，所有 LLM/工具事件自动到达
- **单端口复用** — WebSocket 和 HTTP 文件服务共享同一个 `http.Server`，避免跨端口/CORS 问题
- **前端完全解耦** — 只通过 WebSocket 协议通信，无需任何 nano-core 内部依赖
- **ThinkStream 前置到后端** — `showThink=false` 时，后端过滤掉 `<think>` 内容再发送，节省带宽

---

## 2. 后端插件分解

整个 Web 后端拆分为 **3 个核心插件**，负责不同关注点：

### 2.1 WebSocketServer 插件 (NanoPlugin)

```
文件：src/plugins/web/ws-server.ts
注册：registry.register(webSocketServerPlugin)
依赖：npm ws
```

**职责：**
- 生命周期：`onInit()` 创建共享 HTTP 服务器 + WebSocket 服务，`onDestroy()` 关闭连接
- 连接管理：跟踪连接客户端，心跳（每 30s ping/pong），断线检测
- 消息路由：接收 WebSocket 客户端的 JSON 消息，分发到对应处理器
- 输入桥接：`input` 消息 → 解决 StreamManager 的 `prompt()` Promise；`cancel` 消息 → 设置 `SK.AgentCancelled`
- 广播方法：`broadcast(msg)` 发送到所有连接的客户端

**Store 键：**
- `web:ws-server` — WebSocketServer 实例
- `web:http-server` — 共享 HTTP 服务器实例
- `web:connected` — 当前是否有客户端连接 (boolean)
- `web:port` — 监听端口 (number)

**本插件不提供工具。** 它不拦截 `onBeforeAgentInput` — 输入路由由 StreamManager 驱动。

### 2.2 StreamManager DisplayPlugin (DisplayPlugin)

```
文件：src/plugins/web/stream-display.ts
注册：displayMgr.addPlugin(webStreamDisplay)
```

**职责：** 将 nano-code 的所有显示事件转换为结构化 JSON 消息，通过 WebSocket 发送。

| DisplayPlugin 钩子 | 生成的 WebSocket 事件 |
|---|---|
| `onStart(config)` | `session:start { greeting, agentName, profileName, hasTools, showThink, debug }` |
| `onStop(message)` | `session:stop { message }` |
| `prompt()` | 返回一个 Promise，等待 WebSocket `input` 消息解决。发送 `session:ready` |
| `onUserInput(input, src)` | 可选转发（用于多客户端场景） |
| `onStatus({message,level,agentName})` | `status { level, message, agentName }` |
| `onStreamChunk({text,agentName})` | `stream:chunk { text/segments, agentName, index }` |
| `onToolCall({toolName,args,agentName})` | `tool:call { toolName, argsPreview, agentName, id }` |
| `onToolResult({toolName,status,message,agentName})` | `tool:result { toolName, status, message, agentName, id }` |
| `onError({message,stack,agentName})` | `error { message, stack, agentName }` |
| `onDebug({data,agentName})` | `debug { data, agentName }`（仅 debug=true 时发送） |
| `onBackgroundTask({...})` | `background:task { ... }` |
| `onAgentTurnStart({agentName})` | `agent:turn_start { agentName }` |
| `onAgentTurnEnd({agentName})` | `agent:turn_end { agentName }` |
| `onStateSnapshot({...})` | `state:snapshot { ... }` |
| `onContextAnalysis(analysis)` | `context:analysis { ... }` |

**ThikStream 处理策略：**
- `showThink=false`（默认）：后端实时过滤 `<think>...</think>`，只发送可见文本
- `showThink=true`：发送带区段的结构化块：`segments: [{text, type:"think"|"visible"}]`，同时保留 `text` 全文作为回退

**大内容文件 URL 切换：**
- 累积流缓冲区超过 `WEB_FILE_THRESHOLD`（默认 32KB）时：
  1. 调用 FileServer 的 `writeContent()` 写入临时文件
  2. 发送带 `fileUrl` 字段的 `stream:chunk`
  3. 发送 `file:url` 事件通知前端

### 2.3 FileServer 插件 (NanoPlugin)

```
文件：src/plugins/web/file-server.ts
注册：registry.register(fileServerPlugin)
```

**职责：**
- 在共享 HTTP 服务器上注册路由：`GET /web-files/:uuid`、`GET /health`
- 提供临时文件服务，支持 CORS 头
- 文件 TTL 管理：默认 10 分钟自动清理
- 大工具结果的文件写入工具（供 StreamManager 和 `onAfterToolCall` 钩子调用）

**Store 键：**
- `web:file-dir` — 临时文件目录路径
- `web:file-ttl-ms` — 文件 TTL 毫秒数

**文件写入接口：**
```typescript
// 由 StreamManager 或其他插件调用
async writeContent(content: string, ext = '.txt'): Promise<{
  uuid: string; path: string; url: string
}>
```

---

## 3. WebSocket 协议设计

### 3.1 连接信息

- 协议：`ws://hostname:{port}/`
- 帧格式：UTF-8 文本帧，每条消息一个 JSON 对象
- 心跳：客户端每 30s 发送 `{"type":"ping"}`，服务器回复 `{"type":"pong"}`
- 重连：服务器在每次连接时发送 `session:start`，前端以此检测是首次连接还是重连

### 3.2 服务器 → 客户端消息

#### 会话生命周期

```json
{"type":"session:start","greeting":"我可以帮您查看项目结构...","agentName":"main",
 "profileName":"treehole","hasTools":true,"showThink":false,"debug":false,
 "serverVersion":"0.1.0","sessionId":"uuid-xxx"}
```
```json
{"type":"session:stop","message":"感谢使用 nano-code，祝您编码愉快！"}
```
```json
{"type":"session:ready","sessionId":"uuid-xxx"}
```

#### 流事件

**`showThink=false` 模式：**
```json
{"type":"stream:chunk","text":"可见文本（think 已过滤）","agentName":"main","index":42}
```
**`showThink=true` 模式：**
```json
{"type":"stream:chunk","segments":[{"text":"思考内容","type":"think"},{"text":"可见文本","type":"visible"}],
 "text":"思考内容可见文本（全文回退）","agentName":"main","index":42}
```
**大内容时带文件 URL：**
```json
{"type":"stream:chunk","text":"前 1000 字符预览...","fileUrl":"/web-files/uuid.txt",
 "agentName":"main","index":42}
```
**流刷新（工具调用边界/思考结束）：**
```json
{"type":"stream:flush","agentName":"main","final":false}
```

#### 工具生命周期

```json
{"type":"tool:call","toolName":"read_file","args":{"file_path":"/path/to/file"},
 "argsPreview":"read_file(path=/path/to/file)","agentName":"main",
 "id":"call_xxx","isReadOnly":true}
```
```json
{"type":"tool:result","toolName":"read_file","status":"success",
 "message":"文件内容已读取","durationMs":15,"agentName":"main","id":"call_xxx"}
```

#### 状态/错误/调试

```json
{"type":"status","level":"thinking","message":"正在思考并请求大模型...","agentName":"main","timestamp":"2026-07-03T..."}
{"type":"error","message":"连接超时","stack":"...","agentName":"main"}
{"type":"debug","data":"raw llm packet: ...","agentName":"main","timestamp":"..."}
{"type":"file:url","url":"/web-files/uuid.txt","mimeType":"text/plain; charset=utf-8","size":65536,"agentName":"main","label":"工具结果：read_file"}
```

#### Agent/状态/上下文

```json
{"type":"agent:turn_start","agentName":"child","mode":"normal"}
{"type":"state:snapshot","agentName":"main","messageCount":12,"tokenUsage":{"prompt":1500,"completion":800,"total":2300}}
{"type":"context:analysis","totalTokens":3500,"dimensions":[{"label":"对话","tokens":2000,"ratio":0.57},...]}
{"type":"background:task","taskId":"bg_1","action":"started","message":"运行代码检查","status":"running"}
```

### 3.3 客户端 → 服务器消息

```json
{"type":"input","text":"帮我看看这个项目","id":"msg_001"}
{"type":"cancel","reason":"user_cancelled"}
{"type":"ping","timestamp":"2026-07-03T..."}
```

用户输入的 `/` 和 `!` 命令全部通过 `input` 发送，后端通过 `onBeforeAgentInput` 链处理。前端不需要区分。

---

## 4. 前端接口规范 (nano-code-web)

### 4.1 连接管理

```typescript
interface WebDisplayConfig {
  wsUrl: string;            // "ws://localhost:3030"
  httpBaseUrl: string;      // "http://localhost:3030"
  reconnectDelayMs: number; // 指数退避起始值，默认 1000
}

// 连接生命周期：
// 1. 从 URL 参数 ?port=3030 或默认值确定 URL
// 2. 打开 WebSocket → onopen 设置 30s ping 定时器
// 3. onmessage → JSON 解析 → 按 type 分发事件处理
// 4. onclose → 指数退避重连 (1s, 2s, 4s, 8s, 16s, max 30s)
// 5. 重连时收到 session:start → 清除前一个会话状态
```

### 4.2 事件处理接口

前端需要实现以下事件处理，以提供 REPL 级体验：

| 事件 | 渲染行为 |
|---|---|
| `session:start` | 显示问候语，重置对话列表，显示配置状态（debug/think） |
| `session:stop` | 显示结束语，关闭连接 |
| `session:ready` | 启用输入框，提示用户可以输入 |
| `stream:chunk` | 追加到当前 AI 消息气泡。含 `segments` 时分别渲染 think（灰色/可折叠）/ visible 内容。含 `fileUrl` 时显示"加载完整内容"按钮 |
| `stream:flush` | 标记当前 AI 消息完成，准备下一次输入 |
| `tool:call` | 显示工具调用卡片（名称、参数预览、只读/写入标志） |
| `tool:result` | 更新工具卡片状态（成功/失败/被拒） |
| `status:thinking` | 显示"正在思考"动画指示器 |
| `status:info/warn/error/success` | 显示对应级别的通知信息 |
| `error` | 红色错误提示 |
| `debug` | 调试面板追加日志（仅在调试模式下） |
| `file:url` | 注册 URL 映射，用于懒加载 |
| `agent:turn_start/end` | 显示 agent 切换指示器 |
| `state:snapshot` | （可选）显示 token 用量 |
| `context:analysis` | （可选）显示上下文可视化 |
| `background:task` | （可选）在侧边栏显示任务进度 |

### 4.3 客户端发送方法

```typescript
interface NanoCodeWebClient {
  sendInput(text: string): void;   // 发送用户输入（含 / 和 ! 命令）
  sendCancel(): void;              // 取消当前 LLM 请求
  sendPing(): void;                // 发送心跳
  close(): void;                   // 关闭连接
}
```

### 4.4 输入处理

- 普通文本 → 发送 `type:"input"` → 后端进入 agent 循环
- `/exit`, `/clear`, `/help`, `/model` 等 → 仍然发 `type:"input"` → 后端 `onBeforeAgentInput` 处理
- `!ls`, `!git status` 等 → 仍然发 `type:"input"` → 后端 bang 插件处理

**前端不需要解析或预处理任何命令。**

### 4.5 大内容懒加载

当收到带 `fileUrl` 的 `stream:chunk` 或单独的 `file:url` 事件：
1. 显示内容预览（前 1000 字符或摘要）
2. 提供"查看完整内容"按钮
3. 用户点击时 `fetch(httpBaseUrl + fileUrl)` 获取并渲染
4. 渲染方式：代码块 + 语法高亮（检测 MIME 类型）

---

## 5. 启动流程

### 5.1 CLI 入口

```
nano-code --web [--port 3030] [--think] [--debug] [--continue] [--profile <name>]
```

- `--web`：启用 Web 模式，替代终端 REPL
- `--port`：指定监听端口（默认 3030）

### 5.2 启动时序

```
1. CLI 解析 (src/index.ts)
   ├── 检测 --web 标志
   └── 覆盖 display 插件为 web-stream-display

2. 配置加载 (loadConfig)
   └── 正常加载所有配置

3. 创建 PluginRegistry + DisplayManager
   ├── registry = new PluginRegistry()
   ├── displayMgr = new DisplayManager()
   └── displayMgr.addPlugin(webStreamDisplay)  // 替代 REPL

4. 创建 LLMClient (正常)

5. 初始化所有插件
   ├── 工具插件: fs, command, memory, mcp, skills...
   ├── 功能插件: commands, agent-slash, skills-slash, bang, task-plan...
   └── Web 插件: ws-server, file-server (在 initializePlugins 中注册)

6. DisplayManager.init(registry)
   ├── webStreamDisplay.onInit → 获取 WebSocketServer 引用
   └── WebSocketServer.onInit → 启动 HTTP+WS 服务，等待连接

7. displayMgr.start(config) → session:start (缓存，等待连接)

8. 进入主循环 runMainLoop()
   ├── displayMgr.prompt() → 返回 Promise，等待 WebSocket input
   ├── 用户通过前端发送 input → prompt() Promise 解决
   ├── execBeforeAgentInput(input) → 命令/!bang 处理
   ├── agent.runTask(userPrompt) → LLM 流 + 工具执行
   │   └── 事件通过 StreamManager → WebSocket → 前端
   ├── saveSession()
   └── 重复
```

### 5.3 prompt() 暂停机制

Web 模式下 `prompt()` 的实现与 REPL 完全不同：

```typescript
// stream-display.ts
async prompt(): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    this._promptResolve = resolve;
    this.broadcast({ type: 'session:ready', sessionId: this._sessionId });
    // 超时检查：如果连接断开，返回 null 触发退出
    setTimeout(() => {
      if (!this._wsConnected) {
        resolve(null);
      }
    }, 30000);
  });
}

// ws-server.ts - 收到 input 消息时
function handleInput(text: string): void {
  streamDisplay.resolvePrompt(text);
}
```

---

## 6. 文件 URL 机制详解

### 6.1 触发条件

以下场景会触发文件 URL：

| 场景 | 阈值 | 动作 |
|---|---|---|
| `stream:chunk` 累积超过 32KB | 累计缓冲区大小 | 写入文件，后续块替换为 `fileUrl` |
| 工具结果超大（如 `read_file` 读取大文件） | 结果 `data` 字段超过 32KB | 在 `onAfterToolCall` 中替换为 URL |
| 工具 stderr/stdout 输出过多 | 输出行数 > 200 或字节 > 16KB | 同上 |

### 6.2 文件生命周期

```
1. writeContent(content) 被调用
2. 生成 uuid → 写入 .nano-code/web-files/{uuid}.txt
3. 写入 .nano-code/web-files/{uuid}.meta.json (含创建时间、原始类型、TTL)
4. 设置 setTimeout 清理 (10 分钟后 unlink)
5. 返回 { uuid, path, url: "/web-files/{uuid}.txt" }
6. 进程退出时：WebServer.onDestroy 清理整个 web-files/ 目录
```

### 6.3 URL 组装

前端通过 `httpBaseUrl + fileUrl` 获取完整文件 URL。`httpBaseUrl` 可以在连接时协商，或通过约定：

```
httpBaseUrl = wsUrl.replace(/^ws/, 'http')
// "ws://localhost:3030" → "http://localhost:3030"
```

---

## 7. 插件组件边界汇总

| 组件 | 类型 | 注册方式 | 提供工具 | Store 读写 |
|---|---|---|---|---|
| WebSocketServer | NanoPlugin | `registry.register()` | 无 | 写: `web:ws-server`, `web:http-server`, `web:port`, `web:connected` |
| StreamManager | DisplayPlugin | `displayMgr.addPlugin()` | 无 | 读: `web:ws-server`。写: 流缓冲区可存 store |
| FileServer | NanoPlugin | `registry.register()` | 无 | 读: `web:http-server`。写: `web:file-dir` |

### 组件间通信

```
WebSocketServer  --广播()-->  所有WebSocket客户端
       ↑
       | 调用 broadcast()
       |
StreamManager -- 引用注入 --> WebSocketServer 实例 (通过 store 或构造函数)
       ↑
       | 注册为 DisplayPlugin
       |
DisplayManager -- 转发 --> nano-code 所有显示事件
```

直接方法调用优于 store 传递流数据（避免大对象序列化/反序列化）。StreamManager 和 WebSocketServer 之间通过引用直接调用。

---

## 8. 安全考虑

1. **内容转义**：LLM 输出可能包含 HTML/JS。前端必须在渲染前对所有文本内容做转义
2. **文件隔离**：`/web-files` 路径必须限制在 `.nano-code/web-files/` 目录下，防止目录遍历攻击
3. **命令安全**：!bang 命令的安全检查复用现有 `bang.ts` 的黑名单机制
4. **CORS**：HTTP 文件端点设置 `Access-Control-Allow-Origin: *`，但 WebSocket 不受 CORS 限制
5. **端口安全**：只在 `127.0.0.1` 监听（默认），防止局域网访问

---

## 9. 文件布局

```
nano-code/  (现有仓库)
├── src/
│   └── plugins/
│       └── web/                  # [新增] Web 模式插件集
│           ├── index.ts           # 统一导出 + createWebPlugins()
│           ├── ws-server.ts       # WebSocketServer NanoPlugin
│           ├── stream-display.ts  # StreamManager DisplayPlugin
│           ├── file-server.ts     # FileServer NanoPlugin
│           └── protocol.ts        # 共享类型定义 (双方接口契约)
└── docs/
    └── web-mode-architecture.md   # 本文档

nano-code-web/  (新仓库)
├── src/
│   ├── ws-client.ts              # WebSocket 客户端 + 协议处理
│   ├── types.ts                  # 与协议同步的类型定义
│   ├── NanoCodeWebClient.ts      # 客户端接口实现
│   ├── components/               # UI 组件
│   │   ├── ChatView.tsx          # 对话视图
│   │   ├── MessageBubble.tsx     # 消息气泡
│   │   ├── ToolCallCard.tsx      # 工具调用卡片
│   │   ├── InputBox.tsx          # 输入框
│   │   └── ThinkingIndicator.tsx # 思考指示器
│   └── hooks/
│       └── useWebSocket.ts       # WebSocket 连接 Hook
└── public/
    └── index.html
```

---

## 10. 实现顺序建议

如果后续开发，建议按以下顺序：

1. **协议定义** — 先在 `protocol.ts` 中定义完整的 TypeScript 类型
2. **FileServer** — 最简单的插件，先验证 HTTP 共享服务器机制
3. **WebSocketServer** — 纯 NanoPlugin，管理连接，不涉及显示逻辑
4. **StreamManager** — 核心插件，桥接 DisplayPlugin → WebSocket
5. **CLI 集成** — `--web` 标志解析、启动流程修改
6. **nano-code-web 前端** — 完全独立开发，基于协议文档
7. **集成测试** — 全链路验证
8. **大内容文件 URL** — 阈值检测 + 文件写入 + 懒加载
9. **重连恢复** — 断线重连 + 状态恢复
