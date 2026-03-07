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
  const segments = source.split(/```([\w-]*)\n([\s\S]*?)```/g);
  let html = '';

  for (let index = 0; index < segments.length; index += 1) {
    if (index % 3 === 0) {
      html += renderMarkdownBlocks(segments[index]);
      continue;
    }
    const language = escapeHtml(segments[index] || 'code');
    const code = escapeHtml(segments[index + 1] || '');
    html += `<pre class="mdCodeBlock"><code data-lang="${language}">${code}</code></pre>`;
    index += 1;
  }

  return html || '<p></p>';
}

function thinkingPreviewLines(message) {
  const primary = message.summaryText || message.text || '';
  return String(primary)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3);
}

function renderThinking(message) {
  const previewLines = thinkingPreviewLines(message);
  const expandedBody = message.text || '';
  const hasDetails = expandedBody && expandedBody !== (message.summaryText || '');
  return `
    <div class="messageBubble reasoning compact">
      <div class="messageMeta">
        <span>思考</span>
        <span>${escapeHtml(message.status || '进行中')}</span>
      </div>
      ${previewLines.length ? `
        <div class="thinkingPreview">
          ${previewLines.map((line) => `<div class="thinkingLine">${escapeHtml(line)}</div>`).join('')}
        </div>
      ` : '<div class="muted">正在思考…</div>'}
      ${hasDetails ? `
        <details class="thinkingDetails">
          <summary>展开详情</summary>
          <pre>${escapeHtml(expandedBody)}</pre>
        </details>
      ` : ''}
    </div>
  `;
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

function messageRoleLabel(role) {
  if (role === 'user') return '用户';
  if (role === 'assistant') return '助手';
  if (role === 'reasoning') return '思考';
  return role || '消息';
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
  const status = String(thread.status || '').toLowerCase();
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

function getBusyThread() {
  return state.threads.find((thread) => isThreadBusy(thread)) || null;
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
  if (kind.startsWith('item/') && (kind.includes('/tool/') || kind.includes('/commandexecution/') || kind.includes('/mcp'))) return true;
  return false;
}

function buildToolActivityCards(thread) {
  const events = (thread?.details?.events || []).filter((event) => isToolEvent(event));
  const cards = new Map();
  for (const event of events) {
    const key = String(event.itemId || event.callId || event.id || `${event.kind}:${event.method || ''}`);
    const current = cards.get(key) || {
      id: key,
      title: event.itemType ? `工具 ${event.itemType}` : '工具调用',
      status: '运行中',
      updatedAt: event.timestamp || new Date().toISOString(),
      output: '',
      method: event.method || null,
    };

    if (event.kind === 'item_started') {
      current.title = event.itemType ? `工具 ${event.itemType}` : current.title;
      current.status = '运行中';
    } else if (event.kind === 'item_completed') {
      current.title = event.itemType ? `工具 ${event.itemType}` : current.title;
      current.status = '已完成';
    } else if (event.kind === 'command') {
      current.title = '命令执行';
      current.status = '运行中';
      current.output = event.output || `${current.output}${event.delta || ''}`;
    } else if (event.kind === 'tool_event') {
      const method = String(event.method || '');
      current.title = method || current.title;
      current.method = method;
      current.status = method.split('/').slice(-1)[0] || current.status;
      if (typeof event.delta === 'string') {
        current.output = `${current.output}${event.delta}`;
      }
    } else {
      current.title = event.kind || current.title;
    }

    current.updatedAt = event.timestamp || current.updatedAt;
    cards.set(key, current);
  }
  return [...cards.values()]
    .sort((left, right) => new Date(left.updatedAt || 0).getTime() - new Date(right.updatedAt || 0).getTime())
    .slice(-24);
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
  return signal?.params?.threadId
    || signal?.threadId
    || signal?.params?.conversationId
    || signal?.conversationId
    || fallback;
}

function findRequestUserInputSignal(value, depth = 0) {
  if (!value || depth > 8) return null;
  if (typeof value === 'string') {
    for (const payload of parsePossiblePayloads(value)) {
      const found = findRequestUserInputSignal(payload, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRequestUserInputSignal(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;

  const method = String(value.method || value.type || value.kind || '').trim();
  if (
    (
      method === 'item/tool/requestUserInput'
      || method === 'item.tool.requestUserInput'
      || method === 'requestUserInput'
    )
    && Array.isArray(value.params?.questions)
  ) {
    return {
      method: 'item/tool/requestUserInput',
      params: value.params,
      threadId: extractThreadIdFromSignal(value, null),
    };
  }

  for (const key of Object.keys(value)) {
    const found = findRequestUserInputSignal(value[key], depth + 1);
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

function detectAskUserFromRawRequests(threadId) {
  const now = Date.now();
  const freshnessWindowMs = 15 * 60 * 1000;
  for (const entry of sortedRequests()) {
    const timestampMs = toTimestampMs(entry.timestamp);
    if (timestampMs && (now - timestampMs) > freshnessWindowMs) {
      break;
    }

    const requestSignal = findRequestUserInputSignal(entry.request?.body);
    const responseSignal = findRequestUserInputSignal(entry.response?.body);
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
      requestId: entry.id,
      timestamp: entry.timestamp,
    };
  }
  return null;
}

function latestResolvedAskUserAt(threadId) {
  return state.approvals
    .filter((item) => item.method === 'item/tool/requestUserInput' && item.status !== 'pending')
    .filter((item) => !threadId || !item.threadId || item.threadId === threadId)
    .reduce((max, item) => Math.max(max, toTimestampMs(item.resolvedAt || item.createdAt)), 0);
}

function getActiveAskUserContext() {
  const selectedThreadId = getSelectedThread()?.id || state.selectedThreadId || null;
  const pendingApprovals = state.approvals
    .filter((item) => item.status === 'pending' && item.method === 'item/tool/requestUserInput')
    .filter((item) => !selectedThreadId || !item.threadId || item.threadId === selectedThreadId)
    .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());

  const networkSignal = detectAskUserFromRawRequests(selectedThreadId);
  if (pendingApprovals.length > 0) {
    return {
      source: 'approval',
      approval: pendingApprovals[0],
      detectedFromNetwork: Boolean(networkSignal),
    };
  }
  if (!networkSignal) return null;

  const signalTs = toTimestampMs(networkSignal.timestamp);
  const resolvedTs = latestResolvedAskUserAt(selectedThreadId);
  if (resolvedTs && signalTs && signalTs <= resolvedTs) return null;
  return {
    source: 'network',
    signal: networkSignal,
  };
}

function pruneAskUserDrafts() {
  const pendingIds = new Set(
    state.approvals
      .filter((item) => item.status === 'pending' && item.method === 'item/tool/requestUserInput')
      .map((item) => item.id),
  );
  for (const approvalId of Object.keys(state.askUserDraft || {})) {
    if (!pendingIds.has(approvalId)) {
      clearAskUserDraft(approvalId);
    }
  }
}

function focusConversationForAskUser() {
  if (!getActiveAskUserContext()) return;
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
      command = { itemId: entry.itemId, turnId: entry.turnId, threadId: entry.threadId, callId: entry.callId, output: '', updatedAt: entry.timestamp || new Date().toISOString() };
      thread.details.commandLog.push(command);
    }
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
  if (event.type === 'approval.pending') {
    state.approvals = [event.payload, ...state.approvals.filter((item) => item.id !== event.payload.id)];
    if (event.payload.method === 'item/tool/requestUserInput') {
      setActiveTab('conversation');
      state.scrollIntent.conversation = true;
    }
    pruneAskUserDrafts();
    return;
  }
  if (event.type === 'approval.resolved') {
    state.approvals = state.approvals.map((item) => item.id === event.payload.id ? event.payload : item);
    clearAskUserDraft(event.payload.id);
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
        <button id="takeover" class="button secondary">接管控制</button>
        <button id="refresh" class="button secondary">刷新</button>
      </div>
    </div>
  `;
}

function renderSidebar() {
  const selected = getSelectedThread();
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
            <div class="key">消息数</div><div>${selected.details?.messages?.filter((entry) => entry.role !== 'reasoning').length || 0}</div>
            <div class="key">思考数</div><div>${selected.details?.messages?.filter((entry) => entry.role === 'reasoning').length || 0}</div>
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

function renderConversation(thread) {
  const messages = sortedMessages(thread);
  const toolCards = buildToolActivityCards(thread);
  const busy = isThreadBusy(thread);
  return h`
    <div class="panel">
      <div class="panelTitle">
        <h2>对话</h2>
        <div class="toolbar">
          <span class="panelSubtle">${thread ? escapeHtml(thread.title || thread.id) : '未选择线程'}</span>
          <button id="toggle-timeline" class="button secondary">${state.showTimeline ? '隐藏时间线' : '显示时间线'}</button>
        </div>
      </div>
      ${thread ? `
        <div class="messageList scrollArea">
          ${messages.map((message) => {
            if (message.role === 'reasoning') {
              return renderThinking(message);
            }
            return `
              <div class="messageBubble ${message.role === 'user' ? 'user' : 'assistant'}">
                <div class="messageMeta">
                  <span>${escapeHtml(messageRoleLabel(message.role))}</span>
                  <span>${escapeHtml(formatTime(message.updatedAt))}</span>
                </div>
                ${message.role === 'assistant'
                  ? `<div class="markdownContent">${renderMarkdown(message.text || '')}</div>`
                  : `<pre>${escapeHtml(message.text || '')}</pre>`}
              </div>
            `;
          }).join('')}
          ${toolCards.length ? `
            <div class="toolActivityWrap">
              <div class="toolActivityTitle">工具调用</div>
              <div class="toolActivityList">
                ${toolCards.map((card) => `
                  <div class="toolActivityCard ${card.status === '已完成' ? 'done' : 'running'}">
                    <div class="toolActivityHead">
                      <strong>${escapeHtml(card.title || '工具调用')}</strong>
                      <span class="pill ${card.status === '已完成' ? 'status-ready' : 'status-starting'}">${escapeHtml(card.status || '运行中')}</span>
                    </div>
                    <div class="panelSubtle">${escapeHtml(formatTime(card.updatedAt))}</div>
                    ${card.output ? `<pre>${escapeHtml(compactText(card.output, 240))}</pre>` : ''}
                  </div>
                `).join('')}
              </div>
            </div>
          ` : ''}
          ${busy ? `
            <div class="messageBubble assistant waiting">
              <div class="messageMeta">
                <span>助手</span>
                <span>处理中</span>
              </div>
              <div class="waitingRow">
                <span class="dotPulse" aria-hidden="true"></span>
                <span>正在等待最终结果，请勿重复发送。</span>
              </div>
            </div>
          ` : ''}
          ${(!messages.length && !toolCards.length && !busy) ? '<div class="emptyState">暂无消息。</div>' : ''}
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
  if (approval.method === 'item/tool/requestUserInput') {
    return `
      ${(approval.params.questions || []).map((question) => `
        <label style="display:block; margin-bottom: 10px;">
          <div class="panelSubtle">${escapeHtml(question.header || question.id)}</div>
          <div style="margin:6px 0 8px;">${escapeHtml(question.question)}</div>
          <input data-question-id="${question.id}" data-approval-form="${approval.id}" placeholder="请输入你的回答" />
        </label>
      `).join('')}
      <div class="toolbar">
        <button class="button primary" data-approval-id="${approval.id}" data-method="${approval.method}" data-decision="submitAnswers">提交</button>
      </div>
    `;
  }
  if (approval.method === 'mcpServer/elicitation/request') {
    return `
      <label style="display:block; margin-bottom: 10px;">
        <div class="panelSubtle">可选结构化内容</div>
        <textarea data-approval-json="${approval.id}" placeholder='{"key":"value"}'></textarea>
      </label>
      <div class="toolbar">
        <button class="button primary" data-approval-id="${approval.id}" data-method="${approval.method}" data-decision="accept">接受</button>
        <button class="button secondary" data-approval-id="${approval.id}" data-method="${approval.method}" data-decision="decline">拒绝</button>
        <button class="button danger" data-approval-id="${approval.id}" data-method="${approval.method}" data-decision="cancel">取消</button>
      </div>
    `;
  }
  return `
    <div class="toolbar">
      <button class="button primary" data-approval-id="${approval.id}" data-method="${approval.method}" data-decision="accept">通过</button>
      <button class="button danger" data-approval-id="${approval.id}" data-method="${approval.method}" data-decision="decline">拒绝</button>
    </div>
  `;
}

function buildApprovalPayload(approvalId, method, action) {
  if (method === 'item/tool/requestUserInput') {
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
  if (method === 'mcpServer/elicitation/request') {
    const textarea = document.querySelector(`[data-approval-json="${approvalId}"]`);
    const content = textarea?.value?.trim();
    if (!content) return { action };
    try {
      return { action, content: JSON.parse(content) };
    } catch {
      return { action, content };
    }
  }
  return { decision: action === 'accept' ? 'accept' : 'decline' };
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
              <h3>${escapeHtml(approval.method)}</h3>
              <span class="pill ${approval.status === 'pending' ? 'status-starting' : 'status-ready'}">${escapeHtml(approval.status)}</span>
            </div>
            <div class="panelSubtle">线程：${escapeHtml(approval.threadId || '—')} · ${escapeHtml(formatTime(approval.createdAt))}</div>
            <div class="detailSection"><pre>${escapeHtml(JSON.stringify(approval.params, null, 2))}</pre></div>
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
    <div class="panel">
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
      <div class="contentSplit" style="margin-top: 10px;">
        <div class="scrollArea requestList">
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
        <div class="detailPane">
          ${selected ? `
            <div class="detailSection panelSoft">
              <h4>拦截记录（结构化）</h4>
              <pre>${escapeHtml(JSON.stringify(selected, null, 2))}</pre>
            </div>
          ` : '<div class="emptyState">请选择一条拦截记录。</div>'}
          <div class="detailSection panelSoft">
            <h4>错误日志</h4>
            <div class="logList">
              ${errorLogs.map((entry) => `
                <div class="logLine">
                  <span class="pill ${statusClass(entry.level)}">${escapeHtml(entry.level || 'LOG')}</span>
                  <span class="panelSubtle">${escapeHtml(formatTime(entry.timestamp))}</span>
                  <div class="logMessage">${escapeHtml(entry.message || entry.raw || '')}</div>
                </div>
              `).join('') || '<div class="emptyState">暂无错误日志。</div>'}
            </div>
          </div>
          <div class="detailSection panelSoft">
            <h4>拦截原始 JSONL（尾部）</h4>
            <pre>${escapeHtml((state.interceptedRawLines || []).slice(-120).join('\n'))}</pre>
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
    </div>
  `;
}

function renderMain() {
  const selected = getSelectedThread();
  const busyThread = getBusyThread();
  const isBusy = Boolean(busyThread);
  const askUserContext = getActiveAskUserContext();
  const activeAskUserApproval = askUserContext?.source === 'approval' ? askUserContext.approval : null;
  const shouldShowAskUserComposer = Boolean(activeAskUserApproval || askUserContext?.source === 'network');
  const isReadOnly = state.session?.viewerRole !== 'controller';
  const composerDisabled = state.sendingPrompt || isBusy || shouldShowAskUserComposer || isReadOnly;
  const lockReason = isReadOnly
    ? '当前浏览器是只读模式，请先点击“接管控制”。'
    : (isBusy
      ? `线程 ${busyThread?.title || compactId(busyThread?.id || '')} 正在执行，等待结束后再发送。`
      : '');
  const mobile = isMobileViewport();
  const pendingApprovals = state.approvals.filter((item) => item.status === 'pending').length;
  return h`
    <div class="column mainColumn">
      ${mobile ? `
        <div class="panel mobileQuickPanel">
          <div class="mobileQuickRow">
            <button class="button secondary" data-mobile-open="threads">线程 (${state.threads.length})</button>
            <button class="button secondary" data-tab="approvals">审批 (${pendingApprovals})</button>
            <button class="button secondary" data-tab="requests">请求 (${state.rawRequests.length})</button>
            <button class="button secondary" data-tab="logs">日志</button>
          </div>
          <div class="mobileCurrentThread">当前：${escapeHtml(selected ? (selected.title || compactId(selected.id, 10, 8)) : '新线程')}</div>
        </div>
      ` : ''}
      <div class="panel mainContentPanel">
        ${state.tab === 'conversation' ? renderConversation(selected) : ''}
        ${state.tab === 'requests' ? renderRequests() : ''}
        ${state.tab === 'approvals' ? renderApprovals() : ''}
        ${state.tab === 'commands' ? renderCommands(selected) : ''}
        ${state.tab === 'logs' ? renderLogs() : ''}
      </div>
      <div class="panel bottomControlPanel">
        <div class="panelTitle" style="margin-top: 8px;">
          <h2>${shouldShowAskUserComposer ? '待处理交互' : '输入区'}</h2>
          <span class="panelSubtle">${selected ? `发送到 ${escapeHtml(selected.title || selected.id)}` : '当前未选择线程：发送后将自动创建新线程'}</span>
        </div>
        ${selected ? '<div class="notice">你正在继续当前已选线程。</div>' : ''}
        ${lockReason ? `<div class="notice">${escapeHtml(lockReason)}</div>` : ''}
        ${shouldShowAskUserComposer ? renderAskUserComposer(askUserContext) : `
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
        <div class="tabs bottomTabs" style="margin-top: 10px;">
          ${['conversation', 'requests', 'approvals', 'commands', 'logs'].map((tab) => `
            <button class="button tabButton ${state.tab === tab ? 'active' : ''}" data-tab="${tab}">${tabLabel(tab)}</button>
          `).join('')}
        </div>
      </div>
    </div>
  `;
}

function renderModal() {
  if (!state.modal) return '';

  const selected = getSelectedThread();
  const selectedRequest = getSelectedRequest();
  const latestApproval = [...state.approvals].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

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
    subtitle = latestApproval ? `${latestApproval.method} · ${formatTime(latestApproval.createdAt)}` : '暂无审批';
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
  }

  return h`
    <div class="modalOverlay" data-modal-dismiss="1">
      <div class="modalCard" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
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
          <div class="panelSubtle">${escapeHtml(latestApproval.method)}</div>
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

  bindActions();
  syncScrollPositions();
}

function bindActions() {
  document.querySelectorAll('[data-thread-id]').forEach((node) => {
    node.onclick = async () => {
      const threadId = node.dataset.threadId;
      const shouldCloseModal = node.dataset.closeModal === '1';
      setSelectedThread(threadId);
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

  document.querySelectorAll('[data-mobile-open]').forEach((node) => {
    node.onclick = () => {
      state.modal = node.dataset.mobileOpen || null;
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
      if (selected && needsThreadHistory(selected)) {
        await loadThread(selected.id);
      }
      if (node.dataset.tab === 'logs') {
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
      if (method === 'item/tool/requestUserInput' && Object.keys(body.answers || {}).length === 0) {
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
    const busyThread = getBusyThread();
    if (busyThread) {
      alert(`线程 ${busyThread.title || compactId(busyThread.id)} 仍在执行中，请等待完成后再发送。`);
      return;
    }
    if (getActiveAskUserContext()) {
      alert('当前存在待处理 ask-user 交互，请先完成该交互。');
      return;
    }
    const prompt = document.querySelector('#prompt-input')?.value.trim();
    if (!prompt) return;
    const selected = getSelectedThread();
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

  const toggleTimeline = document.querySelector('#toggle-timeline');
  if (toggleTimeline) {
    toggleTimeline.onclick = () => {
      state.showTimeline = !state.showTimeline;
      render();
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
  state.approvals = state.session.approvals || [];
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
    if (selected && needsThreadHistory(selected)) {
      try {
        await loadThread(state.selectedThreadId);
      } catch (error) {
        console.warn('Failed to hydrate thread history', error);
      }
    }
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
      state.approvals = payload.data.approvals || [];
      pruneAskUserDrafts();
      if (!state.selectedThreadId && state.threads.length > 0) {
        setSelectedThread(state.threads[0].id);
      }
      const selected = getSelectedThread();
      if (selected && needsThreadHistory(selected)) {
        loadThread(selected.id).then(() => render()).catch(() => {});
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
