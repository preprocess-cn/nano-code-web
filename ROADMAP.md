# ROADMAP

## v0.1.2 — 当前版本

### 新增功能

- **CSS/JS 提取为外部文件**
  - `index.html` 中的内联 CSS/JS 拆分为独立文件：`style.css`、`app.js`、`dialog.js`
  - `dialog.js` 模块化问询对话框（三屏：选择 → 自定义输入 → 确认），与主逻辑分离
  - 构建脚本 `npm run build` 自动复制前端文件到 `dist/`

- **通用静态文件服务**
  - `server.ts` 新增 `resolvePublicFile()`/`serveStaticFile()`，自动从 `public/` 或 `dist/` 目录匹配并提供任意静态文件
  - `GET /vendor/*` 路由服务第三方 JS/CSS 库（构建时复制到 `dist/vendor/`）

- **Markdown 渲染库本地化**（离线可用）
  - `markdown-it`、`DOMPurify`、`highlight.js` 从 CDN 改为 npm 依赖
  - `scripts/copy-vendor.mjs` 构建脚本将运行时库从 `node_modules/` 或本地缓存复制到 `dist/vendor/`
  - highlight.js 支持本地 vendor 目录缓存，CDN 下载失败时自动 fallback 为 stub

- **多标签页对话框全 tab 响应**
  - 一个 tab 回答问询/确认后，其他 tab 仍然可以操作
  - 对话框按 id 匹配，每个 tab 的交互状态独立

- **多标签页 plan mode 同步**
  - 切换 mode 时通过 `broadcast('status:bar', ...)` 通知所有在线客户端
  - 新客户端连入时自动查询当前 mode 并推送

- **浮动 Toast 通知**
  - `notify` 消息从 Header 右上角改为页面固定定位的浮动 Toast 容器
  - 绿色左边框、滑入/淡出动画、4 秒自动消失、点击立即关闭
  - 最多同时显示 3 条，超出则移除最早的通知
  - `notify:clear` 事件清空所有 Toast，彻底脱离 Header 布局流

### 修复

- ~~`_req.socket.close` 在 HTTP keep-alive 下误触导致 SSE 连接被提前清理~~
  - 根因：`_req.socket` 的 `close` 事件在 socket 复用时不触发或误触发
  - 修复：改为 `res.on('close', ...)` 精确监听响应流关闭

- ~~`broadcast()` 写失败阻断其他客户端~~
  - 根因：无 try-catch，某个失效客户端 `res.write()` 抛异常中断循环
  - 修复：倒序遍历 + try-catch，写失败自动移除失效客户端

- ~~助手消息气泡底部多一行空白~~
  - 根因：LLM 输出末尾 `\n` 与 `white-space: pre-wrap` 组合导致多余空白行
  - 修复：前端渲染时对末尾 `\n` 做 strip

- ~~工具卡片 rejected 状态 spinner 仍旋转~~
  - 根因：`tool:result` 的 `rejected` 状态未关闭动画
  - 修复：前端检查 `rejected` 状态并停止 spinner

### 已知 Bug

> 无已知 Bug

## v0.1.1 — 历史版本

### 已完成

- **基础架构**
  - `NanoCodeWebServer` HTTP/SSE 服务器
  - DisplayPlugin 事件 → SSE 广播
  - 单页前端，EventSource 接收实时事件

