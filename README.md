# nano-code-web

nano-code 的 Web 显示插件。通过 SSE（Server-Sent Events）将 nano-code 的 DisplayPlugin 事件推送到浏览器前端，提供图形化交互界面。

## Architecture

```
nano-code 核心 → DisplayPlugin 事件 → display.ts → SSE → public/index.html
```

三层结构：

1. **`src/server.ts`** — `NanoCodeWebServer`: HTTP + SSE 服务器
   - `GET /events` — SSE 端点，推送实时事件
   - `POST /input` — 接收用户输入
   - `POST /cancel` — 取消当前请求
   - `POST /confirm` — 处理前端授权确认（Allow/Deny）
   - `POST /question-answer` — 处理前端问询对话框答案提交
   - `POST /mode-toggle` — 切换 plan/normal 模式（Shift+Tab）
   - `GET /health` — 健康检查
   - `GET /web-files/*` — 临时文件服务
   - `GET /` — 前端页面

2. **`src/display.ts`** — DisplayPlugin 实现
   - 将 nano-code 的 `onStart/onStreamChunk/onToolCall/onStatus` 等事件广播为 SSE
   - 通过 NanoPlugin `onBeforeToolCall/onAfterToolCall` 追踪工具调用 ID
   - `ThinkFilter` — 按 `showThink` 配置过滤 `<think>...</think>` 内容（支持跨 chunk 分割、处理残留 `</think>`）
   - `ToolCallBroadcaster` — 工具调用事件去重广播（NanoPlugin + DisplayPlugin 双向路径）
   - `注册 ask_user_question 交互式 handler` — 将 LLM 提问转发为前端对话框 SSE 事件，Promise 等待回答
   - `onBackgroundTask` — 后台任务状态广播（started/completed/error）
   - `onModeToggle` — store 级别 plan/normal 模式切换（Shift+Tab/点击/命令）

3. **`public/index.html`** — 单页前端
   - `EventSource` 接收 SSE，渲染消息气泡、工具调用卡片、thinking 动画、授权确认卡片
   - Markdown 渲染（`markdown-it` + `highlight.js` 语法高亮 + `DOMPurify` 安全消毒）
   - 流式输出优化：debounce（150ms）+ 代码块闭合检测（``` 成对时立即渲染）
   - 工具卡片点击展开/收拢（参数 + 返回结果）
   - 问询对话框（三屏：选择 → 自定义输入 → 确认，Esc 取消）
   - 后台任务状态条（`background:task` 事件驱动，自动消隐）
   - Plan mode 指示器（`● PLAN`/`○ normal`，Shift+Tab 切换）
   - 状态栏（`status:bar` 事件驱动，显示 mode/tasks 等段落）
   - 纯 vanilla JS，无框架依赖，CDN 延迟加载渲染库

## Quick Start

### 构建

```bash
npm install
npm run build
```

构建输出 `dist/display.js` + `dist/index.html`。

### 配置 nano-code

在 `.nano-code.yaml` 中配置：

```yaml
display:
  plugin: ./dist/display.js
```

### 启动

```bash
nano-code
```

终端会显示 Web UI 地址（默认 `http://localhost:3030`）。启动时可配合以下参数：

```bash
nano-code --think    # 显示思考过程
nano-code --debug    # 显示调试信息
```

## 配置选项

nano-code 通过 `session:start` 事件的 `config` 对象传递配置：

| 字段 | 类型 | 说明 |
|------|------|------|
| `showThink` | `boolean` | 是否显示 `<think>...</think>` 内容 |
| `debug` | `boolean` | 是否显示调试事件 |
| `greeting` | `string` | 会话欢迎语 |
| `hasTools` | `boolean` | 是否有可用工具 |

## 多标签页同步

多个浏览器标签页连接同一后端时，所有页面的消息和状态保持同步：

- **消息同步**：`user:input`、`stream:chunk` 等事件通过 `broadcast()` 发送给所有连接的 SSE 客户端
- **Plan mode 同步**：切换 mode 时广播 `status:bar` 事件给所有在线客户端；新客户端连入时查询后端当前 mode 并直接推送
- **广播健壮性**：`broadcast()` 使用倒序遍历 + try-catch 保护，单个客户端写失败不影响其他客户端，失效客户端自动移除

## 事件流

