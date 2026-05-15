const { contextBridge, ipcRenderer } = require('electron');

// Expose a minimal API to the renderer (nodeIntegration is disabled in the main window).
contextBridge.exposeInMainWorld('appAPI', {
  quit: () => ipcRenderer.send('app-quit'),
  discordSaveConfig: (config) => ipcRenderer.invoke('discord-save-config', config),
  discordLoadConfig: () => ipcRenderer.invoke('discord-load-config'),
  discordStartBot: () => ipcRenderer.invoke('discord-start-bot')
});

