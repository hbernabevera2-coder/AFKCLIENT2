const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const DiscordBotManager = require('./discordbot');

// Suprimir errores SSL del visor 3D (no afectan el funcionamiento)
const originalError = console.error;
console.error = function(...args) {
    const msg = args.join(' ');
    if (msg.includes('ssl_client_socket_impl') || msg.includes('handshake failed')) {
        return; // Ignorar errores SSL del visor 3D
    }
    return originalError.apply(this, args);
};

let mainWindow = null;
let isQuitting = false;
let tray = null;
let discordBot = null;
let io = null; // Socket.IO instance

// Prevent multiple app instances.
// When the app is running in background (window hidden), re-launching can crash
// because the backend server tries to bind the same port again.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    app.quit();
}

function createTray() {
    if (tray) return;
    try {
        const iconPath = path.join(__dirname, 'public', 'icon.png');
        const fallbackPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAC0lEQVR4nO3BMQEAAADCoPVPbQ0PoAAAAAAAAABgFQe7AAE8nTAAAAAASUVORK5CYII=';
        const icon = fs.existsSync(iconPath)
            ? iconPath
            : nativeImage.createFromDataURL(`data:image/png;base64,${fallbackPngBase64}`);

        tray = new Tray(icon);
        tray.setToolTip('AFK Manager Pro');

        const contextMenu = Menu.buildFromTemplate([
            {
                label: 'Show/Hide',
                click: () => {
                    if (!mainWindow) return;
                    if (mainWindow.isVisible()) {
                        mainWindow.hide();
                        mainWindow.setSkipTaskbar(true);
                    } else {
                        mainWindow.show();
                        mainWindow.setSkipTaskbar(false);
                        mainWindow.restore?.();
                    }
                }
            },
            {
                label: 'Quit',
                click: () => {
                    isQuitting = true;
                    app.quit();
                }
            }
        ]);

        tray.setContextMenu(contextMenu);
        tray.on('click', () => {
            if (!mainWindow) return;
            if (mainWindow.isVisible()) {
                mainWindow.hide();
                mainWindow.setSkipTaskbar(true);
            } else {
                mainWindow.show();
                mainWindow.setSkipTaskbar(false);
                mainWindow.restore?.();
            }
        });
    } catch (e) {
        console.error('[Main] Failed to create tray:', e);
    }
}

async function createMainWindow() {
    try {
        const startServer = require('./server.js');
        const serverResult = startServer();
        if (serverResult && serverResult.io) {
            io = serverResult.io;
            console.log('[Main] Servidor interno iniciado con Socket.IO');
        }
    } catch (err) {
        console.error('[Main] Error starting server:', err);
        app.quit();
    }

    await new Promise(resolve => setTimeout(resolve, 500));
    const iconPath = path.join(__dirname, 'public', 'icon.png'); 

    mainWindow = new BrowserWindow({
        width: 1280,
        height: 720,
        icon: iconPath,
        webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
        show: false,
        backgroundColor: '#060608',
    });

    if (process.platform === 'win32') {
        app.setAppUserModelId('com.bernaontop.afkmanager');
    }

    mainWindow.loadURL('http://localhost:3000');
    mainWindow.once('ready-to-show', () => { mainWindow.show(); });
    // If user clicks the window X, keep the app running in the background.
    mainWindow.on('close', (e) => {
        if (!isQuitting) {
            e.preventDefault();
            mainWindow.hide();
            mainWindow.setSkipTaskbar(true);
            // Alternative: mainWindow.hide();
        }
    });
    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    createTray();
}

// Quit app requested from renderer button
ipcMain.on('app-quit', () => {
    isQuitting = true;
    if (discordBot) discordBot.stop();
    app.quit();
});

// ================= DISCORD BOT IPC =================
ipcMain.handle('discord-save-config', async (event, { token, guildId }) => {
    try {
        if (!discordBot) {
            discordBot = new DiscordBotManager();
        }
        discordBot.saveConfig(token, guildId);
        
        // Start Discord bot (it will connect its own socket)
        const success = await discordBot.start();
        
        return { success, message: success ? 'Discord bot connected!' : 'Failed to connect Discord bot' };
    } catch (e) {
        console.error('[Discord IPC] Error:', e);
        return { success: false, message: e.message };
    }
});

ipcMain.handle('discord-load-config', async () => {
    try {
        if (!discordBot) {
            discordBot = new DiscordBotManager();
        }
        const loaded = discordBot.loadConfig();
        return { 
            success: loaded, 
            token: discordBot.token || '', 
            guildId: discordBot.guildId,
            isConnected: discordBot.isConnected 
        };
    } catch (e) {
        return { success: false, message: e.message };
    }
});

ipcMain.handle('discord-start-bot', async () => {
    try {
        if (!discordBot) {
            discordBot = new DiscordBotManager();
        }
        const success = await discordBot.start();
        return { success, message: success ? 'Bot started!' : 'Failed to start bot' };
    } catch (e) {
        return { success: false, message: e.message };
    }
});

app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    createMainWindow();
});

app.on('second-instance', () => {
    // Bring the existing background window to front instead of starting new servers.
    if (mainWindow) {
        mainWindow.show();
        mainWindow.setSkipTaskbar(false);
        mainWindow.restore?.();
        mainWindow.focus?.();
    } else {
        const all = BrowserWindow.getAllWindows();
        for (const w of all) {
            if (w && !w.isDestroyed()) {
                w.show();
                w.restore?.();
                w.focus?.();
                break;
            }
        }
    }
});

app.on('window-all-closed', () => {
    // Keep running in background (no app.quit here).
    // The app will only quit when Electron emits "before-quit"/"quit".
});

app.on('before-quit', () => {
    isQuitting = true;
});