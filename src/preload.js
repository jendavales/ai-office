'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('office', {
  onEvent: (cb) => ipcRenderer.on('office:event', (_e, ev) => cb(ev)),
  onSettings: (cb) => ipcRenderer.on('office:settings', (_e, s) => cb(s)),
  onLimits: (cb) => ipcRenderer.on('office:limits', (_e, l) => cb(l)),
  onShowStats: (cb) => ipcRenderer.on('office:showStats', () => cb()),
  focus: (sessionId) => ipcRenderer.invoke('office:focus', sessionId),
  stats: () => ipcRenderer.invoke('office:stats'),
  snapshot: () => ipcRenderer.invoke('office:snapshot'),
  info: () => ipcRenderer.invoke('office:info'),
  openExternal: (url) => ipcRenderer.invoke('office:openExternal', url),
  // every Claude Code conversation (desktop, terminals, ours); sessions AI Office runs can be written to,
  // writing to any other one continues it in a copy (send resolves with the id that got the message)
  chat: {
    list: () => ipcRenderer.invoke('chat:list'),
    open: (id) => ipcRenderer.invoke('chat:open', id),
    create: (task) => ipcRenderer.invoke('chat:create', task), // { cwd, prompt, model, effort } → id
    send: (id, text) => ipcRenderer.invoke('chat:send', id, text),
    stop: (id) => ipcRenderer.invoke('chat:stop', id),
    dismiss: (id) => ipcRenderer.invoke('chat:dismiss', id),
    fork: (id, before = null) => ipcRenderer.invoke('chat:fork', id, before),
    rewind: (id, before) => ipcRenderer.invoke('chat:rewind', id, before),
    rename: (id, title) => ipcRenderer.invoke('chat:rename', id, title),
    archive: (id, on) => ipcRenderer.invoke('chat:archive', id, on),
    search: (q) => ipcRenderer.invoke('chat:search', q),
    setOptions: (id, o) => ipcRenderer.invoke('chat:setOptions', id, o),
    options: () => ipcRenderer.invoke('chat:options'),
    projects: () => ipcRenderer.invoke('chat:projects'),
    pickFolder: () => ipcRenderer.invoke('chat:pickFolder'),
    onItem: (cb) => ipcRenderer.on('chat:item', (_e, p) => cb(p)),
    onState: (cb) => ipcRenderer.on('chat:state', (_e, s) => cb(s)),
    onShow: (cb) => ipcRenderer.on('chat:show', (_e, id) => cb(id)),
    onList: (cb) => ipcRenderer.on('chat:list', () => cb()),
  },
  // the director's to-do list (Todoist)
  todoist: {
    status: () => ipcRenderer.invoke('todoist:status'),
    list: (force) => ipcRenderer.invoke('todoist:list', force),
    setToken: (token) => ipcRenderer.invoke('todoist:setToken', token),
    clearToken: () => ipcRenderer.invoke('todoist:clearToken'),
    create: (task) => ipcRenderer.invoke('todoist:create', task),
    close: (id) => ipcRenderer.invoke('todoist:close', id),
    setDue: (id, due) => ipcRenderer.invoke('todoist:setDue', id, due),
    open: () => ipcRenderer.invoke('todoist:open'),
    onUpdate: (cb) => ipcRenderer.on('todoist:update', (_e, s) => cb(s)),
    onShow: (cb) => ipcRenderer.on('todoist:show', () => cb()),
  },
});
