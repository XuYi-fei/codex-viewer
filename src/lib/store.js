import { nowIso, sortByUpdatedDesc } from './utils.js';

function normalizeStatus(status) {
  if (status == null) return null;
  if (typeof status === 'string') return status;
  if (typeof status === 'object') {
    if (typeof status.type === 'string') return status.type;
    try {
      return JSON.stringify(status);
    } catch {
      return String(status);
    }
  }
  return String(status);
}

function isBusyStatus(status) {
  const text = String(normalizeStatus(status) || '').toLowerCase();
  if (!text) return false;
  return (
    text.includes('progress')
    || text.includes('running')
    || text.includes('active')
    || text.includes('stream')
    || text === 'busy'
  );
}

function pickThreadSummary(thread = {}) {
  const title = thread.title || thread.name || thread.preview || thread.summary || 'Untitled thread';
  const status = normalizeStatus(thread.status);
  return {
    id: thread.id,
    title,
    status,
    isBusy: isBusyStatus(status),
    cwd: thread.cwd || null,
    updatedAt: thread.updatedAt || thread.updated_at || nowIso(),
    metadata: thread.metadata || null,
    raw: thread,
  };
}

function createThreadDetails(id) {
  return { id, events: [], messages: [], commandLog: [], planLog: [] };
}

function toIsoTimestamp(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  }
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  return null;
}

function extractText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((entry) => extractText(entry)).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.value === 'string') return value.value;
    if (typeof value.content === 'string') return value.content;
    if (Array.isArray(value.content)) return value.content.map((entry) => extractText(entry)).filter(Boolean).join('\n');
  }
  return '';
}

function extractTextList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => extractText(entry)).filter(Boolean);
}

function extractFilePath(change) {
  if (!change || typeof change !== 'object') return null;
  return change.path || change.filePath || change.newPath || change.oldPath || null;
}

function buildFileChangeSummary(item) {
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  const paths = changes
    .map((change) => extractFilePath(change))
    .filter(Boolean);
  const uniquePaths = [...new Set(paths)];
  const count = uniquePaths.length || changes.length;
  const head = count === 1 ? 'Updated 1 file.' : `Updated ${count} files.`;
  if (!count) {
    return { count: 0, paths: [], text: 'Updated files.' };
  }

  const preview = uniquePaths.slice(0, 6).map((filePath) => `- \`${filePath}\``).join('\n');
  const more = uniquePaths.length > 6 ? `\n- …and ${uniquePaths.length - 6} more` : '';
  return {
    count,
    paths: uniquePaths,
    text: `${head}\n${preview}${more}`,
  };
}

function isToolItemType(value) {
  const text = String(value || '').toLowerCase();
  return text.includes('tool') || text.includes('command') || text.includes('mcp');
}

function isToolEvent(entry) {
  if (!entry) return false;
  const kind = String(entry.kind || '').toLowerCase();
  if (kind === 'tool_event' || kind === 'command') return true;
  if ((kind === 'item_started' || kind === 'item_completed') && isToolItemType(entry.itemType)) return true;
  if (kind.startsWith('item/') && (kind.includes('/tool/') || kind.includes('/commandexecution/') || kind.includes('/mcp'))) return true;
  if (kind === 'item_loaded' && isToolItemType(entry.itemType)) return true;
  return false;
}

function toolEventKey(entry = {}) {
  return [
    entry.kind || '',
    entry.threadId || '',
    entry.turnId || '',
    entry.itemId || '',
    entry.callId || '',
    entry.method || '',
    entry.timestamp || '',
  ].join('|');
}

function commandLogKey(entry = {}) {
  return [
    entry.threadId || '',
    entry.turnId || '',
    entry.itemId || '',
    entry.callId || '',
  ].join('|');
}

