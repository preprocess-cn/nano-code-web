// ── Question dialog state machine ──
const qd = {
  questions: [],
  currentIdx: 0,
  focusIdx: 0,
  screen: 'selecting',
  selections: {},
  customInputs: {},
  customText: '',
  dialogId: '',
  multiSelect: false,
};

function qdOpen(data) {
  setInputEnabled(false, false);
  qd.questions = data.questions || [];
  qd.currentIdx = 0;
  qd.focusIdx = 0;
  qd.screen = 'selecting';
  qd.selections = {};
  qd.customInputs = {};
  qd.customText = '';
  qd.dialogId = data.id || '';
  qd.multiSelect = false;
  for (const q of qd.questions) qd.selections[q.question] = [];
  $('qd-overlay').classList.add('show');
  qdRender();
  window._qd = qd;
}

function qdClose() {
  $('qd-overlay').classList.remove('show');
}

function qdRender() {
  const overlay = $('qd-overlay');
  if (!overlay.classList.contains('show')) return;
  $('qd-options').style.display = 'none';
  $('qd-desc').style.display = 'none';
  $('qd-hint').style.display = 'none';
  $('qd-custom-area').classList.remove('show');
  $('qd-custom-hint').classList.remove('show');
  $('qd-confirm-area').classList.remove('show');
  $('qd-back').style.display = 'none';
  $('qd-next').style.display = 'none';
  $('qd-submit').style.display = 'none';
  $('qd-cancel').style.display = '';

  if (qd.screen === 'selecting') {
    qdRenderSelecting();
  } else if (qd.screen === 'customInput') {
    qdRenderCustomInput();
  } else if (qd.screen === 'confirming') {
    qdRenderConfirming();
  }
}

function qdRenderSelecting() {
  const q = qd.questions[qd.currentIdx];
  if (!q) return;
  const allOptions = [...q.options, { label: '其它 (自定义输入)', description: '输入自定义文本' }];
  $('qd-header-title').textContent = '❓ ' + q.header;
  $('qd-progress').textContent = '(' + (qd.currentIdx + 1) + '/' + qd.questions.length + ')';
  $('qd-question').textContent = q.question;
  const sel = qd.selections[q.question] || [];

  const optsEl = $('qd-options');
  optsEl.style.display = '';
  optsEl.innerHTML = '';
  for (let i = 0; i < allOptions.length; i++) {
    const opt = allOptions[i];
    const isFocused = i === qd.focusIdx;
    const isSelected = sel.includes(opt.label);
    const isOther = opt.label === '其它 (自定义输入)';
    const div = document.createElement('div');
    div.className = 'qd-opt' + (isFocused ? ' focused' : '') + (isSelected ? ' selected' : '') + (isOther ? ' other' : '');
    div.dataset.idx = i;
    div.innerHTML = '<span class="indicator">' + (isOther ? (isSelected ? '✎' : '✎') : q.multiSelect ? (isSelected ? '☑' : '☐') : isFocused ? '◉' : '○') + '</span><span class="label">' + escapeHtml(opt.label) + '</span>';
    div.onclick = () => { qd.focusIdx = i; qdSelectOption(); };
    div.onmouseenter = () => { qd.focusIdx = i; qdRender(); };
    optsEl.appendChild(div);
  }

  $('qd-desc').style.display = '';
  $('qd-desc').textContent = allOptions[qd.focusIdx]?.description || '';

  $('qd-hint').style.display = '';
  $('qd-hint').textContent = q.multiSelect
    ? '↑↓ 选择  Space 切换  ←→ 切换问题  Enter 确认  Esc 取消'
    : '↑↓ 选择  Enter 确认  ←→ 切换问题  Esc 取消';

  $('qd-cancel').style.display = '';
  if (qd.currentIdx < qd.questions.length - 1) {
    const selCur = qd.selections[qd.questions[qd.currentIdx].question] || [];
    if (selCur.length > 0) {
      $('qd-next').style.display = '';
      $('qd-next').textContent = 'Next →';
    }
  } else {
    const allAnswered = qd.questions.every(q2 => (qd.selections[q2.question] || []).length > 0);
    if (allAnswered) {
      $('qd-next').style.display = '';
      $('qd-next').textContent = 'Review';
    }
  }
}

function qdRenderCustomInput() {
  const q = qd.questions[qd.currentIdx];
  $('qd-header-title').textContent = '✎ ' + q.header + ' - 自定义输入';
  $('qd-progress').textContent = '';
  $('qd-question').textContent = q.question;

  $('qd-custom-area').classList.add('show');
  $('qd-custom-hint').classList.add('show');
  const input = $('qd-custom-input');
  input.value = qd.customText;
  setTimeout(() => input.focus(), 50);

  $('qd-cancel').textContent = 'Back';
}

function qdRenderConfirming() {
  $('qd-header-title').innerHTML = '✓ 确认你的回答';
  $('qd-progress').textContent = '';
  $('qd-question').style.display = 'none';

  const area = $('qd-confirm-area');
  area.classList.add('show');
  area.innerHTML = '';
  for (const q of qd.questions) {
    const sel = qd.selections[q.question] || [];
    const hasOther = sel.includes('其它 (自定义输入)');
    const custom = qd.customInputs[q.question] || '';
    const normalSel = sel.filter(s => s !== '其它 (自定义输入)');
    const display = hasOther && custom ? escapeHtml(custom) : escapeHtml(normalSel.join(', ') || (hasOther ? '(空)' : '(未选择)'));
    const item = document.createElement('div');
    item.className = 'qd-confirm-item';
    item.innerHTML = '<div class="q">[' + escapeHtml(q.header) + '] ' + escapeHtml(q.question) + '</div><div class="a">→ ' + display + '</div>';
    area.appendChild(item);
  }

  $('qd-cancel').style.display = '';
  $('qd-back').style.display = '';
  $('qd-submit').style.display = '';
}