- **核心功能**
  - 消息气泡渲染（用户/助手/系统/错误/agent 标记）
  - 流式文本输出（`stream:chunk`，`white-space: pre-wrap` 排版）
  - Markdown 渲染（`markdown-it` + `highlight.js` 语法高亮 + `DOMPurify` 消毒）
  - 流式渲染优化：debounce（150ms）+ 代码块闭合检测（``` 成对时立即渲染高亮）
  - 工具调用卡片（`tool:call` / `tool:result`，点击展开/收拢参数与返回结果）
  - 授权确认卡片（`confirmation:request` / `POST /confirm`，Allow/Deny 按钮）
  - 思考过程动画（`status: thinking` / `status: end`）
  - Agent 回合切换标记
  - 取消操作（`POST /cancel`）
  - Web 临时文件服务（`GET /web-files/*`）
  - `debug` 模式显示调试事件

- **ThinkFilter**
  - `<think>...</think>` 内容过滤，按 `showThink` 配置开关
  - 支持跨 chunk 分割（包括标签中间切割、`<thi` → `nk>` 拼接）
  - 剥离上游残留的 `</think>` 闭标签

- **ToolCallBroadcaster**
  - 双向路径去重（NanoPlugin + DisplayPlugin 共享实例）
  - SSE 级别广播保护（result 无对应 call 时不广播）
  - 历史回调（`setHistoryCallback`），用于事件缓冲

- **事件历史缓冲区（`eventHistory`）**
  - 环形缓冲区，上限 500 条，记录所有已广播的 SSE 事件
  - 新客户端连入时重放历史事件（`onConnect` 回调）
  - `/clear` 或新 session 时自动清空

- **`user:input` SSE 广播**
  - 用户输入通过 `onUserInput` 全局广播，前端根据该事件渲染用户气泡
  - 前后端统一消息来源，历史重放时用户消息可见

- **前端重连正确性**
  - `user:input` 事件中重置 `state.currentMsg`，确保 `-c` 恢复时不同轮次的消息不会合并

- **授权确认**
  - `registry.setConfirmCallback` — 接收 nano-code 授权请求
  - `server.onConfirm` / `handleConfirm` — `POST /confirm` HTTP 端点
  - `confirmation:request` SSE 事件 → 前端 Allow/Deny 按钮 → `POST /confirm` 回传结果
  - 前端确认卡片样式（⚠ 警告边框、工具名、消息、详情、Allow/Deny 按钮）

- **AskUserQuestion 对话框（v0.1.1 新增）**
  - 注册 `ask_user_question` 交互式 handler
  - `question:dialog` SSE 事件 → 前端模态对话框
  - 三屏流程：选择（单选/多选）→ 自定义输入 → 确认
  - 键盘导航（↑↓←→ Enter Esc）+ 点击选择
  - Esc/Ctrl+C 取消对话框，返回空结果
  - `POST /question-answer` HTTP 端点接收答案

- **Plan mode 支持（v0.1.1 新增）**
  - `POST /mode-toggle` HTTP 端点
  - store 级别 mode 切换（读写 `task-plan:mode` / `task-plan:preMode`）
  - 前端 `● PLAN`/`○ normal` 指示器
  - Shift+Tab 快捷键、点击切换、/plan 斜杠命令、LLM 自然语言
  - 状态栏（`status:bar` 事件）联动

- **后台任务追踪（v0.1.1 新增）**
  - `onBackgroundTask` DisplayPlugin 方法
  - `background:task` SSE 事件（started/completed/error）
  - 前端状态条，5 秒后自动消隐已完成/错误的任务

- **端口冲突处理**
  - `server.start()` 失败时捕获 `EADDRINUSE` 错误
  - 打印友好错误信息（"端口 3030 已被占用，请关闭其他进程后重试"）
  - `process.exit(1)` 异常退出

- **CSS/渲染可靠性**
  - `flex-shrink: 0` 防止工具卡片在滚动后被 flex 压缩
  - `stream:chunk` 纯空白块不创建气泡（避免空白气泡干扰）
  - `tool:call` 处理器主动确保 `#messages` 容器可见

- **开发基础设施**
  - TypeScript + NodeNext 模块系统
  - `node:test` 单元测试
  - Playwright 前端集成测试
  - 共 70 测试用例（12 ThinkFilter + 12 ToolCallBroadcaster + 9 环形缓冲区 + 4 SSE 重放 + 20 Server + 9 前端渲染 + 1 滚动高度 + 2 background:task + 1 question:dialog）

### 已修复 Bug

- ~~工具调用气泡显示异常~~ — 2026-07-04 修复
  - 根因：`.tool-card` 的 `overflow: hidden` 导致 flex `min-height: auto` 失效，滚动后卡片被压缩到 2px
  - 修复：添加 `flex-shrink: 0`
- ~~`</think>` 残留显示~~ — 2026-07-04 修复
  - 根因：nano-code 内核处理 `<think>` 后残留 `</think>`，ThinkFilter 在非 think 模式下未处理
  - 修复：过滤结果中用 `replace(/<\/think>/g, '')` 清理
- ~~空白气泡出现在工具卡片位置~~ — 2026-07-04 修复
  - 根因：`stream:chunk` 的纯 `"\n"` 块在 `tool:call` 后创建了空白助手气泡
  - 修复：前端 `stream:chunk` 处理纯空白文本时不创建新气泡
- ~~前端页面卡在 "Connecting..."，EventSource 无法连接~~ — 2026-07-04 修复
  - 根因：`public/index.html` 中误用 TypeScript `!.` 非空断言，整个 `<script>` 块解析失败
  - 修复：替换为安全的 `const el = query(...); if (el) el.addEventListener(...)`
- ~~工具命令输出直写终端~~ — 2026-07-04 修复
  - 根因：Web display 未调用 `registry.setOutputHandler()`，`command.ts` 回退到 `process.stdout.write` 直写终端
  - 修复：添加 `setOutputHandler`，将 stdout/stderr 转发为 `tool:stdout`/`tool:stderr` SSE 事件

- ~~`--continue` / `-c` 恢复时不同轮次助手消息被合并为一个气泡~~ — 2026-07-04 修复
  - 根因：`restoreSession()` 在消息间不调用 `onAgentTurnEnd`，前端的 `state.currentMsg` 未重置，第二轮 `stream:chunk` 追加到第一轮 DOM 元素
  - 修复：前端 `user:input` handler 中 `renderImmediate()` + `state.currentMsg = null`
- ~~前端重连后工具卡片丢失、消息顺序错乱~~ — 2026-07-04 修复
  - 根因：重放时 `stream:chunk` 合并逻辑可能跨轮合并
  - 修复：去掉合并，每个事件独立重放
- ~~多页面同时在线时新页面收不到消息~~ — 2026-07-10 修复
  - 根因：`broadcast()` 无 try-catch，某个失效客户端 `res.write()` 抛异常中断循环，后续客户端收不到
  - 修复：倒序遍历 + try-catch，写失败自动移除失效客户端
- ~~SSE 客户端断开后残留导致广播阻断~~ — 2026-07-10 修复
  - 根因：`close` 事件绑定在 `_req.socket` 上，HTTP keep-alive 下 socket 复用导致 close 误触发/不触发
  - 修复：改为 `res.on('close', ...)` 精确监听响应流关闭
- ~~多标签页间 plan mode 状态不同步~~ — 2026-07-10 修复
  - 根因：`modeToggle` 回调未广播给在线客户端；`onConnect` 未向新客户端推送当前 mode
  - 修复：切换时 `broadcast('status:bar', ...)`；新客户端连入时查询 registry 推送 mode

### 已知 Bug

> 无已知 Bug

## 待办

### 短期（v0.1.x）

- [ ] 真实环境调试面板：前端显示原始 SSE 事件
- [ ] 在 `nano-code` 新进程启动时自动打开浏览器
- [ ] 前端暗色/亮色主题切换
- [ ] 代码块等宽字体渲染（检测 `├──`、`│` 等树形字符自动切换 monospace）

### 中期（v0.2.0）

- [ ] **历史多媒体缓存** — 图片/文件 URL 在重连后保留
- [ ] **消息复制按钮** — 鼠标悬停时显示复制图标
- [ ] **图片/附件上传** — 通过 POST 支持文件上传
- [ ] **响应式布局** — 移动端支持

### 长期（v0.3.0+）

- [ ] **多 Session 管理** — 标签页切换多个对话
- [ ] **对话导出** — Markdown / JSON 导出
- [ ] **自定义 CSS 主题**
- [ ] **WebSocket 替代 SSE** — 双向通信支持更丰富的交互
- [ ] **贡献指南**（CONTRIBUTING.md）
