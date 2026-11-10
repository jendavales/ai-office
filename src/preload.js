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
  // conversations with sessions AI Office runs itself
  chat: {
    list: () => ipcRenderer.invoke('chat:list'),
    open: (id) => ipcRenderer.invoke('chat:open', id),
    create: (task) => ipcRenderer.invoke('chat:create', task),
    send: (id, text) => ipcRenderer.invoke('chat:send', id, text),
    stop: (id) => ipcRenderer.invoke('chat:stop', id),
    dismiss: (id) => ipcRenderer.invoke('chat:dismiss', id),
    projects: () => ipcRenderer.invoke('chat:projects'),
    pickFolder: () => ipcRenderer.invoke('chat:pickFolder'),
    onItem: (cb) => ipcRenderer.on('chat:item', (_e, p) => cb(p)),
    onState: (cb) => ipcRenderer.on('chat:state', (_e, s) => cb(s)),
    onShow: (cb) => ipcRenderer.on('chat:show', (_e, id) => cb(id)),
  },
});
