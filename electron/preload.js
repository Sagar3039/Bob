const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('assistantAPI', {
  platform: process.platform,
  clipboard: {
    writeText: (text) => ipcRenderer.invoke('clipboard:writeText', text)
  },
  sessions: {
    load: () => ipcRenderer.invoke('sessions:load'),
    save: (sessions) => ipcRenderer.invoke('sessions:save', sessions)
  },
  memory: {
    load: () => ipcRenderer.invoke('memory:load'),
    save: (memory) => ipcRenderer.invoke('memory:save', memory),
    extract: (session) => ipcRenderer.invoke('memory:extract', session),
    getContext: (currentMessage, currentSessionId) => ipcRenderer.invoke('memory:getContext', currentMessage, currentSessionId)
  },
  tts: {
    getEdgeVoices: () => ipcRenderer.invoke('tts:getEdgeVoices'),
    speak: (text, options) => ipcRenderer.invoke('tts:speak', text, options),
    stop: () => ipcRenderer.invoke('tts:stop')
  },
  stt: {
    transcribe: (audioBase64) => ipcRenderer.invoke('stt:transcribe', audioBase64)
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
    connectToolkit: (toolkit) => ipcRenderer.invoke('composio:connectToolkit', toolkit),
    allConnectors: () => ipcRenderer.invoke('composio:allConnectors')
  },
  fs: {
    writeFile: (filePath, content) => ipcRenderer.invoke('fs:writeFile', { filePath, content }),
    readFile: (filePath) => ipcRenderer.invoke('fs:readFile', { filePath }),
    listDir: (dirPath) => ipcRenderer.invoke('fs:listDir', { dirPath })
  },
  shell: {
    exec: (command, cwd, timeout) => ipcRenderer.invoke('shell:exec', { command, cwd, timeout })
  },
  scheduler: {
    createTask: (name, scriptPath, triggerTime, daysOfWeek) => ipcRenderer.invoke('scheduler:createTask', { name, scriptPath, triggerTime, daysOfWeek }),
    listTasks: () => ipcRenderer.invoke('scheduler:listTasks'),
    deleteTask: (taskName) => ipcRenderer.invoke('scheduler:deleteTask', { taskName })
  }
});
