const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  hide: () => ipcRenderer.send('popup:hide'),
  chat: (query, model) => ipcRenderer.invoke('popup:chat', query, model),
  onChunk: (callback) => ipcRenderer.on('popup:chunk', (_, data) => callback(data)),
  tts: (text) => ipcRenderer.invoke('popup:tts', text),
  getModel: () => ipcRenderer.invoke('popup:getModel'),
  resize: (height) => ipcRenderer.invoke('popup:resize', height),
  memory: {
    load: () => ipcRenderer.invoke('memory:load'),
    getContext: (currentMessage, currentSessionId) => ipcRenderer.invoke('memory:getContext', currentMessage, currentSessionId)
  },
  composio: {
    getTools: (toolkits) => ipcRenderer.invoke('composio:getTools', toolkits),
    buildPrompt: () => ipcRenderer.invoke('composio:buildPrompt'),
    execute: (toolName, args) => ipcRenderer.invoke('composio:execute', toolName, args),
    connectUrl: (toolkit) => ipcRenderer.invoke('composio:connectUrl', toolkit),
    status: (toolkit) => ipcRenderer.invoke('composio:status', toolkit),
    isConnected: (toolkit) => ipcRenderer.invoke('composio:isConnected', toolkit),
    startConnect: (toolkit) => ipcRenderer.invoke('composio:startConnect', toolkit),
    waitForConnection: (toolkit, timeoutMs) => ipcRenderer.invoke('composio:waitForConnection', toolkit, timeoutMs),
    toolkitSummary: () => ipcRenderer.invoke('composio:toolkitSummary'),
    toolkitDetail: (toolkit) => ipcRenderer.invoke('composio:toolkitDetail', toolkit),
    isConfigured: () => ipcRenderer.invoke('composio:isConfigured'),
    discoverToolkit: (query) => ipcRenderer.invoke('composio:discoverToolkit', query),
    connectToolkit: (toolkit) => ipcRenderer.invoke('composio:connectToolkit', toolkit)
  }
});
