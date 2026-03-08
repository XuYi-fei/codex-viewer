const state = {
  token: localStorage.getItem('codexViewerToken') || '',
  session: null,
  threads: [],
  approvals: [],
  rawRequests: [],
  interceptedLogs: [],
  errorLogs: [],
  interceptedTypeStats: {},
  interceptedStatusStats: {},
  selectedInterceptedLogId: null,
  interceptedRawLines: [],
  selectedThreadId: localStorage.getItem('codexViewerSelectedThreadId') || null,
  selectedRequestId: null,
  tab: localStorage.getItem('codexViewerTab') || 'conversation',
  prompt: '',
  pairToken: new URLSearchParams(window.location.search).get('pair') || '',
  ws: null,
  showTimeline: false,
  loadingThreadIds: new Set(),
  modal: null,
  mobileDrawerOpen: false,
  sendingPrompt: false,
  promptIsComposing: false,
  promptLastCompositionEndAt: 0,
  askUserDraft: {},
  hydratingThreadSummaries: false,
  scrollIntent: {
    conversation: true,
    requests: true,
    approvals: true,
    commands: true,
    logs: true,
  },
};

function h(strings, ...values) {
  return strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, '');
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || response.statusText);
  }
  return response.json();
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function sanitizeUrl(url = '') {
  const value = String(url || '').trim();
  if (/^(https?:|mailto:)/i.test(value)) return escapeHtml(value);
  return '#';
}

function renderInlineMarkdown(value = '') {
  let html = escapeHtml(value);
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
  html = html.replace(/(^|[^_])_([^_]+)_(?!_)/g, '$1<em>$2</em>');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, url) => `<a href="${sanitizeUrl(url)}" target="_blank" rel="noreferrer">${label}</a>`);
  return html;
}

function renderMarkdownBlocks(text = '') {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let paragraph = [];
  let listType = null;
  let listItems = [];
  let quoteLines = [];

  function flushParagraph() {
    if (!paragraph.length) return;
    blocks.push(`<p>${renderInlineMarkdown(paragraph.join(' '))}</p>`);
    paragraph = [];
  }

  function flushList() {
    if (!listItems.length || !listType) return;
    const tag = listType === 'ol' ? 'ol' : 'ul';
    blocks.push(`<${tag}>${listItems.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join('')}</${tag}>`);
    listType = null;
    listItems = [];
  }

  function flushQuote() {
    if (!quoteLines.length) return;
    blocks.push(`<blockquote>${quoteLines.map((line) => `<p>${renderInlineMarkdown(line)}</p>`).join('')}</blockquote>`);
    quoteLines = [];
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      flushList();
      flushQuote();
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      flushQuote();
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const unordered = trimmed.match(/^[-*+]\s+(.*)$/);
    if (unordered) {
      flushParagraph();
      flushQuote();
      if (listType && listType !== 'ul') flushList();
      listType = 'ul';
      listItems.push(unordered[1]);
      continue;
    }

    const ordered = trimmed.match(/^\d+[.)]\s+(.*)$/);
    if (ordered) {
      flushParagraph();
      flushQuote();
      if (listType && listType !== 'ol') flushList();
      listType = 'ol';
      listItems.push(ordered[1]);
      continue;
    }

    const quote = trimmed.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      flushList();
      quoteLines.push(quote[1]);
      continue;
    }

    flushList();
    flushQuote();
    paragraph.push(trimmed);
  }

  flushParagraph();
  flushList();
  flushQuote();
  return blocks.join('');
}

function renderMarkdown(text = '') {
  const source = String(text || '').replace(/\r\n/g, '\n');
  const segments = source.split(/^\s*```([^\s`]*)\s*\n([\s\S]*?)^\s*```\s*$/gm);
  let html = '';

  for (let index = 0; index < segments.length; index += 1) {
    if (index % 3 === 0) {
      html += renderMarkdownBlocks(segments[index]);
      continue;
    }
    const languageRaw = String(segments[index] || '').trim();
    const language = escapeHtml(languageRaw || 'code');
    const code = escapeHtml(segments[index + 1] || '');
    const codeClass = languageRaw ? ` language-${escapeHtml(languageRaw.toLowerCase().replace(/[^a-z0-9_+#.-]/g, '-'))}` : '';
    html += `<pre class="mdCodeBlock" data-lang="${language}"><code class="${codeClass.trim()}">${code}</code></pre>`;
    index += 1;
  }

  return html || '<p></p>';
}

function normalizeCodeLanguage(value = '') {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  const aliasMap = {
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    jsx: 'javascript',
    py: 'python',
    rb: 'ruby',
    sh: 'bash',
    shell: 'bash',
    zsh: 'bash',
    yml: 'yaml',
    md: 'markdown',
    csharp: 'csharp',
    'c#': 'csharp',
    cs: 'csharp',
    'c++': 'cpp',
    hpp: 'cpp',
    cc: 'cpp',
    h: 'c',
    objc: 'objectivec',
    'objective-c': 'objectivec',
    text: 'plaintext',
    plain: 'plaintext',
  };
  return aliasMap[raw] || raw;
}

function highlightCodeBlocks(root = document) {
  const hljs = window.hljs;
  if (!hljs || !root?.querySelectorAll) return;
  root.querySelectorAll('.mdCodeBlock code').forEach((codeNode) => {
    if (codeNode.dataset.hlApplied === '1') return;
    const preNode = codeNode.closest('.mdCodeBlock');
    const rawLang = String(preNode?.dataset?.lang || '').trim();
    const language = normalizeCodeLanguage(rawLang);
    const text = codeNode.textContent || '';

    try {
      if (language && hljs.getLanguage(language)) {
        codeNode.innerHTML = hljs.highlight(text, { language, ignoreIllegals: true }).value;
        codeNode.classList.add(`language-${language}`);
      } else if (text.trim()) {
        const result = hljs.highlightAuto(text);
        codeNode.innerHTML = result.value;
        if (result.language) {
          preNode.dataset.lang = result.language;
          codeNode.classList.add(`language-${result.language}`);
        }
      }
    } catch {
      // keep plain escaped text when highlighting fails
    }

    if (preNode && !preNode.querySelector('.codeCopyButton')) {
      const copyButton = document.createElement('button');
      copyButton.type = 'button';
      copyButton.className = 'codeCopyButton';
      copyButton.dataset.copyCode = '1';
      copyButton.textContent = '复制';
      preNode.appendChild(copyButton);
      preNode.classList.add('hasHeader');
    }

    codeNode.dataset.hlApplied = '1';
  });
}

async function copyToClipboard(text = '') {
  const value = String(text || '');
  if (!value) return false;
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {}
  }
  try {
    const helper = document.createElement('textarea');
    helper.value = value;
    helper.setAttribute('readonly', 'readonly');
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    helper.style.pointerEvents = 'none';
    document.body.appendChild(helper);
    helper.select();
    helper.setSelectionRange(0, helper.value.length);
    const result = document.execCommand('copy');
    document.body.removeChild(helper);
    return Boolean(result);
  } catch {
    return false;
  }
}

function compactStreamingText(value, { keepSingleBlank = false, trimLeading = true } = {}) {
  const lines = String(value || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/g, ''));
  const output = [];
  let blankCount = 0;

  for (const rawLine of lines) {
    const line = trimLeading ? String(rawLine || '').replace(/^\s+/g, '') : String(rawLine || '');
    if (!line.trim()) {
      blankCount += 1;
      if (!keepSingleBlank || blankCount > 1) continue;
      output.push('');
      continue;
    }
    blankCount = 0;
    output.push(line);
  }

  return output.join('\n').trim();
}

function normalizeThinkingText(value = '') {
  const compact = compactStreamingText(value, { keepSingleBlank: false, trimLeading: true });
  if (!compact) return '';
  const plain = compact
    .replace(/\r\n/g, '\n')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1$2')
    .replace(/(^|[^_])_([^_]+)_(?!_)/g, '$1$2')
    .replace(/\n+/g, ' ')
    .replace(/[ \t]{2,}/g, ' ');
  return plain.trim();
}

function normalizeAssistantText(value = '') {
  const lines = String(value || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/g, ''));

  const output = [];
  let inCodeBlock = false;
  let blankCount = 0;

  for (const line of lines) {
    const fence = line.match(/^\s*```([^\s`]*)\s*$/);
    if (fence) {
      inCodeBlock = !inCodeBlock;
      blankCount = 0;
      output.push(line.trim());
      continue;
    }

    if (inCodeBlock) {
      output.push(line);
      continue;
    }

    if (!line.trim()) {
      blankCount += 1;
      if (blankCount > 1) continue;
      output.push('');
      continue;
    }

    blankCount = 0;
    output.push(line);
  }

  while (output.length > 0 && !output[0].trim()) output.shift();
  while (output.length > 0 && !output[output.length - 1].trim()) output.pop();

  return output.join('\n');
}

function renderThinking(message) {
  const content = normalizeThinkingText(message.text || message.summaryText || '');
  return `<div class="messageThinking"><span class="thinkingLabel">Thinking...</span> <span class="thinkingBody">${content ? escapeHtml(content) : '等待思考输出…'}</span></div>`;
}

function renderMessageBlock(message) {
  const assistantText = message.role === 'assistant' ? normalizeAssistantText(message.text || '') : '';
  return `<div class="messageBlock ${message.role === 'user' ? 'user' : 'assistant'}"><div class="messageBodyText">${
    message.role === 'assistant'
      ? `<div class="markdownContent">${renderMarkdown(assistantText)}</div>`
      : `<div class="plainUserText">${escapeHtml(message.text || '')}</div>`
  }</div></div>`;
}

function isToolCardDone(card) {
  if (!card) return false;
  if (card.done === true) return true;
  const status = String(card.status || '').toLowerCase();
  if (!status) return false;
  return (
    status.includes('完成')
    || status.includes('结束')
    || status.includes('done')
    || status.includes('complete')
    || status.includes('success')
    || status.includes('finished')
    || status.includes('interrupted')
    || status.includes('failed')
    || status.includes('cancel')
    || status.includes('exited')
  );
}

function renderToolCall(card) {
  const done = isToolCardDone(card);
  const hasOutput = Boolean(String(card.output || '').trim());
  const hasCommand = Boolean(String(card.command || '').trim());
  const preview = hasCommand
    ? `命令：${compactText(String(card.command || '').trim(), 64)}`
    : (hasOutput ? compactText(card.output, 64) : (done ? '无输出' : '等待输出…'));
  const commandLine = hasCommand ? `<div class="toolCardMethod">${escapeHtml(card.command)}</div>` : '';
  const methodLine = (card.method && String(card.method) !== String(card.command || ''))
    ? `<div class="toolCardMethod">${escapeHtml(card.method)}</div>`
    : '';
  return `<details class="toolCard ${done ? 'done' : 'running'}"><summary><span class="toolCardTitle">${escapeHtml(card.title || '工具调用')}</span><span class="toolCardStatus">${escapeHtml(card.status || (done ? '已完成' : '运行中'))}</span></summary><div class="toolCardPreview">${escapeHtml(preview)}</div><div class="toolCardBody">${commandLine}${methodLine}<pre>${escapeHtml(hasOutput ? card.output : (done ? '无输出' : '暂无输出'))}</pre></div></details>`;
}

function isFileChangeMessage(message) {
  if (!message || message.role !== 'assistant') return false;
  const text = String(message.text || '').trim();
  if (!text) return false;
  return /^Updated(?:\s+\d+)?\s+files?\./i.test(text) || text === 'Updated files.';
}

function renderFileChangeMessage(message) {
  return `<div class="messageEvent fileChange"><div class="messageEventMeta"><span>文件变更</span></div><div class="fileChangeBody markdownContent">${renderMarkdown(message.text || '')}</div></div>`;
}

function formatTime(value) {
  if (!value) return '—';
  const numeric = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  if (!numeric || Number.isNaN(numeric)) return String(value);
  return new Date(numeric).toLocaleString();
}

function formatRelative(value) {
  if (!value) return '—';
  const numeric = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  if (!numeric || Number.isNaN(numeric)) return '—';
  const diff = Date.now() - numeric;
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  return `${Math.round(hours / 24)}天前`;
}

