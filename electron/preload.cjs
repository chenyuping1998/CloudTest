/**
 * Preload：只把必要的功能透過 contextBridge 暴露給遊戲頁面（window.steam / window.desktop）。
 */
const { contextBridge, ipcRenderer } = require('electron');

const info = ipcRenderer.sendSync('steam:info');

contextBridge.exposeInMainWorld('steam', {
  available: !!info.available,
  personaName: info.personaName,
  steamId: info.steamId,
  activateAchievement: (id) => ipcRenderer.invoke('steam:achievement', String(id)),
  setRichPresence: (key, value) => ipcRenderer.invoke('steam:presence', String(key), String(value)),
  getAuthTicket: () => ipcRenderer.invoke('steam:ticket'),
});

contextBridge.exposeInMainWorld('desktop', {
  version: ipcRenderer.sendSync('desktop:version'),
  toggleFullscreen: () => ipcRenderer.invoke('desktop:fullscreen'),
  quit: () => ipcRenderer.invoke('desktop:quit'),
});