function qdSelectOption() {
  const q = qd.questions[qd.currentIdx];
  const allOptions = [...q.options, { label: '其它 (自定义输入)', description: '' }];
  const opt = allOptions[qd.focusIdx];
  const isOther = opt.label === '其它 (自定义输入)';

  if (q.multiSelect) {
    const prev = [...(qd.selections[q.question] || [])];
    const idx = prev.indexOf(opt.label);
    if (idx >= 0) prev.splice(idx, 1);
    else prev.push(opt.label);
    qd.selections[q.question] = prev;
    qdRender();
    return;
  }

  if (isOther) {
    qd.selections[q.question] = ['其它 (自定义输入)'];
    qd.customText = qd.customInputs[q.question] || '';
    qd.screen = 'customInput';
    qdRender();
    return;
  }
  qd.selections[q.question] = [opt.label];
  qdAdvance();
}

function qdAdvance() {
  if (qd.currentIdx < qd.questions.length - 1) {
    const sel = qd.selections[qd.questions[qd.currentIdx].question] || [];
    if (sel.includes('其它 (自定义输入)')) {
      qd.customText = qd.customInputs[qd.questions[qd.currentIdx].question] || '';
      qd.screen = 'customInput';
      qdRender();
      return;
    }
    qd.currentIdx++;
    qd.focusIdx = 0;
    qdRender();
  } else {
    const allAnswered = qd.questions.every(q2 => (qd.selections[q2.question] || []).length > 0);
    if (allAnswered) {
      qd.screen = 'confirming';
      qdRender();
    }
  }
}

function qdNext() {
  if (qd.screen === 'confirming') { qdSubmit(); return; }
  const q = qd.questions[qd.currentIdx];
  const sel = qd.selections[q.question] || [];
  if (sel.includes('其它 (自定义输入)')) {
    qd.customText = qd.customInputs[q.question] || '';
    qd.screen = 'customInput';
    qdRender();
    return;
  }
  qdAdvance();
}

function qdBack() {
  if (qd.screen === 'confirming') {
    qd.screen = 'selecting';
    qd.currentIdx = qd.questions.length - 1;
    qd.focusIdx = 0;
    qdRender();
  }
}

function qdCancel() {
  if (qd.screen === 'customInput') {
    qd.screen = 'selecting';
    qdRender();
    return;
  }
  if (qd.dialogId) {
    fetch('/question-answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: qd.dialogId, answers: {} }) }).catch(() => {});
  }
  qdClose();
}

function qdSubmit() {
  const answers = {};
  for (const q of qd.questions) {
    const sel = qd.selections[q.question] || [];
    if (sel.includes('其它 (自定义输入)')) {
      answers[q.question] = qd.customInputs[q.question] || '';
    } else {
      answers[q.question] = sel.join(', ');
    }
  }
  if (qd.dialogId) {
    fetch('/question-answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: qd.dialogId, answers }) }).catch(() => {});
  }
  qdClose();
}

document.addEventListener('keydown', (e) => {
  const overlay = $('qd-overlay');
  if (!overlay.classList.contains('show')) return;
  if (qd.screen === 'customInput' && document.activeElement === $('qd-custom-input')) {
    if (e.key === 'Escape') { e.preventDefault(); qdCancel(); return; }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const q = qd.questions[qd.currentIdx];
      qd.customInputs[q.question] = $('qd-custom-input').value;
      qd.customText = '';
      qd.screen = 'selecting';
      const allAnswered = qd.questions.every(q2 => (qd.selections[q2.question] || []).length > 0);
      if (allAnswered && qd.currentIdx === qd.questions.length - 1) {
        qd.screen = 'confirming';
      }
      qdRender();
      return;
    }
    return;
  }
  if (e.key === 'Escape') { e.preventDefault(); qdCancel(); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); qd.focusIdx = Math.min(qd.questions[qd.currentIdx].options.length, qd.focusIdx + 1); qdRender(); return; }
  if (e.key === 'ArrowUp') { e.preventDefault(); qd.focusIdx = Math.max(0, qd.focusIdx - 1); qdRender(); return; }
  if (e.key === 'ArrowLeft') { e.preventDefault(); if (qd.currentIdx > 0) { qd.currentIdx--; qd.focusIdx = 0; qdRender(); } return; }
  if (e.key === 'ArrowRight') { e.preventDefault(); if (qd.currentIdx < qd.questions.length - 1) { const q = qd.questions[qd.currentIdx]; const sel = qd.selections[q.question] || []; if (sel.length > 0) { qd.currentIdx++; qd.focusIdx = 0; qdRender(); } } return; }
  if (e.key === 'Enter') { e.preventDefault(); qdSelectOption(); return; }
  if (e.key === ' ') { e.preventDefault(); qdSelectOption(); return; }
});