function compactId(value = '', head = 8, tail = 8) {
  const text = String(value || '');
  if (!text) return '—';
  if (text.length <= head + tail + 1) return text;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

function isMobileViewport() {
  return window.matchMedia('(max-width: 940px)').matches;
}

function statusText(status) {
  if (status == null) return 'unknown';
  if (typeof status === 'string') return status;
  if (typeof status === 'object') {
    if (status.type) return status.type;
    return JSON.stringify(status);
  }
  return String(status);
}

function statusClass(status) {
  const text = statusText(status).toLowerCase();
  if (text.includes('ready') || text.includes('idle') || text.includes('completed')) return 'status-ready';
  if (text.includes('warn')) return 'status-starting';
  if (text.includes('start') || text.includes('active') || text.includes('progress')) return 'status-starting';
  if (text.includes('exit') || text.includes('error') || text.includes('cancel') || text.includes('decline')) return 'status-error';
  return '';
}

function viewerRoleLabel(role) {
  if (role === 'controller') return '控制端';
  if (role === 'viewer') return '观察端';
  return role || '未知';
}

function tabLabel(tab) {
  if (tab === 'conversation') return '对话';
  if (tab === 'requests') return '请求';
  if (tab === 'approvals') return '审批';
  if (tab === 'commands') return '命令';
  if (tab === 'logs') return '日志';
  return tab;
}

function createDetails(id) {
  return { id, events: [], messages: [], commandLog: [], planLog: [] };
}

function detailScore(details) {
  if (!details) return 0;
  return (details.messages?.length || 0) + (details.commandLog?.length || 0) + (details.events?.length || 0) + (details.planLog?.length || 0);
}

function rememberSelectedThread() {
  if (state.selectedThreadId) localStorage.setItem('codexViewerSelectedThreadId', state.selectedThreadId);
  else localStorage.removeItem('codexViewerSelectedThreadId');
}

function setSelectedThread(threadId) {
  state.selectedThreadId = threadId || null;
  rememberSelectedThread();
}

function setActiveTab(tab) {
  state.tab = tab;
  localStorage.setItem('codexViewerTab', tab);
}

function needsThreadHistory(thread) {
  return detailScore(thread?.details) === 0;
}

function threadNeedsSummaryHydration(thread) {
  return !!thread?.id && needsThreadHistory(thread);
}

function mergeThreadsLocal(nextThreads = []) {
  const previous = new Map(state.threads.map((thread) => [thread.id, thread]));
  state.threads = nextThreads.map((thread) => {
    const existing = previous.get(thread.id);
    if (!existing) {
      return {
        ...thread,
        details: thread.details || createDetails(thread.id),
      };
    }
    const existingDetails = existing.details || createDetails(thread.id);
    const incomingDetails = thread.details || createDetails(thread.id);
    return {
      ...existing,
      ...thread,
      details: detailScore(incomingDetails) >= detailScore(existingDetails) ? incomingDetails : existingDetails,
    };
  });
}

async function loadThread(threadId, { resume = true } = {}) {
  if (!threadId) return null;
  if (state.loadingThreadIds.has(threadId)) {
    return state.threads.find((thread) => thread.id === threadId) || null;
  }
  state.loadingThreadIds.add(threadId);
  try {
    const suffix = resume ? '?resume=1' : '?resume=0';
    const result = await api(`/api/threads/${encodeURIComponent(threadId)}${suffix}`);
    if (result.thread) {
      upsertThreadLocal(result.thread);
      return result.thread;
    }
    return null;
  } finally {
    state.loadingThreadIds.delete(threadId);
  }
}

async function hydrateThreadSummariesInBackground({ limit = 24 } = {}) {
  if (state.hydratingThreadSummaries) return;
  const candidates = state.threads
    .filter((thread) => threadNeedsSummaryHydration(thread) && !state.loadingThreadIds.has(thread.id))
    .slice(0, limit);
  if (!candidates.length) return;

  state.hydratingThreadSummaries = true;
  try {
    for (const thread of candidates) {
      try {
        await loadThread(thread.id, { resume: false });
        render();
      } catch {
        // ignore hydration failures for background loading
      }
    }
  } finally {
    state.hydratingThreadSummaries = false;
  }
}

function getSelectedThread() {
  return state.threads.find((thread) => thread.id === state.selectedThreadId) || null;
}

function getSelectedRequest() {
  return state.rawRequests.find((entry) => entry.id === state.selectedRequestId) || state.rawRequests[0] || null;
}

function sortedRequests() {
  return [...state.rawRequests].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

function sortedInterceptedLogs() {
  return [...state.interceptedLogs].sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
}

function getSelectedInterceptedLog() {
  const entries = sortedInterceptedLogs();
  return entries.find((entry) => entry.id === state.selectedInterceptedLogId) || entries[0] || null;
}

function sortedMessages(thread) {
  return [...(thread?.details?.messages || [])].sort((a, b) => new Date(a.createdAt || a.updatedAt || 0).getTime() - new Date(b.createdAt || b.updatedAt || 0).getTime());
}

function isThreadBusy(thread) {
  if (!thread) return false;
  if (thread.isBusy === true) return true;
  if (thread.isBusy === false) return false;
  const status = String(thread.status || '').toLowerCase();
  if (
    status === 'idle'
    || status === 'completed'
    || status === 'ready'
    || status === 'done'
    || status === 'failed'
    || status === 'cancelled'
    || status === 'canceled'
    || status === 'interrupted'
    || status === 'error'
  ) {
    return false;
  }
  if (
    status.includes('progress')
    || status.includes('running')
    || status.includes('active')
    || status.includes('stream')
    || status === 'busy'
  ) {
    return true;
  }
  const events = thread.details?.events || [];
  let lastTurnSignal = null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const kind = String(events[index]?.kind || '');
    if (
      kind === 'turn_started'
      || kind === 'turn/completed'
      || kind === 'turn/failed'
      || kind === 'turn/cancelled'
      || kind === 'turn/interrupted'
    ) {
      lastTurnSignal = kind;
      break;
    }
  }
  return lastTurnSignal === 'turn_started';
}

function getSelectedBusyThread() {
  const selected = getSelectedThread();
  if (!selected) return null;
  return isThreadBusy(selected) ? selected : null;
}

function isThreadInterruptPending(thread) {
  if (!thread) return false;
  const events = thread.details?.events || [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] || {};
    const kind = String(event.kind || '');
    if (kind === 'turn/interrupt_requested') {
      const ts = toTimestampMs(event.timestamp);
      if (!ts) return true;
      return (Date.now() - ts) < 15_000;
    }
    if (
      kind === 'turn/interrupted'
      || kind === 'turn/completed'
      || kind === 'turn/failed'
      || kind === 'turn/cancelled'
      || kind === 'turn_started'
    ) {
      return false;
    }
  }
  return false;
}

function isToolItemType(value) {
  const text = String(value || '').toLowerCase();
  return text.includes('tool') || text.includes('command') || text.includes('mcp');
}

function isToolEvent(event) {
  if (!event) return false;
  const kind = String(event.kind || '').toLowerCase();
  if (kind === 'command' || kind === 'tool_event') return true;
  if ((kind === 'item_started' || kind === 'item_completed') && isToolItemType(event.itemType)) return true;
  if (kind === 'item_loaded' && isToolItemType(event.itemType)) return true;
  if (kind.startsWith('item/') && (kind.includes('/tool/') || kind.includes('/commandexecution/') || kind.includes('/mcp'))) return true;
  return false;
}

function isApprovalLikeToolMethod(method = '') {
  const normalized = normalizeMethodText(method);
  if (!normalized) return false;
  return (
    normalized.includes('requestapproval')
    || normalized.includes('requestuserinput')
    || normalized.includes('elicitation/request')
  );
}

function isToolEventDisplayable(event) {
  if (!isToolEvent(event)) return false;
  const kind = String(event.kind || '').toLowerCase();
  if (kind === 'command') return true;
  if (kind === 'item_started' || kind === 'item_completed') return true;
  if (kind === 'item_loaded') return true;
  if (kind !== 'tool_event') return true;
  const method = String(event.method || '');
  return !isApprovalLikeToolMethod(method);
}

function toolCardKeyFromEvent(event = {}) {
  const turnKey = String(event.turnId || '-');
  if (event.itemId || event.callId) return `${turnKey}:${event.itemId || event.callId}`;
  return `${turnKey}:${event.kind || 'tool'}:${event.method || '-'}:${event.timestamp || event.id || '-'}`;
}

function toolCardKeyFromCommand(entry = {}) {
  const turnKey = String(entry.turnId || '-');
  return `${turnKey}:${entry.itemId || entry.callId || 'command'}`;
}

function statusLabelFromCommand(entry = {}) {
  const raw = String(entry.status || '').toLowerCase();
  if (entry.exitCode != null) return `已结束(${entry.exitCode})`;
  if (!raw) return '';
  if (raw.includes('progress') || raw.includes('running') || raw.includes('active') || raw.includes('stream')) return '运行中';
  if (raw.includes('fail') || raw.includes('error')) return '失败';
  if (raw.includes('cancel') || raw.includes('interrupt')) return '已中断';
  if (raw.includes('complete') || raw.includes('done') || raw.includes('success') || raw.includes('finish')) return '已完成';
  return entry.status;
}

function buildToolActivityCards(thread) {
  const events = (thread?.details?.events || []).filter((event) => isToolEventDisplayable(event));
  const cards = new Map();
  for (const event of events) {
    const key = toolCardKeyFromEvent(event);
    const current = cards.get(key) || {
      id: key,
      title: event.itemType ? `工具 ${event.itemType}` : '工具调用',
      status: '运行中',
      updatedAt: event.timestamp || new Date().toISOString(),
      output: '',
      method: event.method || null,
      command: event.command || null,
      done: false,
    };

    if (event.kind === 'item_started') {
      current.title = event.itemType ? `工具 ${event.itemType}` : current.title;
      current.status = '运行中';
      if (event.command) current.command = event.command;
      current.done = false;
    } else if (event.kind === 'item_completed') {
      current.title = event.itemType ? `工具 ${event.itemType}` : current.title;
      current.status = '已完成';
      if (event.command) current.command = event.command;
      current.done = true;
    } else if (event.kind === 'command') {
      current.title = '命令执行';
      current.status = '运行中';
      if (event.command) current.command = event.command;
      current.output = event.output || `${current.output}${event.delta || ''}`;
      current.done = false;
    } else if (event.kind === 'tool_event') {
      const method = String(event.method || '');
      current.title = method || current.title;
      current.method = method;
      if (event.command) current.command = event.command;
      current.status = '运行中';
      current.done = false;
      if (typeof event.delta === 'string') {
        current.output = `${current.output}${event.delta}`;
      }
    } else if (event.kind === 'item_loaded') {
      current.title = event.itemType ? `工具 ${event.itemType}` : current.title;
      current.status = '已记录';
      current.done = false;
    } else {
      current.title = event.kind || current.title;
    }

    current.updatedAt = event.timestamp || current.updatedAt;
    cards.set(key, current);
  }

  const commandLog = thread?.details?.commandLog || [];
  for (const commandEntry of commandLog) {
    const key = toolCardKeyFromCommand(commandEntry);
    const current = cards.get(key) || {
      id: key,
      title: '命令执行',
      status: '运行中',
      updatedAt: commandEntry.updatedAt || new Date().toISOString(),
      output: '',
      method: commandEntry.command || null,
      command: commandEntry.command || null,
      done: false,
    };
    current.title = '命令执行';
    current.command = commandEntry.command || current.command;
    if (!current.method && commandEntry.command) current.method = commandEntry.command;
    if (typeof commandEntry.output === 'string' && commandEntry.output.length >= current.output.length) {
      current.output = commandEntry.output;
    }
    const statusLabel = statusLabelFromCommand(commandEntry);
    if (statusLabel) current.status = statusLabel;
    if (commandEntry.exitCode != null) current.done = true;
    if (statusLabel && statusLabel !== '运行中' && statusLabel !== '已记录') current.done = true;
    current.updatedAt = commandEntry.updatedAt || current.updatedAt;
    cards.set(key, current);
  }

  return [...cards.values()]
    .sort((left, right) => new Date(left.updatedAt || 0).getTime() - new Date(right.updatedAt || 0).getTime())
    .slice(-24);
}

function buildToolFallbackEntries(thread) {
  const events = (thread?.details?.events || []).filter((event) => isToolEventDisplayable(event)).slice(-80);
  return events.map((event, index) => ({
    id: `${event.threadId || ''}:${event.turnId || ''}:${event.itemId || event.callId || index}:${event.kind || 'tool'}`,
    title: event.method || event.itemType || event.kind || '工具调用',
    status: event.kind === 'item_completed' ? '已完成' : '运行中',
    updatedAt: event.timestamp || new Date().toISOString(),
    output: event.output || event.delta || '',
    method: event.method || null,
    command: event.command || null,
    done: event.kind === 'item_completed',
  }));
}

function buildConversationFeed(thread) {
  const fallbackTs = toTimestampMs(thread?.updatedAt) || Date.now();
  const messages = sortedMessages(thread)
    .filter((message) => {
      if (!message) return false;
      if (message.role === 'reasoning') return Boolean(normalizeThinkingText(message.text || message.summaryText || ''));
      return Boolean(String(message.text || '').trim());
    })
    .map((message) => ({
    type: 'message',
    timestamp: toTimestampMs(message.createdAt || message.updatedAt) || fallbackTs,
    item: message,
    }));
  const toolCards = buildToolActivityCards(thread);
  const effectiveTools = toolCards.length > 0 ? toolCards : buildToolFallbackEntries(thread);
  const tools = effectiveTools.map((card) => ({
    type: 'tool',
    timestamp: toTimestampMs(card.updatedAt) || fallbackTs,
    item: card,
  }));
  return [...messages, ...tools].sort((left, right) => left.timestamp - right.timestamp);
}

function firstUserMessageText(thread) {
  const firstUser = sortedMessages(thread).find((entry) => entry.role === 'user' && entry.text);
  return firstUser?.text || thread?.raw?.preview || '';
}

function compactTextPreview(value = '', max = 10) {
  const text = String(value || '').trim();
  if (!text) return '—';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function threadConversationCount(thread) {
  return (thread?.details?.messages || []).filter((entry) => entry.role !== 'reasoning').length;
}

function threadCardMeta(thread) {
  return `${formatRelative(thread?.updatedAt)} · ${threadConversationCount(thread)}条 · ${compactTextPreview(firstUserMessageText(thread), 10)}`;
}

function summaryStats() {
  const selected = getSelectedThread();
  const requestList = sortedRequests();
  return {
    threadCount: state.threads.length,
    approvalCount: state.approvals.filter((item) => item.status === 'pending').length,
    requestCount: requestList.length,
    messageCount: selected?.details?.messages?.filter((entry) => entry.role !== 'reasoning').length || 0,
  };
}

function toTimestampMs(value) {
  if (!value) return 0;
  const numeric = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function getAskUserDraft(approvalId, questionId) {
  return state.askUserDraft?.[approvalId]?.[questionId] || '';
}

function setAskUserDraft(approvalId, questionId, value) {
  state.askUserDraft[approvalId] = {
    ...(state.askUserDraft[approvalId] || {}),
    [questionId]: value,
  };
}

function clearAskUserDraft(approvalId) {
  if (!approvalId) return;
  delete state.askUserDraft[approvalId];
}

function normalizeMethodText(value = '') {
  return String(value || '')
    .trim()
    .replaceAll('.', '/')
    .replaceAll('-', '/')
    .toLowerCase();
}

function canonicalApprovalMethod(value = '') {
  const normalized = normalizeMethodText(value);
  if (!normalized) return '';
  if (
    normalized === 'item/tool/requestuserinput'
    || normalized === 'requestuserinput'
    || normalized === 'request_user_input'
    || normalized === 'request/user/input'
  ) {
    return 'item/tool/requestUserInput';
  }
  if (
    normalized === 'mcpserver/elicitation/request'
    || normalized === 'elicitation_request'
    || normalized === 'elicitation/request'
  ) {
    return 'mcpServer/elicitation/request';
  }
  if (
    normalized === 'item/commandexecution/requestapproval'
    || normalized === 'execcommandapproval'
    || normalized === 'exec_approval_request'
  ) {
    return 'item/commandExecution/requestApproval';
  }
  if (
    normalized === 'item/filechange/requestapproval'
    || normalized === 'applypatchapproval'
    || normalized === 'apply_patch_approval_request'
    || normalized === 'file_change_approval_request'
  ) {
    return 'item/fileChange/requestApproval';
  }
  return String(value || '');
}

function isAskUserMethod(method = '') {
  return canonicalApprovalMethod(method) === 'item/tool/requestUserInput';
}

function isMcpElicitationMethod(method = '') {
  return canonicalApprovalMethod(method) === 'mcpServer/elicitation/request';
}

function isCommandApprovalMethod(method = '') {
  return canonicalApprovalMethod(method) === 'item/commandExecution/requestApproval';
}

function isFileApprovalMethod(method = '') {
  return canonicalApprovalMethod(method) === 'item/fileChange/requestApproval';
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function normalizeQuestionOption(option) {
  if (typeof option === 'string') {
    return { label: option, description: '' };
  }
  if (!option || typeof option !== 'object') return null;
  const label = String(option.label || option.value || option.title || '').trim();
  if (!label) return null;
  return {
    ...option,
    label,
    description: String(option.description || '').trim(),
  };
}

function normalizeAskUserQuestion(question, index) {
  const questionId = firstDefined(question?.id, question?.key, `question_${index + 1}`);
  return {
    ...question,
    id: String(questionId || `question_${index + 1}`),
    header: String(question?.header || question?.title || questionId || `问题 ${index + 1}`),
    question: String(question?.question || question?.text || question?.prompt || '').trim(),
    options: (Array.isArray(question?.options) ? question.options : [])
      .map((option) => normalizeQuestionOption(option))
      .filter(Boolean),
  };
}

function normalizeAskUserParams(raw = {}) {
  const params = (raw && typeof raw === 'object') ? { ...raw } : {};
  const questions = Array.isArray(params.questions) ? params.questions : [];
  return {
    ...params,
    threadId: firstDefined(params.threadId, params.thread_id, params.conversationId, params.conversation_id),
    turnId: firstDefined(params.turnId, params.turn_id),
    itemId: firstDefined(params.itemId, params.item_id, params.callId, params.call_id),
    questions: questions.map((question, index) => normalizeAskUserQuestion(question, index)),
  };
}

function normalizeApprovalParams(method, raw = {}) {
  const params = (raw && typeof raw === 'object') ? { ...raw } : {};
  if (isAskUserMethod(method)) return normalizeAskUserParams(params);

  return {
    ...params,
    threadId: firstDefined(params.threadId, params.thread_id, params.conversationId, params.conversation_id),
    turnId: firstDefined(params.turnId, params.turn_id),
    itemId: firstDefined(params.itemId, params.item_id, params.callId, params.call_id),
  };
}

function extractThreadIdFromParams(params = {}) {
  if (!params || typeof params !== 'object') return null;
  return firstDefined(
    params.threadId,
    params.thread_id,
    params.conversationId,
    params.conversation_id,
    params.thread?.id,
    params.context?.threadId,
    params.context?.thread_id,
    params.data?.threadId,
    params.data?.thread_id,
  );
}

function extractTurnIdFromParams(params = {}) {
  if (!params || typeof params !== 'object') return null;
  return firstDefined(
    params.turnId,
    params.turn_id,
    params.context?.turnId,
    params.context?.turn_id,
    params.data?.turnId,
    params.data?.turn_id,
  );
}

function normalizeApprovalRecord(approval = {}) {
  if (!approval || typeof approval !== 'object') return null;
  const methodRaw = String(approval.method || approval.type || approval.kind || '');
  const method = canonicalApprovalMethod(methodRaw);
  const params = normalizeApprovalParams(method, approval.params || {});
  const threadId = firstDefined(
    approval.threadId,
    approval.thread_id,
    approval.conversationId,
    approval.conversation_id,
    extractThreadIdFromParams(params),
  );
  const turnId = firstDefined(
    approval.turnId,
    approval.turn_id,
    extractTurnIdFromParams(params),
  );
  return {
    ...approval,
    methodRaw,
    method,
    params,
    threadId: threadId || null,
    turnId: turnId || null,
    status: approval.status || 'pending',
  };
}

function normalizeApprovals(list = []) {
  return list
    .map((item) => normalizeApprovalRecord(item))
    .filter(Boolean);
}

function getApprovalById(approvalId) {
  return state.approvals.find((item) => item.id === approvalId) || null;
}

function parseBodyMaybe(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value === 'object') return value;
  return null;
}

function parseEventStreamPayloads(text) {
  const payloads = [];
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const body = line.slice(5).trim();
    if (!body || body === '[DONE]') continue;
    const parsed = parseBodyMaybe(body);
    if (parsed) payloads.push(parsed);
  }
  return payloads;
}

function parseJsonLinesPayloads(text) {
  const payloads = [];
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line || (!line.startsWith('{') && !line.startsWith('['))) continue;
    const parsed = parseBodyMaybe(line);
    if (parsed) payloads.push(parsed);
  }
  return payloads;
}

