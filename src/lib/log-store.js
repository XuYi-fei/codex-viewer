import { appendFileSync, existsSync, readFileSync } from 'node:fs';

export class LogStore {
  constructor({ filePath, limit = 500 }) {
    this.filePath = filePath;
    this.limit = limit;
    this.entries = [];
    this.listeners = new Set();
    this.load();
  }

  load() {
    if (!existsSync(this.filePath)) return;
    const text = readFileSync(this.filePath, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        this.entries.push(JSON.parse(line));
      } catch {}
    }
    if (this.entries.length > this.limit) {
      this.entries = this.entries.slice(-this.limit);
    }
  }

  append(entry) {
    this.entries.push(entry);
    if (this.entries.length > this.limit) {
      this.entries = this.entries.slice(-this.limit);
    }
    appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`);
    for (const listener of this.listeners) listener(entry);
  }

  onAppend(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list({ limit = 100, cursor } = {}) {
    let endIndex = this.entries.length;
    if (cursor) {
      const foundIndex = this.entries.findIndex((entry) => entry.id === cursor);
      endIndex = foundIndex >= 0 ? foundIndex : this.entries.length;
    }
    const startIndex = Math.max(0, endIndex - limit);
    const data = this.entries.slice(startIndex, endIndex);
    return {
      data,
      nextCursor: startIndex > 0 ? this.entries[startIndex].id : null,
    };
  }
}