| SSE 事件 | 方向 | 说明 |
|----------|------|------|
| `session:start` | 后端 → 前端 | 新会话开始，包含配置 |
| `session:ready` | 后端 → 前端 | 等待用户输入 |
| `session:stop` | 后端 → 前端 | 会话结束 |
| `stream:chunk` | 后端 → 前端 | LLM 文本输出流 |
| `tool:call` | 后端 → 前端 | 工具调用（显示工具卡片） |
| `tool:result` | 后端 → 前端 | 工具调用结果（更新卡片状态） |
| `status` | 后端 → 前端 | 状态更新（thinking/end/信息） |
| `error` | 后端 → 前端 | 错误信息 |
| `debug` | 后端 → 前端 | 调试信息 |
| `agent:turn_start` | 后端 → 前端 | Agent 轮次开始 |
| `agent:turn_end` | 后端 → 前端 | Agent 轮次结束 |
| `confirmation:request` | 后端 → 前端 | 授权确认请求（Allow/Deny） |
| `question:dialog` | 后端 → 前端 | 问询对话框（LLM 向用户提问） |
| `background:task` | 后端 → 前端 | 后台任务状态（started/completed/error） |
| `status:bar` | 后端 → 前端 | 状态栏段落（mode/tasks 等） |
| `user:input` | 后端 → 前端 | 用户输入（全局广播，用于历史重放） |
| `cancel` | 前端 → 后端 | 取消请求（HTTP POST） |
| `confirm` | 前端 → 后端 | 授权确认结果（HTTP POST） |
| `question-answer` | 前端 → 后端 | 问询对话框答案提交（HTTP POST） |
| `mode-toggle` | 前端 → 后端 | Plan mode 切换（HTTP POST） |

## 关键实现细节

### 前端重连与历史消息

前端断开后重新打开时，后端会将已广播的历史事件（`stream:chunk`、`user:input`、`tool:call/result`、`status`、`agent:turn_start/end`、`error`）通过 `onConnect` 回调重新发送给新客户端。缓冲区上限 500 条，`/clear` 或新 session 时自动清空。

配合 nano-code 的 `--continue` / `-c` 标志使用时，`restoreSession()` 会通过 DisplayPlugin 回放已保存的对话消息，nano-code-web 将其广播为 SSE 事件并同时写入历史缓冲区，前端刷新后仍可看到历史。

### 广播容错

`broadcast()` 使用倒序遍历 + try-catch：
- 单个客户端写失败（连接已关闭但尚未清理）不会阻塞其他客户端
- 失效客户端自动从广播列表移除

### 工具调用双向广播

工具调用事件有两条路径到达 SSE：

- **NanoPlugin 路径**（`onBeforeToolCall`/`onAfterToolCall`）：使用 OpenAI 格式（`toolCall.function.name`、`toolCall.id`），是工具卡片的主要来源
- **DisplayPlugin 路径**（`onToolCall`/`onToolResult`）：DisplayPlugin 标准事件路径，作为 NanoPlugin 的补充

`ToolCallBroadcaster` 通过 ID 去重，确保同一工具调用只广播一次。

### 前端渲染

- 消息气泡使用 `white-space: pre-wrap` 保留换行和空白
- 工具卡片使用 `flex-shrink: 0` 避免在长对话滚动后被 flex 布局压缩
- `stream:chunk` 遇到纯空白块时不创建新气泡（避免工具卡片旁的空白气泡）

## 开发

```bash
npm run dev    # tsc --watch 增量编译
npm test       # 运行所有测试（70 用例）
```

### 测试

```bash
# 全部测试（单元测试 + 前端集成测试）
npm test

# Playwright 前端集成测试
npx tsx --test tests/frontend.test.ts

# 工具卡片滚动高度测试
npx tsx --test tests/tool-card-scroll.test.ts
```

测试覆盖：
- `tests/display.test.ts` — ThinkFilter（12 用例）+ ToolCallBroadcaster（12 用例，含历史回调）+ 环形缓冲区（9 用例）+ SSE 重放（4 用例）+ background:task（2 用例）+ question:dialog（1 用例）
- `tests/server.test.ts` — NanoCodeWebServer（20 用例，含 question-answer / mode-toggle）
- `tests/frontend.test.ts` — Playwright 前端渲染（9 用例）
- `tests/tool-card-scroll.test.ts` — Playwright 滚动高度（1 用例）

## 项目文件结构

```
├── src/
│   ├── display.ts       # DisplayPlugin 实现（ThinkFilter、ToolCallBroadcaster、ask_user_question handler）
│   ├── server.ts        # HTTP/SSE 服务器
│   └── tool-display.ts  # 工具名/参数格式化
├── public/
│   └── index.html       # 前端页面（vanilla JS）
├── tests/
│   ├── display.test.ts
│   ├── server.test.ts
│   ├── frontend.test.ts
│   └── tool-card-scroll.test.ts
├── dist/             # 构建输出
├── .nano-code.yaml   # nano-code 插件配置
├── README.md
└── ROADMAP.md
```

## License

MIT
