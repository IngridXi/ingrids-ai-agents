'use strict';

const { randomUUID } = require('node:crypto');

function createActivity() {
  const active = new Map();
  const recent = [];

  function start(data) {
    const id = randomUUID();
    active.set(id, { id, ...data, status: data.status || 'running', startedAt: Date.now() });
    return id;
  }

  function update(id, patch) {
    const entry = active.get(id);
    if (entry) Object.assign(entry, patch);
  }

  function finish(id, patch) {
    const entry = active.get(id);
    if (!entry) return;
    active.delete(id);
    recent.unshift({ ...entry, status: 'done', ...patch, endedAt: Date.now() });
    recent.length = Math.min(recent.length, 100);
  }

  function snapshot() {
    return { active: Array.from(active.values()), recent: recent.slice() };
  }

  return { start, update, finish, snapshot };
}

module.exports = { createActivity };
