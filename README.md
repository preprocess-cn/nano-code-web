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
   - `GET /health` — 健康检查
   - `GET /web-files/*` — 临时文件服务
   - `GET /` — 前端页面

2. **`src/display.ts`** — DisplayPlugin 实现
   - 将 nano-code 的 `onStart/onStreamChunk/onToolCall/onStatus` 等事件广播为 SSE
   - 通过 NanoPlugin `onBeforeToolCall/onAfterToolCall` 追踪工具调用 ID
   - `ThinkFilter` — 按 `showThink` 配置过滤 `<think>...</think>` 内容（支持跨 chunk 分割、处理残留 `</think>`）
   - `ToolCallBroadcaster` — 工具调用事件去重广播（NanoPlugin + DisplayPlugin 双向路径）

3. **`public/index.html`** — 单页前端
   - `EventSource` 接收 SSE，渲染消息气泡、工具调用卡片、thinking 动画、授权确认卡片
   - Markdown 渲染（`markdown-it` + `highlight.js` 语法高亮 + `DOMPurify` 安全消毒）
   - 流式输出优化：debounce（150ms）+ 代码块闭合检测（``` 成对时立即渲染）
   - 工具卡片点击展开/收拢（参数 + 返回结果）
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
| `user:input` | 后端 → 前端 | 用户输入（全局广播，用于历史重放） |
| `cancel` | 前端 → 后端 | 取消请求（HTTP POST） |
| `confirm` | 前端 → 后端 | 授权确认结果（HTTP POST） |

## 关键实现细节

### 前端重连与历史消息

前端断开后重新打开时，后端会将已广播的历史事件（`stream:chunk`、`user:input`、`tool:call/result`、`status`、`agent:turn_start/end`、`error`）通过 `onConnect` 回调重新发送给新客户端。缓冲区上限 500 条，`/clear` 或新 session 时自动清空。

配合 nano-code 的 `--continue` / `-c` 标志使用时，`restoreSession()` 会通过 DisplayPlugin 回放已保存的对话消息，nano-code-web 将其广播为 SSE 事件并同时写入历史缓冲区，前端刷新后仍可看到历史。

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
npm test       # 运行所有测试（65 用例）
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
- `tests/display.test.ts` — ThinkFilter（12 用例）+ ToolCallBroadcaster（12 用例，含历史回调）+ 环形缓冲区（9 用例）+ SSE 重放（4 用例）
- `tests/server.test.ts` — NanoCodeWebServer（18 用例）
- `tests/frontend.test.ts` — Playwright 前端渲染（9 用例）
- `tests/tool-card-scroll.test.ts` — Playwright 滚动高度（1 用例）

## 项目文件结构

```
├── src/
│   ├── display.ts    # DisplayPlugin 实现（ThinkFilter、ToolCallBroadcaster）
│   └── server.ts     # HTTP/SSE 服务器
├── public/
│   └── index.html    # 前端页面（vanilla JS）
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
