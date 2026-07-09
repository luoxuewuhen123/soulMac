const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  showMenu: (x, y, hasApi, voiceOn, pinOn) => ipcRenderer.send('show-menu', x, y, hasApi, voiceOn, pinOn),
  onMenu: cb => ipcRenderer.on('menu', (_, a, v) => cb(a, v)),
  openChatWindow: () => ipcRenderer.send('open-chat-window'),
  openAiCfgWindow: () => ipcRenderer.send('open-ai-cfg-window'),

  openSkillsWindow: () => ipcRenderer.send('open-skills-window'),
  openToolsWindow: () => ipcRenderer.send('open-tools-window'),
  openInstructionsWindow: () => ipcRenderer.send('open-instructions-window'),
  openPetCfgWindow: () => ipcRenderer.send('open-pet-cfg-window'),
  togglePin: () => ipcRenderer.send('toggle-pin'),
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  openDevtools: () => ipcRenderer.send('open-devtools'),
  aiStart: type => ipcRenderer.invoke('ai-start', type),
  aiDone: () => ipcRenderer.invoke('ai-done'),
  isAiBusy: () => ipcRenderer.invoke('is-ai-busy'),
  onAiAbort: cb => { const f = () => cb(); ipcRenderer.on('ai-abort', f); return () => ipcRenderer.removeListener('ai-abort', f); },
  sendToChatWindow: data => ipcRenderer.send('pet-to-chat', data),
  onAiCfgWindowClosed: cb => ipcRenderer.on('ai-cfg-window-closed', () => cb()),

  sendToPetWindow: data => ipcRenderer.send('chat-to-pet', data),
  onFromPetWindow: cb => ipcRenderer.on('from-pet-window', (_, data) => cb(data)),
  onFromChatWindow: cb => ipcRenderer.on('from-chat-window', (_, data) => cb(data)),
  getTime: () => {
    const d=new Date();
    return d.getFullYear()+'/'+(d.getMonth()+1)+'/'+d.getDate()+' '+d.getHours().toString().padStart(2,'0')+':'+d.getMinutes().toString().padStart(2,'0');
  },
});