function parsePossiblePayloads(value) {
  if (value == null) return [];
  if (typeof value === 'object') return [value];
  if (typeof value !== 'string') return [];

  const payloads = [];
  const direct = parseBodyMaybe(value);
  if (direct) payloads.push(direct);
  payloads.push(...parseEventStreamPayloads(value));
  payloads.push(...parseJsonLinesPayloads(value));
  return payloads;
}

function extractThreadIdFromSignal(signal, fallback = null) {
  const params = signal?.params || {};
  return firstDefined(
    params.threadId,
    params.thread_id,
    signal?.threadId,
    signal?.thread_id,
    params.conversationId,
    params.conversation_id,
    signal?.conversationId,
    signal?.conversation_id,
    fallback,
  );
}

function extractTurnIdFromSignal(signal, fallback = null) {
  const params = signal?.params || {};
  return firstDefined(
    params.turnId,
    params.turn_id,
    signal?.turnId,
    signal?.turn_id,
    fallback,
  );
}

function findInteractionSignal(value, depth = 0) {
  if (!value || depth > 8) return null;
  if (typeof value === 'string') {
    for (const payload of parsePossiblePayloads(value)) {
      const found = findInteractionSignal(payload, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findInteractionSignal(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;

  const method = canonicalApprovalMethod(value.method || value.type || value.kind || value.event || value.name || '');
  const params = normalizeApprovalParams(method, value.params || value);
  if (isAskUserMethod(method) && Array.isArray(params.questions) && params.questions.length > 0) {
    return {
      method,
      params,
      threadId: extractThreadIdFromSignal({ ...value, params }, null),
      turnId: extractTurnIdFromSignal({ ...value, params }, null),
    };
  }
  if (isCommandApprovalMethod(method) || isFileApprovalMethod(method) || isMcpElicitationMethod(method)) {
    return {
      method,
      params,
      threadId: extractThreadIdFromSignal({ ...value, params }, null),
      turnId: extractTurnIdFromSignal({ ...value, params }, null),
    };
  }

  for (const key of Object.keys(value)) {
    const found = findInteractionSignal(value[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function requestMentionsThread(entry, threadId) {
  if (!threadId) return true;
  const haystacks = [
    entry?.request?.url,
    typeof entry?.request?.body === 'string' ? entry.request.body : JSON.stringify(entry?.request?.body || ''),
    typeof entry?.response?.body === 'string' ? entry.response.body : JSON.stringify(entry?.response?.body || ''),
  ];
  return haystacks.some((part) => String(part || '').includes(threadId));
}

function detectInteractionFromRawRequests(threadId) {
  const now = Date.now();
  const freshnessWindowMs = 5 * 60 * 1000;
  for (const entry of sortedRequests()) {
    const timestampMs = toTimestampMs(entry.timestamp);
    if (timestampMs && (now - timestampMs) > freshnessWindowMs) {
      break;
    }

    const requestSignal = findInteractionSignal(entry.request?.body);
    const responseSignal = findInteractionSignal(entry.response?.body);
    const signal = requestSignal || responseSignal;
    if (!signal) continue;

    const signalThreadId = extractThreadIdFromSignal(signal, null);
    if (threadId && signalThreadId && signalThreadId !== threadId) continue;
    if (threadId && !signalThreadId && !requestMentionsThread(entry, threadId)) continue;

    return {
      source: 'network',
      method: signal.method,
      params: signal.params,
      threadId: signalThreadId || threadId || null,
      turnId: extractTurnIdFromSignal(signal, null),
      requestId: entry.id,
      timestamp: entry.timestamp,
    };
  }
  return null;
}

function latestResolvedApprovalAt(threadId, method = '') {
  return state.approvals
    .filter((item) => (!method || item.method === method) && item.status !== 'pending')
    .filter((item) => !threadId || !item.threadId || item.threadId === threadId)
    .reduce((max, item) => Math.max(max, toTimestampMs(item.resolvedAt || item.createdAt)), 0);
}

function pendingApprovalsForSelectedThread() {
  const selectedThread = getSelectedThread();
  const selectedThreadId = selectedThread?.id || state.selectedThreadId || null;
  if (!selectedThreadId) return [];
  return state.approvals
    .filter((item) => item.status === 'pending')
    .filter((item) => {
      if (!item.threadId) return Boolean(selectedThread && isThreadBusy(selectedThread));
      return item.threadId === selectedThreadId;
    })
    .sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());
}

function getLatestToolApprovalEvent(thread) {
  const events = thread?.details?.events || [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (String(event?.kind || '') !== 'tool_event') continue;
    const method = canonicalApprovalMethod(event?.method || '');
    if (!isCommandApprovalMethod(method) && !isFileApprovalMethod(method)) continue;
    return event;
  }
  return null;
}

function getActiveInteractionContext() {
  const selectedThread = getSelectedThread();
  const selectedThreadId = selectedThread?.id || state.selectedThreadId || null;
  if (!selectedThreadId) return null;
  const pendingApprovals = pendingApprovalsForSelectedThread();

  const networkSignal = detectInteractionFromRawRequests(selectedThreadId);
  if (pendingApprovals.length > 0) {
    return {
      source: 'approval',
      approval: pendingApprovals[0],
      detectedFromNetwork: Boolean(networkSignal),
    };
  }
  if (!networkSignal) return null;
  if (!isAskUserMethod(networkSignal.method)) return null;
  if (!isThreadBusy(selectedThread)) return null;

  const signalTs = toTimestampMs(networkSignal.timestamp);
  const resolvedTs = latestResolvedApprovalAt(selectedThreadId, networkSignal.method);
  if (resolvedTs && signalTs && signalTs <= resolvedTs) return null;
  if (signalTs && (Date.now() - signalTs) > 90 * 1000) return null;
  return {
    source: 'network',
    signal: networkSignal,
  };
}

function getToolEventApprovalFallbackContext() {
  const selectedThread = getSelectedThread();
  if (!selectedThread || !isThreadBusy(selectedThread)) return null;
  const fallbackEvent = getLatestToolApprovalEvent(selectedThread);
  if (!fallbackEvent) return null;
  const eventTs = toTimestampMs(fallbackEvent.timestamp);
  if (eventTs && (Date.now() - eventTs) > 5 * 60 * 1000) return null;
  return {
    source: 'tool_event',
    event: fallbackEvent,
  };
}

function getCurrentInteractionContext() {
  const primary = getActiveInteractionContext();
  if (primary) return primary;
  return getToolEventApprovalFallbackContext();
}

function describeToolApprovalFallbackEvent(event = {}) {
  const method = canonicalApprovalMethod(event?.method || '');
  const params = event?.params && typeof event.params === 'object' ? event.params : {};
  const command = firstDefined(
    params.command,
    params.commandLine,
    params.command_line,
    params.cmd,
    params.patch,
  );
  const reason = firstDefined(
    params.reason,
    params.message,
    params.prompt,
    params.explanation,
  );
  const availableDecisions = Array.isArray(params.availableDecisions)
    ? params.availableDecisions
    : (Array.isArray(params.actions) ? params.actions : []);
  return {
    method,
    command: command ? String(command) : '',
    reason: reason ? String(reason) : '',
    availableDecisions: availableDecisions
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object') {
          return String(entry.decision || entry.name || entry.label || entry.action || '').trim();
        }
        return '';
      })
      .filter(Boolean),
  };
}

function pruneAskUserDrafts() {
  const pendingIds = new Set(
    state.approvals
      .filter((item) => item.status === 'pending' && isAskUserMethod(item.method))
      .map((item) => item.id),
  );
  for (const approvalId of Object.keys(state.askUserDraft || {})) {
    if (!pendingIds.has(approvalId)) {
      clearAskUserDraft(approvalId);
    }
  }
}

function focusConversationForAskUser() {
  const context = getCurrentInteractionContext();
  if (!context) return;
  if (state.tab !== 'conversation') setActiveTab('conversation');
  state.scrollIntent.conversation = true;
}

function ensureThreadLocal(threadId) {
  let thread = state.threads.find((entry) => entry.id === threadId);
  if (!thread) {
    thread = {
      id: threadId,
      title: 'Untitled thread',
      status: 'idle',
      cwd: null,
      updatedAt: new Date().toISOString(),
      metadata: null,
      raw: {},
      details: createDetails(threadId),
    };
    state.threads.unshift(thread);
  }
  if (!thread.details) thread.details = createDetails(threadId);
  return thread;
}

function ensureMessageLocal(thread, { threadId, turnId, itemId, role }) {
  let message = thread.details.messages.find((entry) => entry.turnId === turnId && entry.itemId === itemId && entry.role === role);
  if (!message) {
    message = {
      id: `${threadId}:${turnId}:${itemId}:${role}`,
      role,
      threadId,
      turnId,
      itemId,
      text: '',
      summaryText: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'streaming',
    };
    thread.details.messages.push(message);
  }
  return message;
}

function addOptimisticUserMessage(threadId, prompt) {
  if (!threadId || !prompt) return;
  const thread = ensureThreadLocal(threadId);
  const timestamp = new Date().toISOString();
  const recentExisting = [...(thread.details.messages || [])]
    .reverse()
    .find((entry) => entry.role === 'user' && entry.text === prompt && (Date.now() - new Date(entry.updatedAt || entry.createdAt || 0).getTime()) < 15000);
  if (recentExisting) return;

  const tempTurnId = `optimistic-turn-${Date.now()}`;
  const tempItemId = `optimistic-user-${Date.now()}`;
  thread.details.messages.push({
    id: `${threadId}:${tempTurnId}:${tempItemId}:user`,
    role: 'user',
    threadId,
    turnId: tempTurnId,
    itemId: tempItemId,
    text: prompt,
    summaryText: '',
    createdAt: timestamp,
    updatedAt: timestamp,
    status: 'completed',
    optimistic: true,
  });
  thread.updatedAt = timestamp;
}

function findMatchingOptimisticUserMessage(thread, text) {
  if (!thread || !text) return null;
  return [...(thread.details.messages || [])]
    .reverse()
    .find((entry) => entry.role === 'user' && entry.optimistic && entry.text === text && (Date.now() - new Date(entry.updatedAt || entry.createdAt || 0).getTime()) < 30000) || null;
}

function upsertThreadLocal(threadPatch) {
  if (!threadPatch?.id) return;
  const existing = state.threads.find((entry) => entry.id === threadPatch.id);
  if (!existing) {
    state.threads.unshift({
      ...threadPatch,
      details: threadPatch.details || createDetails(threadPatch.id),
    });
    return;
  }
  const existingDetails = existing.details || createDetails(threadPatch.id);
  const incomingDetails = threadPatch.details || createDetails(threadPatch.id);
  const details = detailScore(incomingDetails) >= detailScore(existingDetails) ? incomingDetails : existingDetails;
  Object.assign(existing, threadPatch, { details });
}

function pushThreadEventLocal(entry) {
  if (!entry?.threadId) return;
  const thread = ensureThreadLocal(entry.threadId);
  thread.updatedAt = entry.timestamp || new Date().toISOString();
  thread.details.events.push(entry);
  if (thread.details.events.length > 500) thread.details.events = thread.details.events.slice(-500);

  if (entry.kind === 'assistant_delta') {
    const message = ensureMessageLocal(thread, { threadId: entry.threadId, turnId: entry.turnId, itemId: entry.itemId, role: 'assistant' });
    message.text = entry.text || `${message.text}${entry.delta || ''}`;
    message.updatedAt = entry.timestamp || new Date().toISOString();
  }

  if (entry.kind === 'reasoning_delta') {
    const message = ensureMessageLocal(thread, { threadId: entry.threadId, turnId: entry.turnId, itemId: entry.itemId, role: 'reasoning' });
    if (message.lastContentIndex != null && message.lastContentIndex !== entry.contentIndex && message.text) {
      message.text += '\n';
    }
    message.lastContentIndex = entry.contentIndex;
    message.text += entry.delta || '';
    message.updatedAt = entry.timestamp || new Date().toISOString();
  }

  if (entry.kind === 'reasoning_summary_part') {
    const message = ensureMessageLocal(thread, { threadId: entry.threadId, turnId: entry.turnId, itemId: entry.itemId, role: 'reasoning' });
    if (message.summaryText) message.summaryText += '\n';
    message.lastSummaryIndex = entry.summaryIndex;
    message.updatedAt = entry.timestamp || new Date().toISOString();
  }

  if (entry.kind === 'reasoning_summary_delta') {
    const message = ensureMessageLocal(thread, { threadId: entry.threadId, turnId: entry.turnId, itemId: entry.itemId, role: 'reasoning' });
    if (message.lastSummaryIndex != null && message.lastSummaryIndex !== entry.summaryIndex && message.summaryText) {
      message.summaryText += '\n';
    }
    message.lastSummaryIndex = entry.summaryIndex;
    message.summaryText += entry.delta || '';
    message.updatedAt = entry.timestamp || new Date().toISOString();
  }

  if (entry.kind === 'item_started' && entry.itemType === 'reasoning') {
    ensureMessageLocal(thread, { threadId: entry.threadId, turnId: entry.turnId, itemId: entry.itemId, role: 'reasoning' });
  }

  if (entry.kind === 'item_started' && entry.itemType === 'agentMessage') {
    ensureMessageLocal(thread, { threadId: entry.threadId, turnId: entry.turnId, itemId: entry.itemId, role: 'assistant' });
  }

  if (entry.kind === 'item_started' && entry.itemType === 'userMessage') {
    const text = entry.text || '';
    const exists = thread.details.messages.find((msg) => msg.turnId === entry.turnId && msg.itemId === entry.itemId && msg.role === 'user');
    if (exists) {
      if (text && !exists.text) exists.text = text;
      exists.updatedAt = entry.timestamp || new Date().toISOString();
      exists.optimistic = false;
      return;
    }

    const optimistic = findMatchingOptimisticUserMessage(thread, text);
    if (optimistic) {
      optimistic.id = `${entry.threadId}:${entry.turnId}:${entry.itemId}:user`;
      optimistic.turnId = entry.turnId;
      optimistic.itemId = entry.itemId;
      optimistic.updatedAt = entry.timestamp || new Date().toISOString();
      optimistic.status = 'completed';
      optimistic.optimistic = false;
      return;
    }

    if (!text) return;

    thread.details.messages.push({
      id: `${entry.threadId}:${entry.turnId}:${entry.itemId}:user`,
      role: 'user',
      threadId: entry.threadId,
      turnId: entry.turnId,
      itemId: entry.itemId,
      text,
      summaryText: '',
      createdAt: entry.timestamp || new Date().toISOString(),
      updatedAt: entry.timestamp || new Date().toISOString(),
      status: 'completed',
      optimistic: false,
    });
  }

  if (entry.kind === 'item_completed') {
    const message = thread.details.messages.find((msg) => msg.turnId === entry.turnId && msg.itemId === entry.itemId);
    if (message) {
      message.status = 'completed';
      message.updatedAt = entry.timestamp || new Date().toISOString();
    }
  }

  if (entry.kind === 'command') {
    let command = thread.details.commandLog.find((log) => log.itemId === entry.itemId);
    if (!command) {
      command = {
        itemId: entry.itemId,
        turnId: entry.turnId,
        threadId: entry.threadId,
        callId: entry.callId,
        command: entry.command || '',
        status: entry.status || null,
        exitCode: entry.exitCode ?? null,
        output: '',
        updatedAt: entry.timestamp || new Date().toISOString(),
      };
      thread.details.commandLog.push(command);
    }
    if (entry.command) command.command = entry.command;
    if (entry.status != null) command.status = entry.status;
    if (entry.exitCode != null) command.exitCode = entry.exitCode;
    command.output = entry.output || `${command.output}${entry.delta || ''}`;
    command.updatedAt = entry.timestamp || new Date().toISOString();
  }

  if (entry.kind === 'plan') {
    thread.details.planLog.push(entry);
    if (thread.details.planLog.length > 200) thread.details.planLog = thread.details.planLog.slice(-200);
  }
}

function applyEvent(event) {
  if (!event) return;
  if (event.type === 'thread.updated') {
    upsertThreadLocal(event.payload);
    return;
  }
  if (event.type === 'thread.event') {
    pushThreadEventLocal(event.payload);
    return;
  }
  if (event.type === 'thread.removed') {
    const threadId = event.payload?.threadId;
    if (!threadId) return;
    state.threads = state.threads.filter((item) => item.id !== threadId);
    state.approvals = state.approvals.filter((item) => item.threadId !== threadId);
    if (state.selectedThreadId === threadId) {
      setSelectedThread(state.threads[0]?.id || null);
    }
    return;
  }
  if (event.type === 'approval.pending') {
    const normalized = normalizeApprovalRecord(event.payload);
    if (!normalized) return;
    state.approvals = [normalized, ...state.approvals.filter((item) => item.id !== normalized.id)];
    if (normalized.status === 'pending') {
      setActiveTab('conversation');
      state.scrollIntent.conversation = true;
    }
    pruneAskUserDrafts();
    return;
  }
  if (event.type === 'approval.resolved') {
    const normalized = normalizeApprovalRecord(event.payload);
    if (!normalized) return;
    let replaced = false;
    state.approvals = state.approvals.map((item) => {
      if (item.id !== normalized.id) return item;
      replaced = true;
      return normalized;
    });
    if (!replaced) {
      state.approvals = [normalized, ...state.approvals];
    }
    clearAskUserDraft(normalized.id);
    pruneAskUserDrafts();
    return;
  }
  if (event.type === 'system.status') {
    if (state.session) {
      state.session.status = {
        ...state.session.status,
        [event.payload.name]: event.payload.value,
      };
    }
    return;
  }
  if (event.type === 'system.writerChanged') {
    if (state.session) {
      state.session.writerSessionId = event.payload.sessionId;
      if (state.session.sessionId) {
        state.session.viewerRole = state.session.sessionId === event.payload.sessionId ? 'controller' : 'viewer';
      }
    }
    return;
  }
  if (event.type === 'diagnostic') {
    state.errorLogs = [
      ...state.errorLogs,
      {
        timestamp: event.timestamp || new Date().toISOString(),
        level: 'DIAG',
        message: event.payload?.text || '',
        raw: event.payload?.text || '',
      },
    ].slice(-600);
  }
}

function compactText(text = '', max = 120) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function timelineSummary(event) {
  switch (event.kind) {
    case 'turn_started':
      return { title: '任务开始', body: 'Codex 开始处理新的轮次。' };
    case 'assistant_delta':
      return { title: '助手流式输出', body: compactText(event.delta || event.text || '') };
    case 'reasoning_delta':
      return { title: '思考过程', body: compactText(event.delta || '') };
    case 'reasoning_summary_delta':
      return { title: '思考摘要', body: compactText(event.delta || '') };
    case 'item_started':
      return { title: event.label || '步骤开始', body: event.itemType ? `类型：${event.itemType}` : '' };
    case 'item_completed':
      return { title: event.label || '步骤完成', body: event.itemType ? `类型：${event.itemType}` : '' };
    case 'command':
      return { title: '命令输出', body: compactText(event.delta || event.output || '') };
    case 'tool_event':
      return { title: '工具事件', body: compactText(`${event.method || ''} ${event.delta || ''}`.trim()) };
    case 'file_change':
      return {
        title: '文件变更',
        body: event.count ? `已修改 ${event.count} 个文件` : '检测到文件改动',
      };
    case 'plan':
      return { title: '计划更新', body: compactText(event.delta || '') };
    case 'thread/status/changed':
      return { title: '会话状态', body: `状态：${statusText(event.status)}` };
    case 'turn/completed':
      return { title: '任务完成', body: 'Codex 已完成当前轮次。' };
    case 'turn/failed':
      return { title: '任务失败', body: compactText(event.error?.message || event.message || '轮次执行失败') };
    case 'turn/cancelled':
    case 'turn/interrupted':
      return { title: '任务中断', body: `状态：${event.kind}` };
    case 'turn/interrupt_requested':
      return { title: '已发起中断', body: '已向 Codex 发送中断请求，等待线程状态回落。' };
    case 'thread/tokenUsage/updated':
      return { title: 'Token 用量', body: `输出：${event.tokenUsage?.last?.outputTokens ?? 0}，输入：${event.tokenUsage?.last?.inputTokens ?? 0}` };
    default:
      return { title: event.kind || '事件', body: compactText(JSON.stringify(event)) };
  }
}

function renderPairing() {
  const app = document.querySelector('#app');
  app.innerHTML = h`
    <div class="page">
      <div class="header">
        <div class="brand">
          <div class="brandLogo">CV</div>
          <div class="brandMeta">
            <h1>Codex Viewer</h1>
            <p>Codex CLI 远程控制与请求监控</p>
          </div>
        </div>
      </div>
      <main class="hero">
        <div class="panel">
          <h1>绑定当前浏览器</h1>
          <p>输入一次性配对码，或直接打开 <code>npm run here</code>、<code>./start.sh</code>、<code>node cli.js start</code> 输出的配对链接。</p>
          <div class="inputRow">
            <input id="pair-token" placeholder="请输入配对码" value="${escapeHtml(state.pairToken)}" />
            <button id="pair-submit" class="button primary">开始配对</button>
          </div>
        </div>
        <div class="heroSteps">
          <div class="heroStep"><strong>1. 启动</strong>在目标仓库执行 <code>npm run here</code>。</div>
          <div class="heroStep"><strong>2. 配对</strong>在电脑或手机打开本地/公网链接并完成绑定。</div>
          <div class="heroStep"><strong>3. 控制</strong>发送 prompt、处理审批、查看请求与命令输出。</div>
        </div>
      </main>
    </div>
  `;

  document.querySelector('#pair-submit').onclick = async () => {
    const token = document.querySelector('#pair-token').value.trim();
    try {
      const result = await api('/api/pair/exchange', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
      state.token = result.token;
      localStorage.setItem('codexViewerToken', result.token);
      history.replaceState({}, '', '/');
      await bootstrap();
    } catch (error) {
      alert(error.message);
    }
  };
}

function renderHeader() {
  return h`
    <div class="header">
      <div class="brand">
        <div class="brandLogo">CV</div>
        <div class="brandMeta">
          <h1>Codex Viewer</h1>
          <p>${escapeHtml(state.session.workspacePath || '')}</p>
        </div>
      </div>
      <div class="headerActions">
        <span class="statusBadge ${statusClass(state.session.status.proxy)}">代理：${escapeHtml(statusText(state.session.status.proxy))}</span>
        <span class="statusBadge ${statusClass(state.session.status.appServer)}">app-server：${escapeHtml(statusText(state.session.status.appServer))}</span>
        <span class="statusBadge ${statusClass(state.session.status.web)}">Web：${escapeHtml(statusText(state.session.status.web))}</span>
        <div class="headerControlRow">
          <button id="takeover" class="button secondary headerActionBtn">接管控制</button>
          <button id="refresh" class="button secondary headerActionBtn">刷新</button>
        </div>
      </div>
    </div>
  `;
}

function renderSidebar() {
  const selected = getSelectedThread();
  const interruptPending = selected ? isThreadInterruptPending(selected) : false;
  const interactionContext = selected ? getCurrentInteractionContext() : null;
  const hasStuckInteraction = Boolean(interactionContext && (
    interactionContext.source === 'tool_event'
    || interactionContext.source === 'network'
    || interactionContext.source === 'approval'
  ));
  return h`
    <div class="column sidebar">
      <div class="panel">
        <div class="panelTitle">
          <h2>会话信息</h2>
          <span class="pill">${escapeHtml(viewerRoleLabel(state.session.viewerRole))}</span>
        </div>
        <div class="kv">
          <div class="key">本地地址</div><div><span class="inlineCode">${escapeHtml(state.session.localUrl || '—')}</span></div>
          <div class="key">公网地址</div><div><span class="inlineCode">${escapeHtml(state.session.publicUrl || '—')}</span></div>
          <div class="key">配对链接</div><div><span class="inlineCode">${escapeHtml(state.session.pairUrl || '—')}</span></div>
          <div class="key">写入会话</div><div><span class="inlineCode">${escapeHtml(state.session.writerSessionId || '—')}</span></div>
        </div>
      </div>
      <div class="panel">
        <div class="panelTitle">
          <h2>线程</h2>
          <button id="new-thread" class="button secondary">新建</button>
        </div>
        <div class="panelSubtle">已从 Codex app-server 加载 ${state.threads.length} 个线程</div>
        <div class="scrollArea threadList">
          ${state.threads.map((thread) => h`
            <div class="threadCard ${thread.id === state.selectedThreadId ? 'active' : ''}" data-thread-id="${thread.id}">
              <div class="threadTitle">${escapeHtml(thread.title || '未命名线程')}</div>
              <div class="threadMetaMini" title="${escapeHtml(firstUserMessageText(thread))}">${escapeHtml(threadCardMeta(thread))}</div>
            </div>
          `).join('') || '<div class="emptyState">暂无线程。</div>'}
        </div>
      </div>
      ${selected ? h`
        <div class="panel">
          <div class="panelTitle"><h2>线程信息</h2></div>
          <div class="kv">
            <div class="key">线程 ID</div>
            <div class="threadIdCell">
              <button
                class="threadIdChip"
                title="${escapeHtml(selected.id)}"
                data-copy-thread-id="${escapeHtml(selected.id)}"
              >${escapeHtml(compactId(selected.id))}</button>
            </div>
            <div class="key">更新时间</div><div>${escapeHtml(formatTime(selected.updatedAt))}</div>
            <div class="key">执行状态</div><div>${isThreadBusy(selected) ? '<span class="pill status-starting">执行中</span>' : '<span class="pill status-ready">空闲</span>'}</div>
            <div class="key">消息数</div><div>${selected.details?.messages?.filter((entry) => entry.role !== 'reasoning').length || 0}</div>
            <div class="key">思考数</div><div>${selected.details?.messages?.filter((entry) => entry.role === 'reasoning').length || 0}</div>
          </div>
          <div class="toolbar" style="margin-top: 10px;">
            ${isThreadBusy(selected) ? `<button class="button secondary" data-thread-interrupt="${escapeHtml(selected.id)}" ${interruptPending ? 'disabled' : ''}>${interruptPending ? '中断中…' : '中断该线程'}</button>` : ''}
            ${hasStuckInteraction ? `<button class="button secondary" data-thread-force-clean="${escapeHtml(selected.id)}">强制清理线程</button>` : ''}
            <button class="button danger" data-thread-remove="${escapeHtml(selected.id)}">从列表移除</button>
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

function getPendingApprovalForThread(threadId) {
  if (!threadId) return null;
  const pending = state.approvals
    .filter((item) => item.status === 'pending')
    .filter((item) => item.threadId === threadId)
    .sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());
  return pending[0] || null;
}

function pendingApprovalHint(approval) {
  if (!approval) return '';
  const label = approvalMethodLabel(approval);
  const summary = approvalSummaryText(approval);
  return summary ? `${label}：${summary}` : label;
}

function renderConversation(thread) {
  const feed = buildConversationFeed(thread);
  const busy = isThreadBusy(thread);
  const pendingApproval = getPendingApprovalForThread(thread?.id || null);
  const lastTimestamp = feed.length > 0 ? feed[feed.length - 1].timestamp : null;
  const threadMiniTitle = thread ? escapeHtml(thread.title || compactId(thread.id, 12, 8)) : '未选择线程';
  return h`
    <div class="panel">
      <div class="panelTitle">
        <h2>对话</h2>
      </div>
      ${thread ? `
        <div class="messageList scrollArea">
          <div class="conversationMiniTitle">${threadMiniTitle}</div>
          ${feed.map((entry) => {
            if (entry.type === 'tool') return renderToolCall(entry.item);
            if (entry.item.role === 'reasoning') return renderThinking(entry.item);
            if (isFileChangeMessage(entry.item)) return renderFileChangeMessage(entry.item);
            return renderMessageBlock(entry.item);
          }).join('')}
          ${pendingApproval ? `
            <div class="messageEvent waiting">
              <div class="messageEventMeta">
                <span>等待审批</span>
              </div>
              <div class="waitingRow">
                <span class="dotPulse" aria-hidden="true"></span>
                <span>${escapeHtml(pendingApprovalHint(pendingApproval))}</span>
              </div>
            </div>
          ` : ''}
          ${busy && !pendingApproval ? `
            <div class="messageEvent waiting">
              <div class="messageEventMeta">
                <span>处理中</span>
              </div>
              <div class="waitingRow">
                <span class="dotPulse" aria-hidden="true"></span>
                <span>正在等待最终结果，请勿重复发送。</span>
              </div>
            </div>
          ` : ''}
          ${(!feed.length && !busy) ? '<div class="emptyState">暂无消息。</div>' : ''}
          ${lastTimestamp ? `<div class="conversationTailTime">${escapeHtml(formatTime(lastTimestamp))}</div>` : ''}
        </div>
        ${state.showTimeline ? `
          <div class="detailSection timelineWrap">
            <h4>时间线</h4>
            <div class="timeline">
              ${(thread.details?.events || []).slice(-40).map((event) => {
                const summary = timelineSummary(event);
                return `
                  <div class="timelineCard">
                    <div class="timelineHead">
                      <strong>${escapeHtml(summary.title)}</strong>
                      <span class="panelSubtle">${escapeHtml(formatTime(event.timestamp))}</span>
                    </div>
                    <div class="timelineBody">${escapeHtml(summary.body)}</div>
                  </div>
                `;
              }).join('') || '<div class="emptyState">暂无时间线事件。</div>'}
            </div>
          </div>
        ` : ''}
      ` : '<div class="emptyState">请选择一个线程查看对话。</div>'}
    </div>
  `;
}

function requestTitle(entry) {
  return `${entry.request?.method || 'GET'} ${entry.request?.url || entry.url || '未知地址'}`;
}

function requestPreview(entry) {
  if (entry.type === 'request.connect') return '已建立 CONNECT 隧道；当前模式下无法查看解密后的负载。';
  if (typeof entry.response?.body === 'string') return entry.response.body.slice(0, 120);
  if (entry.response?.body) return JSON.stringify(entry.response.body).slice(0, 120);
  return entry.error || '无响应体';
}

function renderRequests() {
  const requests = sortedRequests();
  const selected = getSelectedRequest();
  const tunnelOnly = requests.length > 0 && requests.every((entry) => String(entry.type).includes('connect'));
  return h`
    <div class="panel">
      <div class="panelTitle">
        <h2>原始请求</h2>
        <span class="panelSubtle">已捕获 ${requests.length} 条</span>
      </div>
      ${tunnelOnly ? '<div class="notice">当前流量走 CONNECT 代理隧道，v1 仅能记录元数据，无法展示解密后的 HTTPS 负载。</div>' : ''}
      <div class="requestStat" style="margin: 12px 0;">
        <div class="statCard"><div class="label">最近请求</div><div class="value">${requests[0] ? escapeHtml(formatRelative(requests[0].timestamp)) : '—'}</div></div>
        <div class="statCard"><div class="label">可见负载</div><div class="value">${requests.filter((entry) => entry.type === 'request.completed').length}</div></div>
      </div>
      <div class="contentSplit">
        <div class="scrollArea requestList">
          ${requests.map((entry) => h`
            <div class="requestCard ${entry.id === state.selectedRequestId ? 'active' : ''}" data-request-id="${entry.id}">
              <div class="requestTitleRow">
                <div class="threadTitle">${escapeHtml(requestTitle(entry))}</div>
                <span class="pill">${escapeHtml(entry.response?.statusCode || entry.type)}</span>
              </div>
              <div class="requestPreview">${escapeHtml(requestPreview(entry))}</div>
              <div class="panelSubtle">${escapeHtml(formatTime(entry.timestamp))} · ${entry.durationMs ?? 0}ms</div>
            </div>
          `).join('') || '<div class="emptyState">暂无捕获请求。</div>'}
        </div>
        <div class="detailPane">
          ${selected ? h`
            <div class="detailSection panelSoft">
              <h4>请求</h4>
              <pre>${escapeHtml(JSON.stringify(selected.request, null, 2))}</pre>
            </div>
            <div class="detailSection panelSoft">
              <h4>响应</h4>
              <pre>${escapeHtml(JSON.stringify(selected.response, null, 2))}</pre>
            </div>
            ${selected.error ? `<div class="detailSection panelSoft"><h4>错误</h4><pre>${escapeHtml(selected.error)}</pre></div>` : ''}
          ` : '<div class="emptyState">请选择一条请求查看详情。</div>'}
        </div>
      </div>
    </div>
  `;
}

function renderApprovalActions(approval) {
  const method = canonicalApprovalMethod(approval.method);
  const params = approval.params || {};
  const readOnly = state.session?.viewerRole !== 'controller';
  const disabled = readOnly ? 'disabled' : '';

  if (isAskUserMethod(method)) {
    return `
      ${(params.questions || []).map((question, index) => {
        const options = Array.isArray(question.options) ? question.options : [];
        const questionId = question.id || question.header || `question_${index + 1}`;
        const selectedValue = getAskUserDraft(approval.id, questionId);
        return `
          <div class="askQuestionCard">
            <div class="panelSubtle">${escapeHtml(question.header || questionId)}</div>
            <div class="askQuestionText">${escapeHtml(question.question || '')}</div>
            ${options.length > 0 ? `
              <div class="askOptionGrid">
                ${options.map((option) => {
                  const optionLabel = option?.label || option?.value || option?.title || '';
                  return `
                    <button
                      class="button secondary askOptionButton ${selectedValue === optionLabel ? 'active' : ''}"
                      data-ask-option="1"
                      data-approval-id="${escapeHtml(approval.id)}"
                      data-question-id="${escapeHtml(questionId)}"
                      data-option-label="${escapeHtml(optionLabel)}"
                      ${disabled}
                    >${escapeHtml(optionLabel)}</button>
                  `;
                }).join('')}
              </div>
            ` : `
              <input
                data-question-id="${escapeHtml(questionId)}"
                data-approval-form="${escapeHtml(approval.id)}"
                value="${escapeHtml(selectedValue)}"
                placeholder="请输入你的回答"
                ${disabled}
              />
            `}
          </div>
        `;
      }).join('')}
      ${readOnly ? '<div class="notice askNotice">当前浏览器为只读，请先接管控制后再提交。</div>' : ''}
      <div class="toolbar">
        <button class="button primary" data-approval-id="${approval.id}" data-method="${method}" data-decision="submitAnswers" ${disabled}>提交</button>
      </div>
    `;
  }

  if (isCommandApprovalMethod(method)) {
    const commandRaw = params.command;
    const commandText = Array.isArray(commandRaw) ? commandRaw.join(' ') : String(commandRaw || '').trim();
    const reason = String(params.reason || '').trim();
    const cwd = String(params.cwd || '').trim();
    const proposedExecpolicy = Array.isArray(params.proposedExecpolicyAmendment)
      ? params.proposedExecpolicyAmendment
      : (Array.isArray(params.proposed_execpolicy_amendment) ? params.proposed_execpolicy_amendment : []);
    const networkAmendments = Array.isArray(params.proposedNetworkPolicyAmendments)
      ? params.proposedNetworkPolicyAmendments
      : (Array.isArray(params.proposed_network_policy_amendments) ? params.proposed_network_policy_amendments : []);

    return `
      ${reason ? `<div class="panelSubtle" style="margin-bottom: 6px;">原因：${escapeHtml(reason)}</div>` : ''}
      ${cwd ? `<div class="panelSubtle" style="margin-bottom: 6px;">工作目录：<span class="inlineCode">${escapeHtml(cwd)}</span></div>` : ''}
      ${commandText ? `<div class="detailSection panelSoft"><h4>命令</h4><pre>${escapeHtml(commandText)}</pre></div>` : ''}
      ${readOnly ? '<div class="notice askNotice">当前浏览器为只读，请先接管控制后再审批。</div>' : ''}
      <div class="askOptionGrid" style="margin-top:8px;">
        <button class="button primary" data-approval-id="${approval.id}" data-method="${method}" data-decision="accept" ${disabled}>允许本次</button>
        <button class="button secondary" data-approval-id="${approval.id}" data-method="${method}" data-decision="acceptForSession" ${disabled}>本会话允许</button>
        <button class="button secondary" data-approval-id="${approval.id}" data-method="${method}" data-decision="decline" ${disabled}>拒绝继续</button>
        <button class="button danger" data-approval-id="${approval.id}" data-method="${method}" data-decision="cancel" ${disabled}>拒绝并中断</button>
        ${proposedExecpolicy.length > 0
    ? `<button class="button secondary" data-approval-id="${approval.id}" data-method="${method}" data-decision="acceptWithExecpolicyAmendment" ${disabled}>按建议放行同类命令</button>`
    : ''}
        ${networkAmendments.map((amendment, index) => {
          const action = amendment?.action === 'deny' ? '拒绝' : '允许';
          const host = amendment?.host || 'unknown-host';
          return `<button class="button secondary" data-approval-id="${approval.id}" data-method="${method}" data-decision="networkAmendment:${index}" ${disabled}>${action} ${escapeHtml(host)}</button>`;
        }).join('')}
      </div>
    `;
  }

  if (isFileApprovalMethod(method)) {
    const reason = String(params.reason || '').trim();
    const grantRoot = String(params.grantRoot || params.grant_root || '').trim();
    return `
      ${reason ? `<div class="panelSubtle" style="margin-bottom: 6px;">原因：${escapeHtml(reason)}</div>` : ''}
      ${grantRoot ? `<div class="panelSubtle" style="margin-bottom: 6px;">建议授权目录：<span class="inlineCode">${escapeHtml(grantRoot)}</span></div>` : ''}
      ${readOnly ? '<div class="notice askNotice">当前浏览器为只读，请先接管控制后再审批。</div>' : ''}
      <div class="askOptionGrid">
        <button class="button primary" data-approval-id="${approval.id}" data-method="${method}" data-decision="accept" ${disabled}>允许本次</button>
        <button class="button secondary" data-approval-id="${approval.id}" data-method="${method}" data-decision="acceptForSession" ${disabled}>本会话允许</button>
        <button class="button secondary" data-approval-id="${approval.id}" data-method="${method}" data-decision="decline" ${disabled}>拒绝继续</button>
        <button class="button danger" data-approval-id="${approval.id}" data-method="${method}" data-decision="cancel" ${disabled}>拒绝并中断</button>
      </div>
    `;
  }

  if (isMcpElicitationMethod(method)) {
    return `
      <label style="display:block; margin-bottom: 10px;">
        <div class="panelSubtle">可选结构化内容</div>
        <textarea data-approval-json="${approval.id}" placeholder='{"key":"value"}' ${disabled}></textarea>
      </label>
      ${readOnly ? '<div class="notice askNotice">当前浏览器为只读，请先接管控制后再审批。</div>' : ''}
      <div class="toolbar">
        <button class="button primary" data-approval-id="${approval.id}" data-method="${method}" data-decision="accept" ${disabled}>接受</button>
        <button class="button secondary" data-approval-id="${approval.id}" data-method="${method}" data-decision="decline" ${disabled}>拒绝</button>
        <button class="button danger" data-approval-id="${approval.id}" data-method="${method}" data-decision="cancel" ${disabled}>取消</button>
      </div>
    `;
  }

  return `
    ${readOnly ? '<div class="notice askNotice">当前浏览器为只读，请先接管控制后再审批。</div>' : ''}
    <div class="toolbar">
      <button class="button primary" data-approval-id="${approval.id}" data-method="${method}" data-decision="accept" ${disabled}>通过</button>
      <button class="button danger" data-approval-id="${approval.id}" data-method="${method}" data-decision="decline" ${disabled}>拒绝</button>
    </div>
  `;
}

function buildCommandApprovalPayload(approval, action, { legacy = false } = {}) {
  const params = approval?.params || {};
  const proposedExecpolicy = Array.isArray(params.proposedExecpolicyAmendment)
    ? params.proposedExecpolicyAmendment
    : (Array.isArray(params.proposed_execpolicy_amendment) ? params.proposed_execpolicy_amendment : []);
  const networkAmendments = Array.isArray(params.proposedNetworkPolicyAmendments)
    ? params.proposedNetworkPolicyAmendments
    : (Array.isArray(params.proposed_network_policy_amendments) ? params.proposed_network_policy_amendments : []);

  if (action === 'acceptWithExecpolicyAmendment') {
    if (legacy) {
      return {
        decision: {
          approved_execpolicy_amendment: {
            proposed_execpolicy_amendment: proposedExecpolicy,
          },
        },
      };
    }
    return {
      decision: {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: proposedExecpolicy,
        },
      },
    };
  }

  if (String(action).startsWith('networkAmendment:')) {
    const index = Number(String(action).split(':')[1]);
    const amendment = Number.isFinite(index) ? networkAmendments[index] : null;
    if (amendment && amendment.host && amendment.action) {
      if (legacy) {
        return {
          decision: {
            network_policy_amendment: {
              network_policy_amendment: {
                action: amendment.action,
                host: amendment.host,
              },
            },
          },
        };
      }
      return {
        decision: {
          applyNetworkPolicyAmendment: {
            network_policy_amendment: {
              action: amendment.action,
              host: amendment.host,
            },
          },
        },
      };
    }
  }

  if (legacy) {
    if (action === 'accept') return { decision: 'approved' };
    if (action === 'acceptForSession') return { decision: 'approved_for_session' };
    if (action === 'cancel') return { decision: 'abort' };
    return { decision: 'denied' };
  }
  if (action === 'accept') return { decision: 'accept' };
  if (action === 'acceptForSession') return { decision: 'acceptForSession' };
  if (action === 'cancel') return { decision: 'cancel' };
  return { decision: 'decline' };
}

function buildFileApprovalPayload(action, { legacy = false } = {}) {
  if (legacy) {
    if (action === 'accept') return { decision: 'approved' };
    if (action === 'acceptForSession') return { decision: 'approved_for_session' };
    if (action === 'cancel') return { decision: 'abort' };
    return { decision: 'denied' };
  }
  if (action === 'accept') return { decision: 'accept' };
  if (action === 'acceptForSession') return { decision: 'acceptForSession' };
  if (action === 'cancel') return { decision: 'cancel' };
  return { decision: 'decline' };
}

function buildApprovalPayload(approvalId, method, action) {
  const approval = getApprovalById(approvalId);
  const normalizedMethod = canonicalApprovalMethod(method || approval?.method);
  const rawMethod = normalizeMethodText(approval?.methodRaw || approval?.method || method);

  if (isAskUserMethod(normalizedMethod)) {
    const draftAnswers = state.askUserDraft[approvalId] || {};
    const inputs = document.querySelectorAll(`[data-approval-form="${approvalId}"]`);
    const answers = {};
    Object.entries(draftAnswers).forEach(([questionId, value]) => {
      const clean = String(value || '').trim();
      if (clean) answers[questionId] = { answers: [clean] };
    });
    inputs.forEach((input) => {
      const value = input.value.trim();
      if (value) answers[input.dataset.questionId] = { answers: [value] };
    });
    return { answers };
  }

  if (isMcpElicitationMethod(normalizedMethod)) {
    const textarea = document.querySelector(`[data-approval-json="${approvalId}"]`);
    const content = textarea?.value?.trim();
    if (!content) return { action };
    try {
      return { action, content: JSON.parse(content) };
    } catch {
      return { action, content };
    }
  }

  if (isCommandApprovalMethod(normalizedMethod)) {
    return buildCommandApprovalPayload(approval, action, { legacy: rawMethod === 'execcommandapproval' });
  }

  if (isFileApprovalMethod(normalizedMethod)) {
    return buildFileApprovalPayload(action, { legacy: rawMethod === 'applypatchapproval' });
  }

  if (action === 'cancel') return { decision: 'cancel' };
  return { decision: action === 'accept' ? 'accept' : 'decline' };
}

function approvalMethodLabel(approval) {
  const method = canonicalApprovalMethod(approval?.method || '');
  if (isAskUserMethod(method)) return '工具问询';
  if (isCommandApprovalMethod(method)) return '命令提权审批';
  if (isFileApprovalMethod(method)) return '文件写入审批';
  if (isMcpElicitationMethod(method)) return 'MCP 输入请求';
  return approval?.method || '审批';
}

function approvalSummaryText(approval) {
  const method = canonicalApprovalMethod(approval?.method || '');
  const params = approval?.params || {};
  if (isAskUserMethod(method)) {
    const count = Array.isArray(params.questions) ? params.questions.length : 0;
    return count > 0 ? `问题数：${count}` : '等待用户输入';
  }
  if (isCommandApprovalMethod(method)) {
    if (Array.isArray(params.command)) return compactText(params.command.join(' '), 100);
    if (typeof params.command === 'string' && params.command.trim()) return compactText(params.command, 100);
    if (params.reason) return compactText(params.reason, 100);
    return '等待命令审批';
  }
  if (isFileApprovalMethod(method)) {
    if (params.reason) return compactText(params.reason, 100);
    if (params.grantRoot || params.grant_root) return compactText(`授权目录：${params.grantRoot || params.grant_root}`, 100);
    return '等待文件写入审批';
  }
  if (isMcpElicitationMethod(method)) {
    return compactText(params.message || params.prompt || params.description || '等待 MCP 输入', 100);
  }
  return compactText(JSON.stringify(params || {}), 100);
}

function renderApprovals() {
  const approvals = [...state.approvals].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return h`
    <div class="panel">
      <div class="panelTitle">
        <h2>审批</h2>
        <span class="panelSubtle">待处理 ${approvals.filter((item) => item.status === 'pending').length} 条</span>
      </div>
      <div class="approvalList scrollArea">
        ${approvals.map((approval) => `
          <div class="approvalCard panel">
            <div class="panelTitle">
              <h3>${escapeHtml(approvalMethodLabel(approval))}</h3>
              <span class="pill ${approval.status === 'pending' ? 'status-starting' : 'status-ready'}">${escapeHtml(approval.status)}</span>
            </div>
            <div class="panelSubtle">线程：${escapeHtml(approval.threadId || '—')} · ${escapeHtml(formatTime(approval.createdAt))}</div>
            <div class="requestPreview">${escapeHtml(approvalSummaryText(approval))}</div>
            ${approval.status === 'pending' ? renderApprovalActions(approval) : '<div class="panelSubtle">该审批已处理完成。</div>'}
          </div>
        `).join('') || '<div class="emptyState">暂无待审批项。</div>'}
      </div>
    </div>
  `;
}

function renderCommands(thread) {
  const commandLog = thread?.details?.commandLog || [];
  const commandEvents = (thread?.details?.events || []).filter((event) => String(event.kind).includes('command') || String(event.kind).includes('item/'));
  return h`
    <div class="panel">
      <div class="panelTitle">
        <h2>命令控制台</h2>
        <span class="panelSubtle">${thread ? escapeHtml(thread.title || thread.id) : '未选择线程'}</span>
      </div>
      ${thread ? `
        <div class="commandList scrollArea">
          ${commandLog.map((entry) => `
            <div class="commandCard panel">
              <div class="panelTitle"><h3>${escapeHtml(entry.itemId || 'command')}</h3><span class="panelSubtle">${escapeHtml(formatTime(entry.updatedAt))}</span></div>
              <pre>${escapeHtml(entry.output || '')}</pre>
            </div>
          `).join('') || '<div class="emptyState">当前线程暂无命令输出。</div>'}
          ${commandEvents.slice(-12).map((entry) => `
            <div class="commandCard panel">
              <div class="panelTitle"><h3>${escapeHtml(entry.kind || 'event')}</h3><span class="panelSubtle">${escapeHtml(formatTime(entry.timestamp))}</span></div>
              <pre>${escapeHtml(JSON.stringify(entry, null, 2))}</pre>
            </div>
          `).join('')}
        </div>
      ` : '<div class="emptyState">请选择线程以查看命令输出。</div>'}
    </div>
  `;
}

function renderLogs() {
  const intercepted = sortedInterceptedLogs();
  const selected = getSelectedInterceptedLog();
  const errorLogs = [...state.errorLogs].sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
  const typeStats = Object.entries(state.interceptedTypeStats || {}).sort((a, b) => b[1] - a[1]);
  const statusStats = Object.entries(state.interceptedStatusStats || {}).sort((a, b) => Number(a[0]) - Number(b[0]));

  return h`
    <div class="panel logsPanel">
      <div class="panelTitle">
        <h2>日志中心</h2>
        <div class="toolbar">
          <span class="panelSubtle">拦截 ${intercepted.length} 条 · 错误 ${errorLogs.length} 条</span>
          <button id="refresh-logs" class="button secondary">刷新日志</button>
        </div>
      </div>
      <div class="requestStat" style="margin: 12px 0;">
        <div class="statCard"><div class="label">拦截记录文件</div><div class="value">${intercepted.length}</div></div>
        <div class="statCard"><div class="label">错误日志条数</div><div class="value">${errorLogs.length}</div></div>
      </div>
      <div class="detailSection panelSoft">
        <h4>类型聚合</h4>
        <div class="chipRow">
          ${typeStats.map(([name, count]) => `<span class="pill">${escapeHtml(name)} · ${count}</span>`).join('') || '<span class="panelSubtle">暂无类型数据</span>'}
        </div>
        <div class="chipRow" style="margin-top: 8px;">
          ${statusStats.map(([code, count]) => `<span class="pill">${escapeHtml(code)} · ${count}</span>`).join('') || '<span class="panelSubtle">暂无状态码数据</span>'}
        </div>
      </div>
      <div class="contentSplit logsLayout" style="margin-top: 10px;">
        <div class="scrollArea requestList logsRequestList">
          ${intercepted.map((entry) => `
            <div class="requestCard ${entry.id === state.selectedInterceptedLogId ? 'active' : ''}" data-intercepted-id="${entry.id}">
              <div class="requestTitleRow">
                <div class="threadTitle">${escapeHtml(requestTitle(entry))}</div>
                <span class="pill">${escapeHtml(entry.response?.statusCode || entry.type || 'unknown')}</span>
              </div>
              <div class="requestPreview">${escapeHtml(requestPreview(entry))}</div>
              <div class="panelSubtle">${escapeHtml(formatTime(entry.timestamp))}</div>
            </div>
          `).join('') || '<div class="emptyState">暂无拦截日志。</div>'}
        </div>
        <div class="detailPane logsDetailPane scrollArea">
          ${selected ? `
            <div class="detailSection panelSoft logSection">
              <h4>拦截记录（结构化）</h4>
              <pre class="logPre">${escapeHtml(JSON.stringify(selected, null, 2))}</pre>
            </div>
          ` : '<div class="emptyState">请选择一条拦截记录。</div>'}
          <div class="detailSection panelSoft logSection">
            <h4>错误日志</h4>
            <div class="logList scrollArea">
              ${errorLogs.map((entry) => `
                <div class="logLine">
                  <span class="pill ${statusClass(entry.level)}">${escapeHtml(entry.level || 'LOG')}</span>
                  <span class="panelSubtle">${escapeHtml(formatTime(entry.timestamp))}</span>
                  <div class="logMessage">${escapeHtml(entry.message || entry.raw || '')}</div>
                </div>
              `).join('') || '<div class="emptyState">暂无错误日志。</div>'}
            </div>
          </div>
          <div class="detailSection panelSoft logSection">
            <h4>拦截原始 JSONL（尾部）</h4>
            <pre class="logPre">${escapeHtml((state.interceptedRawLines || []).slice(-120).join('\n'))}</pre>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderAskUserComposer(context) {
  const approval = context?.approval || null;
  const signal = context?.signal || null;
  const askParams = approval?.params || signal?.params || {};
  const questions = askParams?.questions || [];
  const approvalId = approval?.id || '';
  const threadId = approval?.threadId || signal?.threadId || state.selectedThreadId || '';
  const awaitingApproval = !approval;
  const canResolve = !awaitingApproval && state.session?.viewerRole === 'controller';
  const canSubmit = canResolve && questions.length > 0;
  const sourceText = awaitingApproval
    ? '已从网络捕获识别，等待控制面同步审批'
    : (context?.detectedFromNetwork ? '已由网络与控制面共同识别' : '已由控制面识别');

  return h`
    <div class="askUserComposer ${awaitingApproval ? 'networkOnly' : ''}">
      <div class="askUserHeader">
        <span class="pill status-starting">需要操作</span>
        <span class="panelSubtle">${sourceText}</span>
      </div>
      ${questions.length ? questions.map((question, index) => {
        const options = Array.isArray(question.options) ? question.options : [];
        const questionId = question.id || question.header || `question_${index + 1}`;
        const selectedValue = getAskUserDraft(approvalId, questionId);
        return `
          <div class="askQuestionCard">
            <div class="panelSubtle">${escapeHtml(question.header || questionId || '问题')}</div>
            <div class="askQuestionText">${escapeHtml(question.question || '')}</div>
            ${options.length > 0 ? `
              <div class="askOptionGrid">
                ${options.map((option) => {
                  const optionLabel = option?.label || option?.value || option?.title || '';
                  return `
                  <button
                    class="button secondary askOptionButton ${selectedValue === optionLabel ? 'active' : ''}"
                    data-ask-option="1"
                    data-approval-id="${escapeHtml(approvalId)}"
                    data-question-id="${escapeHtml(questionId)}"
                    data-option-label="${escapeHtml(optionLabel)}"
                    ${awaitingApproval ? 'disabled' : ''}
                  >${escapeHtml(optionLabel)}</button>
                `;
                }).join('')}
              </div>
            ` : `
              <input
                data-approval-form="${escapeHtml(approvalId)}"
                data-question-id="${escapeHtml(questionId)}"
                value="${escapeHtml(selectedValue)}"
                placeholder="请输入你的回答"
                ${awaitingApproval ? 'disabled' : ''}
              />
            `}
          </div>
        `;
      }).join('') : '<div class="emptyState">正在等待 ask-user 问题数据…</div>'}
      <div class="askSubmitRow">
        ${awaitingApproval
          ? '<div class="notice askNotice">已检测到 ask-user 请求，等待可提交的审批 ID。</div>'
          : (!canResolve
            ? '<div class="notice askNotice">当前浏览器为只读，请先点击“接管控制”后再作答。</div>'
            : '')
        }
        <button
          class="button primary"
          data-approval-id="${escapeHtml(approvalId)}"
          data-method="item/tool/requestUserInput"
          data-decision="submitAnswers"
          ${!canSubmit ? 'disabled' : ''}
        >提交回答</button>
      </div>
      ${awaitingApproval && threadId ? `
        <div class="toolbar" style="margin-top: 8px;">
          <button class="button secondary" data-thread-interrupt="${escapeHtml(threadId)}">重试中断</button>
          <button class="button danger" data-thread-force-clean="${escapeHtml(threadId)}">强制清理线程</button>
        </div>
      ` : ''}
    </div>
  `;
}

function renderInteractionComposer(context) {
  if (!context) return '';
  if (context.source === 'network') {
    return renderAskUserComposer(context);
  }
  if (context.source === 'tool_event') {
    const fallback = describeToolApprovalFallbackEvent(context.event || {});
    const threadId = context.event?.threadId || state.selectedThreadId || '';
    const threadIdEscaped = escapeHtml(threadId);
    return h`
      <div class="askUserComposer networkOnly">
        <div class="askUserHeader">
          <span class="pill status-starting">需要操作</span>
          <span class="panelSubtle">仅检测到工具审批事件</span>
        </div>
        <div class="notice askNotice" style="margin-bottom: 8px;">
          检测到审批事件，但控制面未返回可回调审批 ID，当前无法在网页提交审批。
        </div>
        <div class="panelSubtle">
          方法：${escapeHtml(fallback.method || context.event?.method || '未知')}
        </div>
        ${fallback.reason ? `<div class="panelSubtle">原因：${escapeHtml(compactText(fallback.reason, 220))}</div>` : ''}
        ${fallback.command ? `<div class="panelSubtle">内容：${escapeHtml(compactText(fallback.command, 220))}</div>` : ''}
        ${fallback.availableDecisions.length ? `<div class="panelSubtle">可选决策：${escapeHtml(fallback.availableDecisions.join(' / '))}</div>` : ''}
        ${threadId ? `
          <div class="toolbar" style="margin-top: 8px;">
            <button class="button secondary" data-thread-interrupt="${threadIdEscaped}">重试中断</button>
            <button class="button danger" data-thread-force-clean="${threadIdEscaped}">强制清理线程</button>
          </div>
        ` : ''}
      </div>
    `;
  }
  const approval = context.approval;
  if (!approval) return '';
  const method = canonicalApprovalMethod(approval.method);
  if (isAskUserMethod(method)) {
    return renderAskUserComposer(context);
  }
  const sourceText = context?.detectedFromNetwork ? '已由网络与控制面共同识别' : '已由控制面识别';
  return h`
    <div class="askUserComposer">
      <div class="askUserHeader">
        <span class="pill status-starting">需要操作</span>
        <span class="panelSubtle">${sourceText}</span>
      </div>
      <div class="panelSubtle" style="margin-bottom: 8px;">${escapeHtml(approvalMethodLabel(approval))}</div>
      ${renderApprovalActions(approval)}
    </div>
  `;
}

function renderMain() {
  const selected = getSelectedThread();
  const busyThread = getSelectedBusyThread();
  const isBusy = Boolean(busyThread);
  const interactionContext = getCurrentInteractionContext();
  const shouldShowInteractionComposer = Boolean(interactionContext);
  const hasBlockingInteraction = Boolean(interactionContext);
  const isReadOnly = state.session?.viewerRole !== 'controller';
  const composerDisabled = state.sendingPrompt || isBusy || hasBlockingInteraction || isReadOnly;
  let lockReason = '';
  if (isReadOnly) {
    lockReason = '当前浏览器是只读模式，请先点击“接管控制”。';
  } else if (interactionContext?.source === 'approval') {
    lockReason = `线程 ${selected?.title || compactId(selected?.id || '')} 存在待处理审批，请先完成交互。`;
  } else if (interactionContext?.source === 'network') {
    lockReason = '检测到 ask-user 交互，等待控制面同步审批 ID 后可提交回答。';
  } else if (interactionContext?.source === 'tool_event') {
    lockReason = '检测到审批事件但无可回调审批 ID，请先在原生终端处理该审批。';
  } else if (isBusy) {
    lockReason = `线程 ${busyThread?.title || compactId(busyThread?.id || '')} 正在执行，等待结束后再发送。`;
  }
  const mobile = isMobileViewport();
  if (!mobile && state.mobileDrawerOpen) state.mobileDrawerOpen = false;
  return h`
    <div class="column mainColumn">
      ${mobile ? `
        <button id="mobile-drawer-toggle" class="mobileDrawerToggle" aria-label="打开抽屉菜单" title="打开菜单">
          <span></span><span></span><span></span>
        </button>
        ${state.mobileDrawerOpen ? `
          <div class="mobileDrawerOverlay" data-mobile-drawer-dismiss="1"></div>
          <aside class="mobileDrawerPanel">
            <div class="mobileDrawerActions">
              <button class="button secondary" data-mobile-drawer-open="threads">线程 (${state.threads.length})</button>
              <button class="button secondary" data-mobile-drawer-open="logs">日志 (${state.errorLogs.length})</button>
            </div>
          </aside>
        ` : ''}
      ` : ''}
      <div class="panel mainContentPanel">
        ${state.tab === 'conversation' ? renderConversation(selected) : ''}
        ${state.tab === 'requests' ? renderRequests() : ''}
        ${state.tab === 'approvals' ? renderApprovals() : ''}
        ${state.tab === 'commands' ? renderCommands(selected) : ''}
        ${state.tab === 'logs' ? renderLogs() : ''}
      </div>
      <div class="panel bottomControlPanel">
        ${lockReason ? `<div class="notice">${escapeHtml(lockReason)}</div>` : ''}
        ${shouldShowInteractionComposer ? renderInteractionComposer(interactionContext) : `
          <div class="composerInputRow">
            <textarea id="prompt-input" placeholder="在这里输入指令（电脑/手机均可）..." ${composerDisabled ? 'disabled' : ''}>${escapeHtml(state.prompt)}</textarea>
            <button id="send-enter" class="enterSendIconButton" title="回车发送" aria-label="发送消息" ${composerDisabled ? 'disabled' : ''}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 5l6 7h-4v7h-4v-7H6z"></path>
              </svg>
            </button>
          </div>
          <div class="panelSubtle composerHint">Enter 发送 · Shift+Enter 换行（中文输入法回车选字不会发送）</div>
        `}
        ${mobile ? '' : `
          <div class="tabs bottomTabs" style="margin-top: 10px;">
            ${['conversation', 'requests', 'approvals', 'commands', 'logs'].map((tab) => `
              <button class="button tabButton ${state.tab === tab ? 'active' : ''}" data-tab="${tab}">${tabLabel(tab)}</button>
            `).join('')}
          </div>
        `}
      </div>
    </div>
  `;
}

function renderModal() {
  if (!state.modal) return '';

  const selected = getSelectedThread();
  const selectedRequest = getSelectedRequest();
  const latestApproval = [...state.approvals].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
  const errorLogs = [...state.errorLogs].sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());

  let title = '';
  let subtitle = '';
  let body = '';

  if (state.modal === 'request') {
    title = '已选请求';
    subtitle = selectedRequest ? requestTitle(selectedRequest) : '未选择请求';
    body = selectedRequest
      ? `
        <div class="modalSection">
          <h4>请求</h4>
          <pre>${escapeHtml(JSON.stringify(selectedRequest.request, null, 2))}</pre>
        </div>
        <div class="modalSection">
          <h4>响应</h4>
          <pre>${escapeHtml(JSON.stringify(selectedRequest.response, null, 2))}</pre>
        </div>
        ${selectedRequest.error ? `<div class="modalSection"><h4>错误</h4><pre>${escapeHtml(selectedRequest.error)}</pre></div>` : ''}
      `
      : '<div class="emptyState">请先选择一条请求。</div>';
  } else if (state.modal === 'approval') {
    title = '最近审批';
    subtitle = latestApproval ? `${approvalMethodLabel(latestApproval)} · ${formatTime(latestApproval.createdAt)}` : '暂无审批';
    body = latestApproval
      ? `<pre>${escapeHtml(JSON.stringify(latestApproval, null, 2))}</pre>`
      : '<div class="emptyState">暂无审批记录。</div>';
  } else if (state.modal === 'thread') {
    title = '线程原始数据';
    subtitle = selected ? `${selected.title || selected.id} · ${formatTime(selected.updatedAt)}` : '未选择线程';
    body = selected
      ? `<pre>${escapeHtml(JSON.stringify(selected.raw || selected, null, 2))}</pre>`
      : '<div class="emptyState">未选择线程。</div>';
  } else if (state.modal === 'threads') {
    title = '线程列表';
    subtitle = `已加载 ${state.threads.length} 个`;
    body = `
      <div class="toolbar" style="margin-bottom: 10px;">
        <button class="button secondary" data-mobile-new-thread="1">新建线程</button>
      </div>
      <div class="threadList">
        ${state.threads.map((thread) => `
          <div class="threadCard ${thread.id === state.selectedThreadId ? 'active' : ''}" data-thread-id="${thread.id}" data-close-modal="1">
            <div class="threadTitle">${escapeHtml(thread.title || '未命名线程')}</div>
            <div class="threadMetaMini" title="${escapeHtml(firstUserMessageText(thread))}">${escapeHtml(threadCardMeta(thread))}</div>
          </div>
        `).join('') || '<div class="emptyState">暂无线程。</div>'}
      </div>
    `;
  } else if (state.modal === 'logs') {
    title = '日志';
    subtitle = `错误 ${errorLogs.length} 条 · 拦截 ${state.interceptedLogs.length} 条`;
    body = `
      <div class="mobileNavList">
        <button class="button secondary mobileNavButton ${state.tab === 'logs' ? 'active' : ''}" data-modal-tab="logs">打开日志中心</button>
        <button class="button secondary mobileNavButton ${state.tab === 'requests' ? 'active' : ''}" data-modal-tab="requests">打开请求视图</button>
      </div>
      <div class="detailSection panelSoft" style="margin-top: 10px;">
        <h4>最近错误</h4>
        <div class="logList scrollArea">
          ${errorLogs.slice(0, 8).map((entry) => `
            <div class="logLine">
              <span class="pill ${statusClass(entry.level)}">${escapeHtml(entry.level || 'LOG')}</span>
              <span class="panelSubtle">${escapeHtml(formatTime(entry.timestamp))}</span>
              <div class="logMessage">${escapeHtml(entry.message || entry.raw || '')}</div>
            </div>
          `).join('') || '<div class="emptyState">暂无错误日志。</div>'}
        </div>
      </div>
    `;
  }

  return h`
    <div class="modalOverlay" data-modal-dismiss="1">
      <div class="modalCard ${state.modal === 'logs' ? 'drawerCard' : ''}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
        <div class="panelTitle">
          <div>
            <h2>${escapeHtml(title)}</h2>
            <div class="panelSubtle">${escapeHtml(subtitle)}</div>
          </div>
          <button id="modal-close" class="button secondary">关闭</button>
        </div>
        <div class="modalBody scrollArea">${body}</div>
      </div>
    </div>
  `;
}

function renderRightbar() {
  const stats = summaryStats();
  const selected = getSelectedThread();
  const selectedRequest = getSelectedRequest();
  const latestApproval = [...state.approvals].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
  return h`
    <div class="column rightbar">
      <div class="panel">
        <div class="panelTitle"><h2>概览</h2></div>
        <div class="statGrid rightbarStats">
          <div class="statCard"><div class="label">线程数</div><div class="value">${stats.threadCount}</div><div class="hint">来自 Codex 会话</div></div>
          <div class="statCard"><div class="label">待审批</div><div class="value">${stats.approvalCount}</div><div class="hint">可在电脑或手机处理</div></div>
          <div class="statCard"><div class="label">捕获请求</div><div class="value">${stats.requestCount}</div><div class="hint">代理 + app-server 观测</div></div>
          <div class="statCard"><div class="label">可见消息</div><div class="value">${stats.messageCount}</div><div class="hint">当前线程消息总览</div></div>
        </div>
      </div>
      <div class="panel">
        <div class="panelTitle"><h2>链路信息</h2></div>
        <div class="kv">
          <div class="key">代理端口</div><div>${escapeHtml(String(state.session.proxyPort || '—'))}</div>
          <div class="key">App 端口</div><div>${escapeHtml(String(state.session.appServerPort || '—'))}</div>
          <div class="key">访问角色</div><div>${escapeHtml(viewerRoleLabel(state.session.viewerRole || 'viewer'))}</div>
          <div class="key">最近请求</div><div>${escapeHtml(formatRelative(sortedRequests()[0]?.timestamp))}</div>
        </div>
      </div>
      <div class="panel">
        <div class="panelTitle"><h2>日志中心</h2></div>
        <div class="panelSubtle">查看拦截日志与错误日志，便于调试和协议解析。</div>
        <div class="toolbar" style="margin-top: 10px;">
          <button class="button secondary" data-tab="logs">进入日志中心</button>
        </div>
      </div>
      <div class="panel">
        <div class="panelTitle"><h2>已选请求</h2></div>
        ${selectedRequest ? `
          <div class="panelSubtle">${escapeHtml(requestTitle(selectedRequest))}</div>
          <div class="requestPreview">${escapeHtml(requestPreview(selectedRequest))}</div>
          <div class="toolbar" style="margin-top: 10px;">
            <button class="button secondary" data-modal-open="request">查看详情</button>
          </div>
        ` : '<div class="emptyState">请选择一条原始请求查看。</div>'}
      </div>
      <div class="panel">
        <div class="panelTitle"><h2>最近审批</h2></div>
        ${latestApproval ? `
          <div class="panelSubtle">${escapeHtml(approvalMethodLabel(latestApproval))}</div>
          <div class="requestPreview">${escapeHtml(formatTime(latestApproval.createdAt))} · ${escapeHtml(latestApproval.status || 'pending')}</div>
          <div class="toolbar" style="margin-top: 10px;">
            <button class="button secondary" data-modal-open="approval">查看详情</button>
          </div>
        ` : '<div class="emptyState">暂无审批记录。</div>'}
      </div>
      <div class="panel">
        <div class="panelTitle"><h2>线程原始数据</h2></div>
        ${selected ? `
          <div class="panelSubtle">${escapeHtml(selected.title || selected.id)}</div>
          <div class="requestPreview">更新于 ${escapeHtml(formatRelative(selected.updatedAt))}</div>
          <div class="toolbar" style="margin-top: 10px;">
            <button class="button secondary" data-modal-open="thread">查看详情</button>
          </div>
        ` : '<div class="emptyState">未选择线程。</div>'}
      </div>
    </div>
  `;
}

function isNearBottom(element, threshold = 48) {
  if (!element) return true;
  return (element.scrollHeight - element.scrollTop - element.clientHeight) <= threshold;
}

function isNearTop(element, threshold = 48) {
  if (!element) return true;
  return element.scrollTop <= threshold;
}

function syncScrollableArea(selector, key, position) {
  const element = document.querySelector(selector);
  if (!element) return;

  if (state.scrollIntent[key]) {
    if (position === 'bottom') element.scrollTop = element.scrollHeight;
    else element.scrollTop = 0;
  }

  element.onscroll = () => {
    state.scrollIntent[key] = position === 'bottom' ? isNearBottom(element) : isNearTop(element);
  };
}

function syncScrollPositions() {
  syncScrollableArea('.messageList', 'conversation', 'bottom');
  syncScrollableArea('.requestList', 'requests', 'top');
  syncScrollableArea('.approvalList', 'approvals', 'top');
  syncScrollableArea('.commandList', 'commands', 'bottom');
  syncScrollableArea('.logList', 'logs', 'top');
}

function render() {
  if (!state.session) {
    renderPairing();
    return;
  }

  const app = document.querySelector('#app');
  app.innerHTML = h`
    <div class="page">
      ${renderHeader()}
      <div class="container">
        ${renderSidebar()}
        ${renderMain()}
        ${renderRightbar()}
      </div>
      ${renderModal()}
    </div>
  `;

  highlightCodeBlocks(app);
  bindActions();
  syncScrollPositions();
}

function bindActions() {
  const removeThreadById = async (threadId, { confirmFirst = true } = {}) => {
    if (!threadId) return;
    if (confirmFirst) {
      const sure = window.confirm('确认从列表移除该线程？如果线程仍在执行，会先尝试中断。');
      if (!sure) return;
    }
    await api(`/api/threads/${encodeURIComponent(threadId)}/remove`, {
      method: 'POST',
      body: '{}',
    });
    if (state.selectedThreadId === threadId) {
      setSelectedThread(null);
    }
    await refreshData();
  };

  document.querySelectorAll('[data-thread-id]').forEach((node) => {
    node.onclick = async () => {
      const threadId = node.dataset.threadId;
      const shouldCloseModal = node.dataset.closeModal === '1';
      setSelectedThread(threadId);
      setActiveTab('conversation');
      state.scrollIntent.conversation = true;
      state.scrollIntent.commands = true;
      if (shouldCloseModal) state.modal = null;
      render();
      try {
        await loadThread(threadId);
      } catch (error) {
        alert(error.message);
      }
      render();
    };
  });

  document.querySelectorAll('[data-thread-interrupt]').forEach((node) => {
    node.onclick = async () => {
      const threadId = node.dataset.threadInterrupt;
      if (!threadId) return;
      try {
        const result = await api(`/api/threads/${encodeURIComponent(threadId)}/interrupt`, {
          method: 'POST',
          body: '{}',
        });
        await refreshData();
        if (result?.requested && !result?.interrupted) {
          alert('已发送中断请求，但线程仍在执行，请稍后观察状态变化。');
        }
      } catch (error) {
        const message = error.message || '中断失败，请重试。';
        if (
          message.includes('missing active turnId')
          || message.includes('missing field turnId')
          || message.includes('missing field `turnId`')
        ) {
          const shouldRemove = window.confirm('该线程缺少可中断的 turnId，通常是旧 ask-user 卡死会话。是否直接从列表强制清理？');
          if (shouldRemove) {
            try {
              await removeThreadById(threadId, { confirmFirst: false });
              return;
            } catch (removeError) {
              alert(removeError.message || '强制清理失败，请重试。');
              return;
            }
          }
        }
        alert(message);
      }
    };
  });

  document.querySelectorAll('[data-thread-force-clean]').forEach((node) => {
    node.onclick = async () => {
      const threadId = node.dataset.threadForceClean;
      if (!threadId) return;
      const sure = window.confirm('该线程可能是旧交互卡住状态。将直接从列表清理（不再尝试恢复这个线程），是否继续？');
      if (!sure) return;
      try {
        await removeThreadById(threadId, { confirmFirst: false });
      } catch (error) {
        alert(error.message || '强制清理失败，请重试。');
      }
    };
  });

  document.querySelectorAll('[data-thread-remove]').forEach((node) => {
    node.onclick = async () => {
      const threadId = node.dataset.threadRemove;
      if (!threadId) return;
      try {
        await removeThreadById(threadId, { confirmFirst: true });
      } catch (error) {
        alert(error.message || '移除失败，请重试。');
      }
    };
  });

  document.querySelectorAll('[data-mobile-open]').forEach((node) => {
    node.onclick = () => {
      state.mobileDrawerOpen = false;
      state.modal = node.dataset.mobileOpen || null;
      render();
    };
  });

  const mobileDrawerToggle = document.querySelector('#mobile-drawer-toggle');
  if (mobileDrawerToggle) {
    mobileDrawerToggle.onclick = () => {
      state.mobileDrawerOpen = !state.mobileDrawerOpen;
      render();
    };
  }

  document.querySelectorAll('[data-mobile-drawer-dismiss]').forEach((node) => {
    node.onclick = () => {
      state.mobileDrawerOpen = false;
      render();
    };
  });

  document.querySelectorAll('[data-mobile-drawer-open]').forEach((node) => {
    node.onclick = () => {
      const target = node.dataset.mobileDrawerOpen;
      if (!target) return;
      state.mobileDrawerOpen = false;
      state.modal = target;
      render();
    };
  });

  document.querySelectorAll('[data-mobile-drawer-toggle-timeline]').forEach((node) => {
    node.onclick = () => {
      state.showTimeline = !state.showTimeline;
      state.mobileDrawerOpen = false;
      render();
    };
  });

  document.querySelectorAll('[data-mobile-new-thread]').forEach((node) => {
    node.onclick = () => {
      state.modal = null;
      setSelectedThread(null);
      setActiveTab('conversation');
      state.scrollIntent.conversation = true;
      render();
      document.querySelector('#prompt-input')?.focus();
    };
  });

  document.querySelectorAll('[data-request-id]').forEach((node) => {
    node.onclick = () => {
      state.selectedRequestId = node.dataset.requestId;
      render();
    };
  });

  document.querySelectorAll('[data-intercepted-id]').forEach((node) => {
    node.onclick = () => {
      state.selectedInterceptedLogId = node.dataset.interceptedId;
      render();
    };
  });

  document.querySelectorAll('[data-copy-thread-id]').forEach((node) => {
    node.onclick = async () => {
      const value = node.dataset.copyThreadId || '';
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        node.classList.add('copied');
        setTimeout(() => node.classList.remove('copied'), 900);
      } catch {
        node.classList.remove('copied');
      }
    };
  });

  document.querySelectorAll('[data-copy-code]').forEach((node) => {
    node.onclick = async () => {
      const preNode = node.closest('.mdCodeBlock');
      const codeNode = preNode?.querySelector('code');
      const content = codeNode?.textContent || '';
      if (!content) return;
      const ok = await copyToClipboard(content);
      if (!ok) {
        alert('复制失败，请手动复制。');
        return;
      }
      const original = node.textContent;
      node.textContent = '已复制';
      node.classList.add('copied');
      setTimeout(() => {
        node.textContent = original || '复制';
        node.classList.remove('copied');
      }, 900);
    };
  });

  document.querySelectorAll('[data-modal-open]').forEach((node) => {
    node.onclick = () => {
      state.modal = node.dataset.modalOpen;
      render();
    };
  });

  document.querySelectorAll('[data-modal-dismiss]').forEach((node) => {
    node.onclick = (event) => {
      if (event.target !== node) return;
      state.modal = null;
      render();
    };
  });

  const modalClose = document.querySelector('#modal-close');
  if (modalClose) {
    modalClose.onclick = () => {
      state.modal = null;
      render();
    };
  }

  document.querySelectorAll('[data-tab]').forEach((node) => {
    node.onclick = async () => {
      setActiveTab(node.dataset.tab);
      state.scrollIntent[node.dataset.tab] = true;
      const selected = getSelectedThread();
      if (selected && (needsThreadHistory(selected) || isThreadBusy(selected))) {
        await loadThread(selected.id, { resume: false });
      }
      if (node.dataset.tab === 'logs') {
        await loadLogsData();
      }
      render();
    };
  });

  document.querySelectorAll('[data-modal-tab]').forEach((node) => {
    node.onclick = async () => {
      const nextTab = node.dataset.modalTab;
      if (!nextTab) return;
      setActiveTab(nextTab);
      state.scrollIntent[nextTab] = true;
      state.modal = null;
      const selected = getSelectedThread();
      if (selected && (needsThreadHistory(selected) || isThreadBusy(selected))) {
        await loadThread(selected.id, { resume: false });
      }
      if (nextTab === 'logs') {
        await loadLogsData();
      }
      render();
    };
  });

  document.querySelectorAll('[data-ask-option]').forEach((node) => {
    node.onclick = () => {
      const approvalId = node.dataset.approvalId;
      const questionId = node.dataset.questionId;
      const optionLabel = node.dataset.optionLabel || '';
      if (!approvalId || !questionId) return;
      setAskUserDraft(approvalId, questionId, optionLabel);
      render();
    };
  });

  document.querySelectorAll('[data-approval-id]').forEach((node) => {
    node.onclick = async () => {
      const approvalId = node.dataset.approvalId;
      const method = node.dataset.method;
      const action = node.dataset.decision;
      if (!approvalId || !method) return;
      const body = buildApprovalPayload(approvalId, method, action);
      if (isAskUserMethod(method) && Object.keys(body.answers || {}).length === 0) {
        alert('请至少选择或输入一条回答。');
        return;
      }
      try {
        await api(`/api/approvals/${approvalId}/resolve`, {
          method: 'POST',
          body: JSON.stringify({ result: body }),
        });
        clearAskUserDraft(approvalId);
        await refreshData();
      } catch (error) {
        alert(error.message);
      }
    };
  });

  const promptInput = document.querySelector('#prompt-input');
  const submitPrompt = async () => {
    if (state.sendingPrompt) return;
    if (state.session?.viewerRole !== 'controller') {
      alert('当前浏览器是只读模式，请先点击“接管控制”。');
      return;
    }
    const selected = getSelectedThread();
    const busyThread = selected && isThreadBusy(selected) ? selected : null;
    if (busyThread) {
      alert(`线程 ${busyThread.title || compactId(busyThread.id)} 仍在执行中，请等待完成后再发送。`);
      return;
    }
    const interactionContext = getCurrentInteractionContext();
    const blockingApproval = interactionContext?.source === 'approval' ? interactionContext.approval : null;
    if (blockingApproval) {
      alert(`当前线程存在待处理审批（${approvalMethodLabel(blockingApproval)}），请先完成该交互。`);
      return;
    }
    if (interactionContext?.source === 'network') {
      alert('检测到 ask-user 交互，等待控制面审批 ID 同步后再提交回答。');
      return;
    }
    if (interactionContext?.source === 'tool_event') {
      alert('检测到审批事件但缺少可回调审批 ID，请先在原生终端处理该审批。');
      return;
    }
    const prompt = document.querySelector('#prompt-input')?.value.trim();
    if (!prompt) return;
    state.sendingPrompt = true;
    try {
      if (!selected) {
        const result = await api('/api/threads', { method: 'POST', body: JSON.stringify({ prompt }) });
        const threadId = result.thread?.id || state.selectedThreadId;
        if (result.thread) upsertThreadLocal(result.thread);
        setSelectedThread(threadId);
        if (threadId) addOptimisticUserMessage(threadId, prompt);
        state.scrollIntent.conversation = true;
        state.scrollIntent.commands = true;
        setActiveTab('conversation');
      } else {
        await api('/api/turns', { method: 'POST', body: JSON.stringify({ threadId: selected.id, prompt }) });
        addOptimisticUserMessage(selected.id, prompt);
        state.scrollIntent.conversation = true;
        state.scrollIntent.commands = true;
        setActiveTab('conversation');
      }
      state.prompt = '';
      render();
    } catch (error) {
      alert(error.message || '请求失败，请重试。');
    } finally {
      state.sendingPrompt = false;
    }
  };

  if (promptInput) {
    promptInput.oninput = (event) => {
      state.prompt = event.target.value;
    };
    promptInput.oncompositionstart = () => {
      state.promptIsComposing = true;
    };
    promptInput.oncompositionend = () => {
      state.promptIsComposing = false;
      state.promptLastCompositionEndAt = Date.now();
    };
    promptInput.onkeydown = (event) => {
      if (event.key !== 'Enter') return;
      if (event.shiftKey) return;
      if ((Date.now() - state.promptLastCompositionEndAt) < 120) return;
      if (event.isComposing || state.promptIsComposing || event.keyCode === 229) return;
      event.preventDefault();
      submitPrompt();
    };
  }

  const sendButton = document.querySelector('#send-enter');
  if (sendButton) {
    sendButton.onclick = submitPrompt;
  }

  const refreshLogs = document.querySelector('#refresh-logs');
  if (refreshLogs) {
    refreshLogs.onclick = async () => {
      await loadLogsData();
      render();
    };
  }

  const takeover = document.querySelector('#takeover');
  if (takeover) {
    takeover.onclick = async () => {
      await api('/api/session/takeover', { method: 'POST', body: '{}' });
      await refreshData();
    };
  }

  const refresh = document.querySelector('#refresh');
  if (refresh) refresh.onclick = refreshData;

  const newThread = document.querySelector('#new-thread');
  if (newThread) {
    newThread.onclick = () => {
      setSelectedThread(null);
      setActiveTab('conversation');
      state.scrollIntent.conversation = true;
      render();
      document.querySelector('#prompt-input')?.focus();
    };
  }

}

async function loadLogsData({ limit = 0 } = {}) {
  const interceptedQuery = Number(limit) <= 0
    ? '/api/logs/intercepted?all=1'
    : `/api/logs/intercepted?limit=${encodeURIComponent(limit)}`;
  const [interceptedResult, errorResult] = await Promise.all([
    api(interceptedQuery),
    api(`/api/logs/errors?limit=${encodeURIComponent(Number(limit) <= 0 ? 1200 : Math.min(2000, Math.max(200, Math.floor(limit / 2))))}`),
  ]);

  state.interceptedLogs = interceptedResult.data || [];
  state.interceptedTypeStats = interceptedResult.typeStats || {};
  state.interceptedStatusStats = interceptedResult.statusStats || {};
  state.interceptedRawLines = interceptedResult.rawLines || [];
  state.errorLogs = errorResult.data || [];

  const intercepted = sortedInterceptedLogs();
  if (!state.selectedInterceptedLogId && intercepted.length > 0) {
    state.selectedInterceptedLogId = intercepted[0].id;
  }
  if (state.selectedInterceptedLogId && !intercepted.some((entry) => entry.id === state.selectedInterceptedLogId)) {
    state.selectedInterceptedLogId = intercepted[0]?.id || null;
  }
}

async function refreshData() {
  state.scrollIntent.conversation = true;
  state.scrollIntent.requests = true;
  state.scrollIntent.approvals = true;
  state.scrollIntent.commands = true;
  state.scrollIntent.logs = true;
  state.session = await api('/api/session');
  mergeThreadsLocal(state.session.threads || []);
  state.approvals = normalizeApprovals(state.session.approvals || []);
  pruneAskUserDrafts();
  state.rawRequests = (await api('/api/raw-requests')).data || [];
  await loadLogsData();

  if (!state.selectedThreadId && state.threads.length > 0) {
    setSelectedThread(state.threads[0].id);
  }
  if (state.selectedThreadId && !state.threads.some((thread) => thread.id === state.selectedThreadId)) {
    setSelectedThread(state.threads[0]?.id || null);
  }
  if (state.selectedThreadId) {
    const selected = getSelectedThread();
    if (selected && (needsThreadHistory(selected) || isThreadBusy(selected))) {
      try {
        await loadThread(state.selectedThreadId, { resume: false });
      } catch (error) {
        console.warn('Failed to hydrate thread history', error);
      }
    }
  }

  const busyThreadIds = state.threads
    .filter((thread) => isThreadBusy(thread))
    .map((thread) => thread.id)
    .filter(Boolean);
  if (busyThreadIds.length > 0) {
    await Promise.allSettled(
      busyThreadIds.map((threadId) => loadThread(threadId, { resume: false })),
    );
  }

  const requests = sortedRequests();
  if (!state.selectedRequestId && requests.length > 0) {
    state.selectedRequestId = requests[0].id;
  }
  if (state.selectedRequestId && !requests.some((entry) => entry.id === state.selectedRequestId)) {
    state.selectedRequestId = requests[0]?.id || null;
  }

  focusConversationForAskUser();
  render();
  hydrateThreadSummariesInBackground().catch(() => {});
}

function connectEvents() {
  if (!state.token) return;
  state.ws?.close();
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}/ws/events?token=${encodeURIComponent(state.token)}`);
  state.ws = ws;

  ws.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === 'snapshot') {
      state.scrollIntent.conversation = true;
      state.scrollIntent.requests = true;
      state.scrollIntent.approvals = true;
      state.scrollIntent.commands = true;
      state.scrollIntent.logs = true;
      state.session = payload.data;
      mergeThreadsLocal(payload.data.threads || []);
      state.approvals = normalizeApprovals(payload.data.approvals || []);
      pruneAskUserDrafts();
      if (!state.selectedThreadId && state.threads.length > 0) {
        setSelectedThread(state.threads[0].id);
      }
      const selected = getSelectedThread();
      if (selected && (needsThreadHistory(selected) || isThreadBusy(selected))) {
        loadThread(selected.id, { resume: false }).then(() => render()).catch(() => {});
      }
      focusConversationForAskUser();
      render();
      loadLogsData().then(() => render()).catch(() => {});
      hydrateThreadSummariesInBackground().catch(() => {});
      return;
    }
    if (payload.type === 'rawRequest') {
      state.rawRequests = [...state.rawRequests, payload.entry].slice(-150);
      state.interceptedLogs = [...state.interceptedLogs, payload.entry];
      state.interceptedRawLines = [...state.interceptedRawLines, JSON.stringify(payload.entry)];
      const typeKey = String(payload.entry?.type || 'unknown');
      state.interceptedTypeStats = {
        ...state.interceptedTypeStats,
        [typeKey]: (state.interceptedTypeStats[typeKey] || 0) + 1,
      };
      if (payload.entry?.response?.statusCode != null) {
        const code = String(payload.entry.response.statusCode);
        state.interceptedStatusStats = {
          ...state.interceptedStatusStats,
          [code]: (state.interceptedStatusStats[code] || 0) + 1,
        };
      }
      if (!state.selectedRequestId) state.selectedRequestId = payload.entry.id;
      if (!state.selectedInterceptedLogId) state.selectedInterceptedLogId = payload.entry.id;
      focusConversationForAskUser();
      render();
      return;
    }
    if (payload.type === 'event') {
      applyEvent(payload.event);
      focusConversationForAskUser();
      render();
      return;
    }
  };

  ws.onclose = () => {
    setTimeout(connectEvents, 1200);
  };
}

async function bootstrap() {
  try {
    await refreshData();
    connectEvents();
  } catch {
    renderPairing();
  }
}

if (state.pairToken && !state.token) {
  api('/api/pair/exchange', { method: 'POST', body: JSON.stringify({ token: state.pairToken }) })
    .then((result) => {
      state.token = result.token;
      localStorage.setItem('codexViewerToken', result.token);
      history.replaceState({}, '', '/');
      bootstrap();
    })
    .catch(() => renderPairing());
} else {
  bootstrap();
}
