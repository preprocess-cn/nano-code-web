// ── State ──
const state = { currentMsg: null, currentRawText: '', renderTimer: null, toolCards: new Map(), connected: false, es: null, showThink: false, debug: false, toolDefinitions: [], thinkMsg: null, fullAccumulator: '' };

const $ = id => document.getElementById(id);
const msgArea = $('messages');
const welcomeEl = $('welcome');
const inputEl = $('input');
const sendBtn = $('send-btn');
const cancelBtn = $('cancel-btn');
const statusDot = $('status-dot');
const statusText = $('status-text');
const thinkingEl = $('thinking');
// Toast 通知容器（浮动在页面右上角）
const toastContainer = document.createElement('div');
toastContainer.id = 'toast-container';
document.body.appendChild(toastContainer);

let toastIdCounter = 0;
const TOAST_DURATION = 4000;

function showToast(message) {
  const id = ++toastIdCounter;
  const el = document.createElement('div');
  el.className = 'toast';
  el.dataset.toastId = id;
  el.textContent = message;
  el.addEventListener('click', () => removeToast(el));
  toastContainer.appendChild(el);

  const timer = setTimeout(() => removeToast(el), TOAST_DURATION);
  el._timer = timer;

  while (toastContainer.children.length > 3) {
    removeToast(toastContainer.children[0]);
  }
}

function removeToast(el) {
  if (!el || el.classList.contains('fade-out')) return;
  clearTimeout(el._timer);
  el.classList.add('fade-out');
  setTimeout(() => el.remove(), 300);
}