function mergeCommandLogs(current = [], previous = []) {
  const merged = new Map();
  for (const entry of [...current, ...previous]) {
    const key = commandLogKey(entry);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...entry });
      continue;
    }
    const next = { ...existing };
    const existingTs = Date.parse(existing.updatedAt || 0) || 0;
    const entryTs = Date.parse(entry.updatedAt || 0) || 0;
    if (entryTs >= existingTs) {
      Object.assign(next, entry);
    } else {
      if ((entry.output || '').length > (next.output || '').length) next.output = entry.output || next.output;
      if (next.exitCode == null && entry.exitCode != null) next.exitCode = entry.exitCode;
      if (next.status == null && entry.status != null) next.status = entry.status;
      if (next.durationMs == null && entry.durationMs != null) next.durationMs = entry.durationMs;
    }
    merged.set(key, next);
  }
  return [...merged.values()];
}

export class ViewerStore {
  constructor({ workspacePath, localUrl, publicUrl, pairUrl, proxyPort, appServerPort }) {
    this.workspacePath = workspacePath;
    this.localUrl = localUrl;
    this.publicUrl = publicUrl || null;
    this.pairUrl = pairUrl;
    this.proxyPort = proxyPort;
    this.appServerPort = appServerPort;
    this.status = {
      proxy: 'starting',
      appServer: 'starting',
      web: 'starting',
    };
    this.threadMap = new Map();
    this.threadDetails = new Map();
    this.hiddenThreadIds = new Set();
    this.approvals = new Map();
    this.sessions = new Map();
    this.writerSessionId = null;
    this.listeners = new Set();
  }

