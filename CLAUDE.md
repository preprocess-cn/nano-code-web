# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run build` — TypeScript 编译 + 复制 `public/index.html` 到 `dist/`
- `npm run dev` — `tsc --watch` 增量编译

## Project Overview

nano-code 的 Web 显示插件。通过 SSE (Server-Sent Events) 将 nano-code 的 DisplayPlugin 事件推送到浏览器前端。

### Architecture

```
nano-code 核心 → DisplayPlugin 事件 → display.ts → SSE → public/index.html
```

三层结构：

1. **`src/server.ts`** — NanoCodeWebServer: HTTP + SSE 服务器，处理 `/events`(SSE)、`/input`(用户输入)、`/cancel`、`/health`、`/web-files/*`(临时文件)
2. **`src/display.ts`** — DisplayPlugin 实现: 将 nano-code 的 `onStart/onStreamChunk/onToolCall/onStatus` 等事件广播为 SSE，同时通过 NanoPlugin 追踪工具调用 ID
3. **`public/index.html`** — 单页前端: EventSource 接收 SSE，渲染消息气泡、工具调用卡片、thinking 动画

### Key Data Flow

- 用户输入 → POST `/input` → server 回调 → nano-code prompt() 解决 → LLM 响应 → DisplayPlugin 事件 → 广播 SSE → 前端渲染
- `showThink` 配置控制 thinking 动画显示，通过 `session:start` 事件的 `showThink` 字段传递
- 工具调用追踪通过注册 NanoPlugin 的 `onBeforeToolCall/onAfterToolCall` 钩子实现

### File Layout

- `src/server.ts` — HTTP/SSE 服务器类
- `src/display.ts` — DisplayPlugin 工厂函数，export default plugin
- `public/index.html` — 前端 UI（纯 vanilla JS，无框架）
- `.nano-code.yaml` — nano-code 显示插件配置
- `dist/` — 编译输出

### Build Output

`npm run build` 生成 `dist/display.js` + `dist/index.html`，nano-code 通过 `.nano-code.yaml` 中的 `display.plugin: ./dist/display.js` 加载。