function clearAllToasts() {
  Array.from(toastContainer.children).forEach(removeToast);
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function scrollBottom() { msgArea.scrollTop = msgArea.scrollHeight; }

/** 解析 <think>...</think> 标签，返回 { text, think } 段数组 */
function parseThinkSegments(text) {
  const segments = [];
  let remaining = text;
  let inThink = false;
  while (remaining.length > 0) {
    if (!inThink) {
      const closeIdx = remaining.indexOf('</think>');
      const openIdx = remaining.indexOf('<think>');
      // 孤立的 </think>（无前置 <think>）视为 think 段结束
      if (closeIdx !== -1 && (openIdx === -1 || closeIdx < openIdx)) {
        if (closeIdx > 0) segments.push({ text: remaining.slice(0, closeIdx), think: true });
        remaining = remaining.slice(closeIdx + 8);
        continue;
      }
      if (openIdx === -1) {
        segments.push({ text: remaining, think: false });
        break;
      }
      if (openIdx > 0) segments.push({ text: remaining.slice(0, openIdx), think: false });
      remaining = remaining.slice(openIdx + 7);
      inThink = true;
    } else {
      const idx = remaining.indexOf('</think>');
      if (idx === -1) {
        segments.push({ text: remaining, think: true });
        break;
      }
      if (idx > 0) segments.push({ text: remaining.slice(0, idx), think: true });
      remaining = remaining.slice(idx + 8);
      inThink = false;
    }
  }
  return segments;
}

// ── Markdown 渲染（惰性初始化，CDN defer 加载完成后可用） ──
let _md = null;
function getMd() {
  if (!_md && window.markdownit) {
    _md = window.markdownit({
      html: false, breaks: true, linkify: false,
      highlight(str, lang) {
        if (lang && hljs.getLanguage(lang)) {
          try {
            return '<pre><code class="hljs">' + hljs.highlight(str, { language: lang, ignoreIllegals: true }).value + '</code></pre>';
          } catch {}
        }
        return '<pre><code class="hljs">' + _md.utils.escapeHtml(str) + '</code></pre>';
      },
    });
  }
  return _md;
}

function renderMarkdown(text) {
  if (!text) return '';
  const m = getMd();
  if (!m || !window.DOMPurify) return escapeHtml(text.replace(/\n+$/, ''));
  return DOMPurify.sanitize(m.render(text)).replace(/\n+$/, '');
}

function scheduleRender() {
  if (state.renderTimer) clearTimeout(state.renderTimer);
  state.renderTimer = setTimeout(doRender, 150);
}

function doRender() {
  state.renderTimer = null;
  if (!state.currentMsg || !state.currentRawText) return;
  state.currentMsg.innerHTML = renderStreaming(state.currentRawText);
  scrollBottom();
}

function renderImmediate() {
  if (state.renderTimer) { clearTimeout(state.renderTimer); state.renderTimer = null; }
  doRender();
}

function renderStreaming(text) {
  if (!text) return '';
  const info = findIncompleteTable(text);
  if (info) {
    const m = getMd();
    const beforeHtml = m && window.DOMPurify
      ? DOMPurify.sanitize(m.render(info.before))
      : escapeHtml(info.before);
    return beforeHtml + '<div class="table-pending">' + escapeHtml(info.tablePart) + '</div>';
  }
  return renderMarkdown(text);
}

function findIncompleteTable(text) {
  if (!/^\|[-:| ]+\|$/m.test(text)) return null;
  const lines = text.split('\n');
  let i = lines.length;
  while (i--) { if (lines[i].trim()) break; }
  if (i < 0) return null;
  const trimmed = lines[i].trim();
  if (!trimmed.startsWith('|') || trimmed.endsWith('|')) return null;
  while (i >= 0 && lines[i].trim().startsWith('|')) i--;
  const before = lines.slice(0, i + 1).join('\n');
  const tablePart = lines.slice(i + 1).join('\n');
  if (!/^\|[-:| ]+\|$/m.test(tablePart)) return null;
  return { before, tablePart };
}

function toggleToolDetail(card) {
  const detail = card.querySelector('.tool-detail');
  const arrow = card.querySelector('.tool-arrow');
  if (!detail) return;
  const open = detail.classList.toggle('open');
  arrow.textContent = open ? '▾' : '▸';
}

function addMsg(className, html) {
  welcomeEl.classList.add('hidden');
  msgArea.classList.add('show');
  const el = document.createElement('div');
  el.className = 'msg ' + className;
  el.innerHTML = html;
  msgArea.appendChild(el);
  scrollBottom();
  return el;
}

function setStatus(stateClass, text) {
  statusDot.className = 'dot ' + stateClass;
  statusText.textContent = text;
}

// ── Mode indicator ──
const modeEl = $('mode-indicator');
function updateMode(segments) {
  const modeText = (segments?.mode || '').toLowerCase();
  const isPlan = modeText.includes('plan');
  if (isPlan) {
    modeEl.className = 'show plan';
    modeEl.textContent = '● PLAN (shift+tab)';
    modeEl.title = 'Click or Shift+Tab to switch to normal mode';
  } else {
    modeEl.className = '';
  }
}
async function toggleMode() {
  try { await fetch('/mode-toggle', { method: 'POST', body: '{}' }); } catch {}
}

// ── 跨标签页输入状态同步 ──
const syncChannel = new BroadcastChannel('nano-code-sync');
syncChannel.onmessage = (e) => {
  if (e.data.type === 'inputEnabled') {
    inputEl.disabled = !e.data.enabled;
    sendBtn.disabled = !e.data.enabled;
  }
};

function setInputEnabled(en, broadcast = true) {
  inputEl.disabled = !en;
  sendBtn.disabled = !en;
  if (en && broadcast) setTimeout(() => inputEl.focus(), 100);
  if (broadcast) syncChannel.postMessage({ type: 'inputEnabled', enabled: en });
}

function showThinking(show) { thinkingEl.classList.toggle('show', show); }

let isProcessing = false;
function setProcessing(p) {
  isProcessing = p;
  cancelBtn.style.display = p ? 'block' : 'none';
}

// ── SSE connection ──
function connect() {
  if (state.es) state.es.close();
  const es = new EventSource('/events');
  state.es = es;

  es.addEventListener('session:start', (e) => {
    const d = JSON.parse(e.data);
    msgArea.innerHTML = '';
    msgArea.classList.remove('show');
    welcomeEl.classList.remove('hidden');
    state.currentMsg = null;
    state.currentRawText = '';
    state.thinkMsg = null;
    state.fullAccumulator = '';
    if (state.renderTimer) { clearTimeout(state.renderTimer); state.renderTimer = null; }
    state.toolCards.clear();
    state.showThink = d.showThink === true;
    state.debug = d.debug === true;
    setStatus('connected', 'Ready');
    setInputEnabled(true);
    modeEl.className = '';
    $('bg-tasks').innerHTML = '';
    $('bg-tasks').classList.remove('show');
    $('status-bar').innerHTML = '';
    $('status-bar').classList.remove('show');
  });

  es.addEventListener('session:ready', () => {
    renderImmediate();
    setInputEnabled(true);
    setProcessing(false);
    showThinking(false);
    state.currentMsg = null;
  });

  es.addEventListener('session:stop', (e) => {
    const d = JSON.parse(e.data);
    addMsg('system', d.message || 'Session ended');
    setInputEnabled(false);
    setProcessing(false);
    showThinking(false);
    setStatus('disconnected', 'Ended');
    es.close();
  });

  es.addEventListener('stream:chunk', (e) => {
    const d = JSON.parse(e.data);
    if (!d.text) return;

    if (state.showThink) {
      state.fullAccumulator += d.text;
      const segments = parseThinkSegments(state.fullAccumulator);
      let thinkText = '', normalText = '';
      for (const seg of segments) {
        if (seg.think) thinkText += seg.text;
        else normalText += seg.text;
      }

      // Think 消息
      if (thinkText) {
        showThinking(false);
        welcomeEl.classList.add('hidden');
        msgArea.classList.add('show');
        if (!state.thinkMsg) {
          const el = document.createElement('div');
          el.className = 'msg think';
          msgArea.appendChild(el);
          state.thinkMsg = el;
        }
        const md = renderMarkdown(thinkText);
        state.thinkMsg.innerHTML = md || escapeHtml(thinkText);
      } else if (state.thinkMsg) {
        state.thinkMsg.remove();
        state.thinkMsg = null;
      }

      // 正常文本
      if (normalText) {
        if (!state.currentMsg) {
          welcomeEl.classList.add('hidden');
          msgArea.classList.add('show');
          state.currentMsg = addMsg('assistant', '');
        }
        state.currentRawText = normalText;
        state.currentMsg.innerHTML = escapeHtml(normalText.replace(/\n+$/, ''));
        scrollBottom();
        const markers = normalText.match(/```/g);
        if (markers && markers.length % 2 === 0 && markers.length > 0) {
          clearTimeout(state.renderTimer);
          state.renderTimer = null;
          state.currentMsg.innerHTML = renderStreaming(normalText);
        } else {
          scheduleRender();
        }
      }
      scrollBottom();
      return;
    }

    // ── showThink=false：原始逻辑（服务端已通过 ThinkFilter 剥离 think 标签）──
    if (!state.currentMsg) {
      if (!d.text.trim()) return;
      state.currentMsg = addMsg('assistant', '');
      state.currentRawText = '';
    }
    state.currentRawText += d.text;
    state.currentMsg.innerHTML = escapeHtml(state.currentRawText.replace(/\n+$/, ''));
    scrollBottom();
    const markers = state.currentRawText.match(/```/g);
    if (markers && markers.length % 2 === 0 && markers.length > 0) {
      renderImmediate();
    } else {
      scheduleRender();
    }
  });

  es.addEventListener('tool:call', (e) => {
    const d = JSON.parse(e.data);
    renderImmediate();
    state.currentMsg = null;
    welcomeEl.classList.add('hidden');
    msgArea.classList.add('show');
    const card = document.createElement('div');
    card.className = 'tool-card running';
    card.dataset.toolId = d.id;
    const toolName = d.displayName || d.toolName;
    const argsStr = d.args && Object.keys(d.args).length > 0 ? JSON.stringify(d.args, null, 2) : '';
    const argsPreview = d.argsPreview || '';
    card.innerHTML = `
      <div class="tool-card-header" onclick="toggleToolDetail(this.parentElement)">
        <div class="tool-spinner"></div>
        <span class="tool-name">${escapeHtml(toolName)}<span class="tool-args-preview">${escapeHtml(argsPreview)}</span></span>
        <span class="tool-status">running</span>
        <span class="tool-arrow">▸</span>
      </div>
      <div class="tool-detail">
        ${argsStr ? `<div class="tool-section"><div class="tool-section-label">Arguments</div><pre class="tool-section-content">${escapeHtml(argsStr)}</pre></div>` : ''}
        <div class="tool-section tool-result-section" style="display:none"><div class="tool-section-label">Result</div><pre class="tool-section-content tool-result-content"></pre></div>
      </div>`;
    msgArea.appendChild(card);
    state.toolCards.set(d.id, card);
    scrollBottom();
  });

  es.addEventListener('tool:result', (e) => {
    const d = JSON.parse(e.data);
    const card = state.toolCards.get(d.id);
    if (!card) return;
    card.classList.remove('running');
    card.classList.add(d.status === 'success' ? 'success' : d.status === 'error' ? 'error' : 'rejected');
    card.querySelector('.tool-status').textContent = d.status === 'success' ? 'ok' : d.status === 'error' ? (d.message || 'failed') : 'rejected';
    const sec = card.querySelector('.tool-result-section');
    const content = card.querySelector('.tool-result-content');
    if (sec && content) { sec.style.display = ''; content.textContent = d.message || d.status || ''; }
  });

  es.addEventListener('tool:definitions', (e) => {
    const d = JSON.parse(e.data);
    state.toolDefinitions = d.definitions || [];
  });

  es.addEventListener('status', (e) => {
    const d = JSON.parse(e.data);
    if (d.level === 'status' && d.message === 'thinking') { if (state.showThink) showThinking(true); setProcessing(true); }
    else if (d.level === 'status' && d.message === 'end') { renderImmediate(); showThinking(false); setProcessing(false); state.currentMsg = null; state.thinkMsg = null; state.fullAccumulator = ''; }
    else if (d.level === 'info' || d.level === 'warn') addMsg('system', d.message);
  });

  es.addEventListener('error', (e) => {
    const d = JSON.parse(e.data);
    addMsg('error', 'Error: ' + escapeHtml(d.message));
  });

  es.addEventListener('debug', (e) => {
    if (!state.debug) return;
    const d = JSON.parse(e.data);
    const data = typeof d.data === 'string' ? d.data : JSON.stringify(d.data, null, 2);
    const tag = d.agentName && d.agentName !== 'main' ? `[${escapeHtml(d.agentName)}] ` : '';
    const el = addMsg('debug', '');
    el.innerHTML = '<span class="debug-label">[debug]</span> ' + tag + escapeHtml(data);
  });

  es.addEventListener('agent:turn_start', (e) => {
    const d = JSON.parse(e.data);
    if (d.agentName !== 'main') addMsg('agent-badge', '&#9881; Agent: ' + escapeHtml(d.agentName));
  });

  es.addEventListener('agent:turn_end', () => { renderImmediate(); state.currentMsg = null; });

  es.addEventListener('confirmation:request', (e) => {
    const d = JSON.parse(e.data);
    setInputEnabled(false, false);
    msgArea.querySelectorAll('.confirm-card').forEach(el => el.remove());
    const card = document.createElement('div');
    card.className = 'confirm-card';
    card.dataset.confirmId = d.id;
    const toolLabel = escapeHtml(d.displayName || d.toolName);
    let diffHtml = '';
    if (d.diff && d.diff.length > 0) {
      diffHtml = '<div class="tool-section"><div class="tool-section-label">Diff</div><div class="tool-section-content">';
      for (const h of d.diff) {
        for (const l of h.lines || []) {
          const cl = l.type === 'add' ? 'color:#51cf66' : l.type === 'remove' ? 'color:#ff6b6b' : 'color:var(--text-muted)';
          const prefix = l.type === 'add' ? '+' : l.type === 'remove' ? '-' : ' ';
          diffHtml += `<span style="${cl}">${escapeHtml(prefix + l.content)}</span>\n`;
        }
      }
      diffHtml += '</div></div>';
    }
    const fileHtml = d.filePath ? `<div class="confirm-details">File: ${escapeHtml(d.filePath)}</div>` : '';
    card.innerHTML = `
      <div class="confirm-header"><span class="confirm-icon">⚠</span><span class="confirm-title">Authorization Required</span></div>
      <div class="confirm-tool">${toolLabel}</div>
      <div class="confirm-message">${escapeHtml(d.message)}</div>
      ${fileHtml}
      ${d.details ? `<div class="confirm-details">${escapeHtml(d.details)}</div>` : ''}
      ${diffHtml}
      <div class="confirm-buttons">
        <button class="confirm-btn deny">Deny</button>
        <button class="confirm-btn allow">Allow</button>
      </div>`;
    const allowBtn = card.querySelector('.allow');
    const denyBtn = card.querySelector('.deny');
    if (allowBtn) allowBtn.addEventListener('click', () => sendConfirm(d.id, true));
    if (denyBtn) denyBtn.addEventListener('click', () => sendConfirm(d.id, false));
    msgArea.appendChild(card);
    scrollBottom();
  });

  es.addEventListener('confirmation:resolved', (e) => {
    const d = JSON.parse(e.data);
    const card = document.querySelector(`.confirm-card[data-confirm-id="${d.id}"]`);
    if (card) card.remove();
  });

  es.addEventListener('question:dialog', (e) => {
    const d = JSON.parse(e.data);
    qdOpen(d);
  });

  es.addEventListener('question:resolved', () => {
    qdClose();
  });

  es.addEventListener('background:task', (e) => {
    const d = JSON.parse(e.data);
    const bar = $('bg-tasks');
    const existing = bar.querySelector(`[data-task-id="${d.taskId}"]`);
    if (existing) existing.remove();
    if (d.taskStatus === 'started') {
      const el = document.createElement('span');
      el.className = 'bg-task';
      el.dataset.taskId = d.taskId;
      el.innerHTML = `<span class="dot running"></span> ${escapeHtml(d.message || d.taskId)}`;
      bar.appendChild(el);
    } else if (d.taskStatus === 'completed' || d.taskStatus === 'error') {
      const el = document.createElement('span');
      el.className = 'bg-task';
      el.dataset.taskId = d.taskId;
      el.innerHTML = `<span class="dot ${d.taskStatus}"></span> ${escapeHtml(d.message || d.taskId)}`;
      bar.appendChild(el);
      setTimeout(() => { const e2 = bar.querySelector(`[data-task-id="${d.taskId}"]`); if (e2) e2.remove(); bar.classList.toggle('show', bar.children.length > 0); }, 5000);
    }
    bar.classList.toggle('show', bar.children.length > 0);
  });

  es.addEventListener('status:bar', (e) => {
    const d = JSON.parse(e.data);
    const bar = $('status-bar');
    bar.innerHTML = '';
    if (d.segments && typeof d.segments === 'object') {
      let count = 0;
      for (const [key, value] of Object.entries(d.segments)) {
        if (key === 'mode') continue;
        if (value) { bar.innerHTML += `<span class="status-seg">${escapeHtml(value)}</span>`; count++; }
      }
      bar.classList.toggle('show', count > 0);
    }
    updateMode(d.segments);
  });

  es.addEventListener('notify', (e) => {
    const d = JSON.parse(e.data);
    showToast(d.message);
  });

  es.addEventListener('notify:clear', () => {
    clearAllToasts();
  });

  es.addEventListener('context:analysis', (e) => {
    const d = JSON.parse(e.data);
    addMsg('system', `[context] ${Math.round(d.percentage)}% used (${d.totalTokens}/${d.contextWindow}, free: ${d.freeTokens})`);
  });

  es.addEventListener('user:input', (e) => {
    const d = JSON.parse(e.data);
    renderImmediate();
    state.currentMsg = null;
    state.thinkMsg = null;
    state.fullAccumulator = '';
    addMsg('user', escapeHtml(d.text));
  });

  es.onerror = () => { setStatus('disconnected', 'Reconnecting...'); state.connected = false; setInputEnabled(false, false); };
  es.onopen = () => { setStatus('connected', 'Connected'); state.connected = true; };
}

async function sendInput() {
  const text = inputEl.value;
  if (!text.trim()) return;
  inputEl.value = '';
  setInputEnabled(false);
  state.currentMsg = null;
  try {
    const r = await fetch('/input', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text.trim() }) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
  } catch (err) {
    addMsg('user', escapeHtml(text.trim()));
    addMsg('error', 'Failed to send: ' + err.message);
    setInputEnabled(true);
  }
}

async function sendCancel() { try { await fetch('/cancel', { method: 'POST', body: '{}' }); } catch {} }

async function sendConfirm(id, approved) {
  try { await fetch('/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, approved }) }); } catch {}
  const card = document.querySelector(`.confirm-card[data-confirm-id="${id}"]`);
  if (card) card.remove();
}

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); toggleMode(); return; }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendInput(); }
});
connect();

(function pollMdLibs() {
  if (window.markdownit && window.DOMPurify) {
    if (state.currentMsg && state.currentRawText) doRender();
    if (window.hljs && state.currentMsg && state.currentRawText) doRender();
    return;
  }
  setTimeout(pollMdLibs, 300);
})();