  emit(event) {
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  ensureThreadDetail(threadId) {
    if (!this.threadDetails.has(threadId)) {
      this.threadDetails.set(threadId, createThreadDetails(threadId));
    }
    return this.threadDetails.get(threadId);
  }

  ensureThreadSummary(threadId) {
    let summary = this.threadMap.get(threadId);
    if (!summary) {
      summary = {
        id: threadId,
        title: 'Untitled thread',
        status: 'idle',
        isBusy: false,
        activeTurnId: null,
        lastTurnStatus: null,
        cwd: null,
        updatedAt: nowIso(),
        metadata: null,
        raw: {},
      };
      this.threadMap.set(threadId, summary);
    }
    return summary;
  }

  isThreadHidden(threadId) {
    return this.hiddenThreadIds.has(threadId);
  }

  setStatus(name, value, error = null) {
    this.status[name] = value;
    this.emit({ type: 'system.status', payload: { name, value, error }, timestamp: nowIso() });
  }

  registerSession(session) {
    this.sessions.set(session.id, session);
    if (!this.writerSessionId) {
      this.writerSessionId = session.id;
    }
  }

  getSessionRole(sessionId) {
    return this.writerSessionId === sessionId ? 'controller' : 'viewer';
  }

  claimWriter(sessionId) {
    this.writerSessionId = sessionId;
    this.emit({ type: 'system.writerChanged', payload: { sessionId }, timestamp: nowIso() });
  }

  upsertThread(thread) {
    if (!thread?.id || this.isThreadHidden(thread.id)) return null;
    const summary = pickThreadSummary(thread);
    const previous = this.threadMap.get(summary.id) || {};
    const merged = { ...previous, ...summary };
    if (summary.status == null) {
      merged.status = previous.status || 'idle';
      merged.isBusy = Boolean(previous.isBusy);
    } else {
      merged.isBusy = isBusyStatus(summary.status);
      if (!merged.status) merged.status = previous.status || 'idle';
    }
    if (!merged.status) merged.status = 'idle';
    this.threadMap.set(summary.id, merged);
    this.ensureThreadDetail(summary.id);
    this.emit({ type: 'thread.updated', payload: merged, timestamp: nowIso() });
    return merged;
  }

  markTurnStarted({ threadId, turnId, timestamp = nowIso() }) {
    if (!threadId) return;
    if (this.isThreadHidden(threadId)) return;
    const summary = this.ensureThreadSummary(threadId);
    summary.status = 'in_progress';
    summary.isBusy = true;
    summary.activeTurnId = turnId || summary.activeTurnId || null;
    summary.lastTurnStatus = 'started';
    summary.updatedAt = timestamp;
    this.emit({
      type: 'thread.updated',
      payload: { ...summary, details: this.ensureThreadDetail(threadId) },
      timestamp: nowIso(),
    });
  }

  markTurnCompleted({ threadId, turnId, status = 'completed', timestamp = nowIso() }) {
    if (!threadId) return;
    if (this.isThreadHidden(threadId)) return;
    const summary = this.ensureThreadSummary(threadId);
    const normalizedStatus = String(normalizeStatus(status) || 'completed');
    summary.lastTurnStatus = normalizedStatus;
    summary.status = normalizedStatus === 'completed' ? 'idle' : normalizedStatus;
    summary.isBusy = false;
    if (!turnId || summary.activeTurnId === turnId) summary.activeTurnId = null;
    summary.updatedAt = timestamp;
    this.emit({
      type: 'thread.updated',
      payload: { ...summary, details: this.ensureThreadDetail(threadId) },
      timestamp: nowIso(),
    });
  }

  addThreadEvent(threadId, entry) {
    if (!threadId || this.isThreadHidden(threadId)) return;
    const detail = this.ensureThreadDetail(threadId);
    detail.events.push(entry);
    if (detail.events.length > 500) detail.events = detail.events.slice(-500);
    this.emit({ type: 'thread.event', payload: entry, timestamp: nowIso() });
  }

  ensureMessage({ threadId, turnId, itemId, role }) {
    const detail = this.ensureThreadDetail(threadId);
    let message = detail.messages.find((entry) => entry.turnId === turnId && entry.itemId === itemId && entry.role === role);
    if (!message) {
      message = {
        id: `${threadId}:${turnId}:${itemId}:${role}`,
        role,
        threadId,
        turnId,
        itemId,
        text: '',
        summaryText: '',
        updatedAt: nowIso(),
        createdAt: nowIso(),
        status: 'streaming',
      };
      detail.messages.push(message);
    }
    return message;
  }

  startItem({ threadId, turnId, item }) {
    if (!item?.type) {
      this.addThreadEvent(threadId, { kind: 'item_started', threadId, turnId, itemType: 'unknown', timestamp: nowIso() });
      return;
    }
    const detail = this.ensureThreadDetail(threadId);

    if (item.type === 'userMessage') {
      const text = Array.isArray(item.content)
        ? item.content.map((entry) => entry.text || '').join('')
        : item.text || '';
      const exists = detail.messages.find((entry) => entry.turnId === turnId && entry.itemId === item.id && entry.role === 'user');
      if (!exists) {
        detail.messages.push({
          id: `${threadId}:${turnId}:${item.id}:user`,
          role: 'user',
          threadId,
          turnId,
          itemId: item.id,
          text,
          summaryText: '',
          updatedAt: nowIso(),
          createdAt: nowIso(),
          status: 'completed',
        });
      }
    }

    if (item.type === 'agentMessage') {
      const message = this.ensureMessage({ threadId, turnId, itemId: item.id, role: 'assistant' });
      if (typeof item.text === 'string' && item.text && !message.text) {
        message.text = item.text;
      }
      message.phase = item.phase || message.phase || null;
    }

    if (item.type === 'reasoning') {
      this.ensureMessage({ threadId, turnId, itemId: item.id, role: 'reasoning' });
    }

    if (item.type === 'commandExecution') {
      let command = detail.commandLog.find((entry) => entry.itemId === item.id);
      if (!command) {
        command = {
          threadId,
          turnId,
          itemId: item.id,
          callId: item.processId || item.callId || item.id,
          command: item.command || '',
          cwd: item.cwd || null,
          status: item.status || 'in_progress',
          output: item.aggregatedOutput || '',
          updatedAt: nowIso(),
        };
        detail.commandLog.push(command);
      } else {
        if (typeof item.command === 'string' && item.command) command.command = item.command;
        if (typeof item.cwd === 'string' && item.cwd) command.cwd = item.cwd;
        if (item.status != null) command.status = item.status;
        if (typeof item.aggregatedOutput === 'string' && item.aggregatedOutput.length >= (command.output || '').length) {
          command.output = item.aggregatedOutput;
        }
        command.updatedAt = nowIso();
      }

      this.addThreadEvent(threadId, {
        kind: 'command',
        threadId,
        turnId,
        itemId: item.id,
        callId: command.callId || null,
        command: command.command || '',
        status: command.status || 'in_progress',
        output: command.output || '',
        timestamp: nowIso(),
      });
    }

    this.addThreadEvent(threadId, {
      kind: 'item_started',
      threadId,
      turnId,
      itemType: item.type,
      itemId: item.id,
      text: item.type === 'userMessage' ? (Array.isArray(item.content) ? item.content.map((entry) => entry.text || '').join('') : item.text || '') : undefined,
      command: item.type === 'commandExecution' ? (item.command || '') : undefined,
      callId: item.type === 'commandExecution' ? (item.processId || item.callId || item.id || null) : undefined,
      label: item.type === 'reasoning' ? 'Thinking started' : `${item.type} started`,
      timestamp: nowIso(),
    });
  }

  completeItem({ threadId, turnId, item }) {
    const detail = this.ensureThreadDetail(threadId);
    const completedAt = nowIso();

    if (item?.type === 'agentMessage') {
      const message = this.ensureMessage({ threadId, turnId, itemId: item.id, role: 'assistant' });
      if (typeof item.text === 'string') message.text = item.text;
      message.phase = item.phase || message.phase || null;
      message.status = 'completed';
      message.updatedAt = completedAt;
    }

    if (item?.type === 'reasoning') {
      const message = this.ensureMessage({ threadId, turnId, itemId: item.id, role: 'reasoning' });
      if (Array.isArray(item.content) && !message.text) {
        message.text = item.content.map((entry) => entry.text || '').join('');
      }
      if (Array.isArray(item.summary) && !message.summaryText) {
        message.summaryText = item.summary.map((entry) => entry.text || '').join('');
      }
      message.status = 'completed';
      message.updatedAt = completedAt;
    }

    if (item?.type === 'commandExecution') {
      let command = detail.commandLog.find((entry) => entry.itemId === item.id);
      if (!command) {
        command = {
          threadId,
          turnId,
          itemId: item.id,
          callId: item.processId || item.callId || item.id,
          output: '',
          updatedAt: completedAt,
        };
        detail.commandLog.push(command);
      }
      if (typeof item.command === 'string' && item.command) command.command = item.command;
      if (typeof item.cwd === 'string' && item.cwd) command.cwd = item.cwd;
      if (typeof item.aggregatedOutput === 'string' && item.aggregatedOutput.length >= (command.output || '').length) {
        command.output = item.aggregatedOutput;
      }
      if (item.status != null) command.status = item.status;
      if (item.exitCode != null) command.exitCode = item.exitCode;
      if (item.durationMs != null) command.durationMs = item.durationMs;
      command.updatedAt = completedAt;
      this.addThreadEvent(threadId, {
        kind: 'command',
        threadId,
        turnId,
        itemId: item.id,
        callId: command.callId || null,
        output: command.output || '',
        status: command.status || null,
        exitCode: command.exitCode ?? null,
        timestamp: completedAt,
      });
    }

    if (item?.type === 'fileChange') {
      const summary = buildFileChangeSummary(item);
      const message = this.ensureMessage({ threadId, turnId, itemId: item.id, role: 'assistant' });
      message.text = summary.text;
      message.phase = item.status || message.phase || null;
      message.status = 'completed';
      message.updatedAt = completedAt;
      this.addThreadEvent(threadId, {
        kind: 'file_change',
        threadId,
        turnId,
        itemId: item.id,
        label: 'Files updated',
        count: summary.count,
        files: summary.paths,
        status: item.status || null,
        timestamp: completedAt,
      });
    }

    if (item?.type === 'userMessage') {
      const userMessage = detail.messages.find((entry) => entry.turnId === turnId && entry.itemId === item.id && entry.role === 'user');
      if (userMessage) {
        userMessage.status = 'completed';
        userMessage.updatedAt = completedAt;
      }
    }

    this.addThreadEvent(threadId, {
      kind: 'item_completed',
      threadId,
      turnId,
      itemType: item?.type || 'unknown',
      itemId: item?.id || null,
      label: item?.type === 'reasoning' ? 'Thinking completed' : `${item?.type || 'item'} completed`,
      timestamp: completedAt,
    });
  }

  appendMessageDelta({ threadId, turnId, itemId, delta, role = 'assistant' }) {
    const message = this.ensureMessage({ threadId, turnId, itemId, role });
    message.text += delta;
    message.updatedAt = nowIso();
    this.addThreadEvent(threadId, {
      kind: role === 'assistant' ? 'assistant_delta' : 'message',
      role,
      threadId,
      turnId,
      itemId,
      delta,
      text: message.text,
      timestamp: nowIso(),
    });
  }

  appendReasoningDelta({ threadId, turnId, itemId, delta, contentIndex = 0 }) {
    const message = this.ensureMessage({ threadId, turnId, itemId, role: 'reasoning' });
    if (message.lastContentIndex != null && message.lastContentIndex !== contentIndex && message.text) {
      message.text += '\n';
    }
    message.lastContentIndex = contentIndex;
    message.text += delta;
    message.updatedAt = nowIso();
    this.addThreadEvent(threadId, {
      kind: 'reasoning_delta',
      threadId,
      turnId,
      itemId,
      delta,
      contentIndex,
      timestamp: nowIso(),
    });
  }

  appendReasoningSummaryPart({ threadId, turnId, itemId, summaryIndex }) {
    const message = this.ensureMessage({ threadId, turnId, itemId, role: 'reasoning' });
    if (message.summaryText) {
      message.summaryText += '\n';
    }
    message.lastSummaryIndex = summaryIndex;
    message.updatedAt = nowIso();
    this.addThreadEvent(threadId, {
      kind: 'reasoning_summary_part',
      threadId,
      turnId,
      itemId,
      summaryIndex,
      timestamp: nowIso(),
    });
  }

  appendReasoningSummaryDelta({ threadId, turnId, itemId, delta, summaryIndex = 0 }) {
    const message = this.ensureMessage({ threadId, turnId, itemId, role: 'reasoning' });
    if (message.lastSummaryIndex != null && message.lastSummaryIndex !== summaryIndex && message.summaryText) {
      message.summaryText += '\n';
    }
    message.lastSummaryIndex = summaryIndex;
    message.summaryText += delta;
    message.updatedAt = nowIso();
    this.addThreadEvent(threadId, {
      kind: 'reasoning_summary_delta',
      threadId,
      turnId,
      itemId,
      summaryIndex,
      delta,
      timestamp: nowIso(),
    });
  }

  appendCommandDelta({ threadId, turnId, itemId, callId, delta }) {
    const detail = this.ensureThreadDetail(threadId);
    let command = detail.commandLog.find((entry) => entry.itemId === itemId);
    if (!command) {
      command = { threadId, turnId, itemId, callId, output: '', updatedAt: nowIso() };
      detail.commandLog.push(command);
    }
    command.output += delta;
    command.updatedAt = nowIso();
    this.addThreadEvent(threadId, { kind: 'command', threadId, turnId, itemId, callId, delta, output: command.output, timestamp: nowIso() });
  }

  appendPlanDelta({ threadId, turnId, itemId, delta }) {
    const detail = this.ensureThreadDetail(threadId);
    detail.planLog.push({ threadId, turnId, itemId, delta, timestamp: nowIso() });
    this.addThreadEvent(threadId, { kind: 'plan', threadId, turnId, itemId, delta, timestamp: nowIso() });
  }

  hydrateThread(thread) {
    if (!thread?.id) return null;
    if (this.isThreadHidden(thread.id)) return null;

    const summary = pickThreadSummary(thread);
    const previous = this.threadMap.get(summary.id) || {};
    const merged = { ...previous, ...summary, raw: thread };
    if (summary.status == null) {
      merged.status = previous.status || 'idle';
      merged.isBusy = Boolean(previous.isBusy);
    }

    const turns = Array.isArray(thread.turns) ? thread.turns : [];
    const latestTurn = turns.length ? turns[turns.length - 1] : null;
    const latestTurnStatus = normalizeStatus(latestTurn?.status);
    if (latestTurnStatus) {
      const busy = isBusyStatus(latestTurnStatus);
      merged.isBusy = busy;
      merged.lastTurnStatus = latestTurnStatus;
      merged.activeTurnId = busy ? (latestTurn?.id || null) : null;
      merged.status = busy ? 'in_progress' : (latestTurnStatus === 'completed' ? 'idle' : latestTurnStatus);
    } else if (summary.status != null) {
      merged.isBusy = isBusyStatus(summary.status);
      if (!merged.status) merged.status = summary.status;
    }
    if (!merged.status) merged.status = 'idle';
    this.threadMap.set(summary.id, merged);

    const hasHydratableTurns = turns.some((turn) => Array.isArray(turn?.items) && turn.items.length > 0);
    const previousDetail = this.threadDetails.get(summary.id) || createThreadDetails(summary.id);
    const detail = hasHydratableTurns ? createThreadDetails(summary.id) : previousDetail;
    const fallbackTimestamp = toIsoTimestamp(thread.updatedAt) || nowIso();

    if (hasHydratableTurns) {
      for (const turn of turns) {
        const turnId = turn?.id || `turn-${detail.events.length + 1}`;
        const timestamp = fallbackTimestamp;
        const items = Array.isArray(turn?.items) ? turn.items : [];

        for (const item of items) {
          if (!item?.id || !item?.type) continue;

          if (item.type === 'userMessage') {
            detail.messages.push({
              id: `${summary.id}:${turnId}:${item.id}:user`,
              role: 'user',
              threadId: summary.id,
              turnId,
              itemId: item.id,
              text: extractText(item.content),
              summaryText: '',
              updatedAt: timestamp,
              createdAt: timestamp,
              status: 'completed',
            });
            continue;
          }

          if (item.type === 'agentMessage') {
            detail.messages.push({
              id: `${summary.id}:${turnId}:${item.id}:assistant`,
              role: 'assistant',
              threadId: summary.id,
              turnId,
              itemId: item.id,
              text: item.text || '',
              summaryText: '',
              phase: item.phase || null,
              updatedAt: timestamp,
              createdAt: timestamp,
              status: turn?.status === 'inProgress' ? 'streaming' : 'completed',
            });
            continue;
          }

          if (item.type === 'reasoning') {
            detail.messages.push({
              id: `${summary.id}:${turnId}:${item.id}:reasoning`,
              role: 'reasoning',
              threadId: summary.id,
              turnId,
              itemId: item.id,
              text: extractTextList(item.content).join('\n'),
              summaryText: extractTextList(item.summary).join('\n'),
              updatedAt: timestamp,
              createdAt: timestamp,
              status: turn?.status === 'inProgress' ? 'streaming' : 'completed',
            });
            continue;
          }

          if (item.type === 'commandExecution') {
            detail.commandLog.push({
              threadId: summary.id,
              turnId,
              itemId: item.id,
              callId: item.processId || item.id,
              command: item.command || '',
              cwd: item.cwd || null,
              status: item.status || null,
              exitCode: item.exitCode ?? null,
              durationMs: item.durationMs ?? null,
              output: item.aggregatedOutput || '',
              updatedAt: timestamp,
            });
            detail.events.push({
              kind: 'command',
              threadId: summary.id,
              turnId,
              itemId: item.id,
              callId: item.processId || item.id,
              output: item.aggregatedOutput || '',
              timestamp,
            });
            continue;
          }

          if (item.type === 'plan') {
            detail.planLog.push({
              threadId: summary.id,
              turnId,
              itemId: item.id,
              delta: item.text || '',
              timestamp,
            });
            detail.events.push({ kind: 'plan', threadId: summary.id, turnId, itemId: item.id, delta: item.text || '', timestamp });
            continue;
          }

          if (item.type === 'fileChange') {
            const fileSummary = buildFileChangeSummary(item);
            detail.messages.push({
              id: `${summary.id}:${turnId}:${item.id}:assistant`,
              role: 'assistant',
              threadId: summary.id,
              turnId,
              itemId: item.id,
              text: fileSummary.text,
              summaryText: '',
              phase: item.status || null,
              updatedAt: timestamp,
              createdAt: timestamp,
              status: turn?.status === 'inProgress' ? 'streaming' : 'completed',
            });
            detail.events.push({
              kind: 'file_change',
              threadId: summary.id,
              turnId,
              itemId: item.id,
              label: 'Files updated',
              count: fileSummary.count,
              files: fileSummary.paths,
              status: item.status || null,
              timestamp,
            });
            continue;
          }

          detail.events.push({
            kind: 'item_loaded',
            threadId: summary.id,
            turnId,
            itemId: item.id,
            itemType: item.type,
            label: `${item.type} loaded`,
            timestamp,
          });
        }

        if (turn?.error?.message) {
          detail.events.push({
            kind: 'turn_error',
            threadId: summary.id,
            turnId,
            message: turn.error.message,
            timestamp,
          });
        }

        detail.events.push({
          kind: turn?.status === 'completed' ? 'turn/completed' : 'turn/status',
          threadId: summary.id,
          turnId,
          status: turn?.status || 'unknown',
          timestamp,
        });
      }
    }

    if (hasHydratableTurns) {
      const previousToolEvents = (previousDetail.events || []).filter((entry) => isToolEvent(entry));
      if (previousToolEvents.length > 0) {
        const seen = new Set(detail.events.map((entry) => toolEventKey(entry)));
        for (const entry of previousToolEvents) {
          const key = toolEventKey(entry);
          if (seen.has(key)) continue;
          detail.events.push({ ...entry });
          seen.add(key);
        }
      }
      detail.commandLog = mergeCommandLogs(detail.commandLog || [], previousDetail.commandLog || []);
    }

    detail.messages.sort((left, right) => new Date(left.createdAt || left.updatedAt || 0).getTime() - new Date(right.createdAt || right.updatedAt || 0).getTime());
    detail.commandLog.sort((left, right) => new Date(left.updatedAt || 0).getTime() - new Date(right.updatedAt || 0).getTime());
    detail.events.sort((left, right) => new Date(left.timestamp || 0).getTime() - new Date(right.timestamp || 0).getTime());

    this.threadDetails.set(summary.id, detail);

    const hydrated = {
      ...merged,
      details: detail,
    };

    this.emit({ type: 'thread.updated', payload: hydrated, timestamp: nowIso() });
    return hydrated;
  }

  setApproval(approval) {
    if (!approval?.id) return;
    if (approval.threadId && this.isThreadHidden(approval.threadId)) return;
    const key = String(approval.id);
    const normalized = { ...approval, id: key };
    this.approvals.set(key, normalized);
    this.emit({ type: 'approval.pending', payload: normalized, timestamp: nowIso() });
  }

  removeThread(threadId, { reason = 'manual' } = {}) {
    if (!threadId) return false;
    this.hiddenThreadIds.add(threadId);
    for (const [approvalId, approval] of this.approvals.entries()) {
      if (approval?.threadId === threadId) {
        this.approvals.delete(approvalId);
      }
    }
    this.emit({ type: 'thread.removed', payload: { threadId, reason }, timestamp: nowIso() });
    return true;
  }

  resolveApproval(id, resolution) {
    const key = String(id);
    const item = this.approvals.get(key);
    if (!item) return;
    item.resolvedAt = nowIso();
    item.resolution = resolution;
    item.status = 'resolved';
    if (item.threadId && !this.isThreadHidden(item.threadId)) {
      this.addThreadEvent(item.threadId, {
        kind: 'approval/resolved',
        threadId: item.threadId,
        turnId: item.turnId || null,
        approvalId: item.id,
        method: item.method,
        timestamp: item.resolvedAt,
      });
    }
    this.emit({ type: 'approval.resolved', payload: item, timestamp: nowIso() });
  }

  getApproval(id) {
    if (!id) return null;
    const item = this.approvals.get(String(id));
    if (!item) return null;
    if (item.threadId && this.isThreadHidden(item.threadId)) return null;
    return item;
  }

  getApprovals() {
    return [...this.approvals.values()]
      .filter((entry) => !(entry?.threadId && this.isThreadHidden(entry.threadId)))
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  }

  getThreads() {
    return sortByUpdatedDesc([...this.threadMap.values()]
      .filter((thread) => !this.isThreadHidden(thread.id))
      .map((thread) => ({
      ...thread,
      details: this.threadDetails.get(thread.id) || createThreadDetails(thread.id),
    })), (thread) => thread.updatedAt);
  }

  getThread(threadId) {
    const thread = this.threadMap.get(threadId);
    if (!thread || this.isThreadHidden(threadId)) return null;
    return {
      ...thread,
      details: this.threadDetails.get(threadId) || createThreadDetails(threadId),
    };
  }

  exportThreadDetails({
    maxThreads = 300,
    maxEvents = 800,
    maxMessages = 600,
    maxCommandLog = 300,
    maxPlanLog = 300,
  } = {}) {
    const entries = [];
    for (const [threadId, details] of this.threadDetails.entries()) {
      if (!threadId || this.isThreadHidden(threadId)) continue;
      const summary = this.threadMap.get(threadId);
      const normalized = {
        id: threadId,
        title: summary?.title || 'Untitled thread',
        updatedAt: summary?.updatedAt || nowIso(),
        events: Array.isArray(details?.events) ? details.events.slice(-maxEvents) : [],
        messages: Array.isArray(details?.messages) ? details.messages.slice(-maxMessages) : [],
        commandLog: Array.isArray(details?.commandLog) ? details.commandLog.slice(-maxCommandLog) : [],
        planLog: Array.isArray(details?.planLog) ? details.planLog.slice(-maxPlanLog) : [],
      };
      entries.push(normalized);
    }
    entries.sort((left, right) => new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime());
    return {
      version: 1,
      exportedAt: nowIso(),
      threadDetails: entries.slice(0, maxThreads),
    };
  }

  importThreadDetails(snapshot = null) {
    if (!snapshot || typeof snapshot !== 'object') return 0;
    const entries = Array.isArray(snapshot.threadDetails) ? snapshot.threadDetails : [];
    let count = 0;
    for (const entry of entries) {
      const threadId = entry?.id;
      if (!threadId) continue;
      if (this.isThreadHidden(threadId)) continue;
      const current = this.threadDetails.get(threadId) || createThreadDetails(threadId);
      const next = {
        id: threadId,
        events: Array.isArray(entry?.events) ? entry.events : current.events || [],
        messages: Array.isArray(entry?.messages) ? entry.messages : current.messages || [],
        commandLog: Array.isArray(entry?.commandLog) ? entry.commandLog : current.commandLog || [],
        planLog: Array.isArray(entry?.planLog) ? entry.planLog : current.planLog || [],
      };
      next.messages.sort((left, right) => new Date(left.createdAt || left.updatedAt || 0).getTime() - new Date(right.createdAt || right.updatedAt || 0).getTime());
      next.events.sort((left, right) => new Date(left.timestamp || 0).getTime() - new Date(right.timestamp || 0).getTime());
      next.commandLog.sort((left, right) => new Date(left.updatedAt || 0).getTime() - new Date(right.updatedAt || 0).getTime());
      this.threadDetails.set(threadId, next);
      count += 1;
    }
    return count;
  }

  snapshot(sessionId = null) {
    return {
      workspacePath: this.workspacePath,
      localUrl: this.localUrl,
      publicUrl: this.publicUrl,
      pairUrl: this.pairUrl,
      proxyPort: this.proxyPort,
      appServerPort: this.appServerPort,
      status: this.status,
      viewerRole: sessionId ? this.getSessionRole(sessionId) : 'viewer',
      writerSessionId: this.writerSessionId,
      threads: this.getThreads(),
      approvals: this.getApprovals(),
    };
  }
}
