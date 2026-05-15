const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const mineflayerViewer = require('prismarine-viewer').mineflayer;
const path = require('path');
const fs = require('fs');
const dns = require('dns').promises;
const { app: electronApp, shell } = require('electron');
const AuthManager = require('./auth_manager');
const ProxyManager = require('./proxy_manager');

// --- Lista de puertos comunes para reintentos automáticos ---
const DEFAULT_PORTS = [25565, 25566, 25575, 25577, 25580, 25585, 19132, 19133];

// --- Configuración Inicial ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: ["http://127.0.0.1:3000", "http://localhost:3000"],
        methods: ["GET", "POST"]
    },
    maxHttpBufferSize: 1e5
});

const PORT = 3000;
let NEXT_VIEWER_PORT = 3001;

// Variable que se definirá dentro de startServer
let sessionsPath;

// Instancias globales
const msaAuth = new AuthManager();
const bots = new Map();
let serverStarted = false;

app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));

// ================= CLASE BOT =================
class AFKBot {
    constructor(id, settings) {
        this.id = id;
        this.settings = settings;
        this.bot = null;
        this.isSpawned = false;
        this.viewerPort = null;
        this.viewerStarted = false;
        this.antiAfkTimer = null;
        this.currentDimension = null;
        this.intentionalDisconnect = false;
        this.reconnectTimer = null;
        this.serverSwitching = false;
        this.reconnectAttempts = 0;
        this.followTarget = null;
        this.followInterval = null;

        // Solo usar el puerto configurado por el usuario.
        // DEFAULT_PORTS causaba spam de errores en servidores normales.
        this.originalPort = parseInt(this.settings.port) || 25565;
        this.portsToTry = [this.originalPort];
        this.currentPortIndex = 0;
    }

    emitStatus(status) {
        io.emit('bot-status', { id: this.id, status: status });
    }

    async resolveSRV(host, port) {
        try {
            const records = await dns.resolveSrv(`_minecraft._tcp.${host}`);
            if (records && records.length > 0) {
                const best = records.reduce((prev, curr) =>
                    curr.priority < prev.priority ? curr : prev
                );
                console.log(`[SRV] ${host} -> ${best.name}:${best.port}`);
                return { host: best.name, port: best.port };
            }
        } catch (err) {
            // ECONNREFUSED aquí significa que el DNS no respondió (no siempre un error fatal).
            // Lo tratamos como "sin SRV" para evitar spam.
            if (err.code !== 'ENODATA' && err.code !== 'ECONNREFUSED') {
                console.warn(`[SRV] Error consultando SRV para ${host}:`, err.message);
            }
        }
        return { host, port };
    }

    async start() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.intentionalDisconnect = false;
        // Si llegamos a "start" y el bot ya se conectó antes, intentos se reinician en spawn.

        if (this.bot) {
            console.log(`[BotManager] ${this.settings.username} ya está en ejecución.`);
            return;
        }

        // Si ya se intentó el puerto y falló, resetear y esperar para reconectar
        if (this.currentPortIndex >= this.portsToTry.length) {
            this.currentPortIndex = 0;
            const delay = 15000;
            this.emitStatus('Waiting for reconnect...');
            io.to(this.id).emit('log', `§e[System] Port unreachable. Retrying in ${delay/1000}s...`);
            if (!this.reconnectTimer) {
                this.reconnectTimer = setTimeout(() => {
                    this.reconnectTimer = null;
                    this.start();
                }, delay);
            }
            return;
        }

        const currentPort = this.portsToTry[this.currentPortIndex];
        this.currentPortIndex++;

        let botUsername = this.settings.username || this.settings.name;
        let originalHost = this.settings.host;
        let originalPort = currentPort;

        console.log(`[DEBUG] Intento ${this.currentPortIndex}/${this.portsToTry.length} - Puerto: ${originalPort}`);

        // Si el usuario eligió un puerto distinto a 25565, no hacemos SRV.
        // Así garantizamos que el bot reconecte siempre en el puerto seleccionado.
        let finalHost = originalHost;
        let finalPort = originalPort;
        if (originalPort === 25565) {
            const { host: resolvedHost } = await this.resolveSRV(originalHost, originalPort);
            finalHost = resolvedHost;
            // Always preserve the port selected by the user.
            finalPort = originalPort;
        }

        console.log(`[DEBUG] Host final: ${finalHost}, Puerto final: ${finalPort}`);

        // Fix Bug C: refrescar token Microsoft antes de reconectar si podría estar expirado
        if (this.settings.auth === 'microsoft') {
            try {
                const freshSession = await msaAuth.getBotSession(botUsername);
                if (freshSession) {
                    this.settings.msaData = freshSession;
                } else {
                    console.warn('[BotManager] Could not refresh session for ' + botUsername + ', using cached token.');
                }
            } catch (e) {
                console.warn('[BotManager] Error refreshing token for ' + botUsername + ':', e.message);
            }
        }

        const botOptions = {
            host: finalHost,
            port: finalPort,
            username: botUsername,
            auth: this.settings.auth || 'microsoft',
            version: this.settings.version || false,
            checkTimeoutInterval: 60000,
            connectTimeout: 30000,
            // Suppress protodef "Chunk size is ... partial packet ..." logs
            // (often happens during reconnect/switching, but we don't want console spam).
            hideErrors: true,
            // Add additional protocol parsing protection
            closeTimeout: 10000,
            noPing: false
        };

        // Fix Bug B: solo agregar profilesFolder para cuentas Microsoft (offline no necesita)
        if (this.settings.auth === 'microsoft') {
            botOptions.profilesFolder = path.join(sessionsPath, botUsername);
        }

        if (this.settings.proxy) {
            const agent = ProxyManager.getAgent(this.settings.proxy);
            if (agent) botOptions.agent = agent;
        }

        const useMsaSession = this.settings.msaData && this.settings.auth === 'microsoft';
        if (useMsaSession) {
            botOptions.session = this.settings.msaData;
        }

        console.log(`[DEBUG] Conectando a ${botOptions.host}:${botOptions.port} con usuario ${botOptions.username}...`);

        // Interceptar salida de consola para capturar códigos de dispositivo (solo si es necesario)
        // NOTA: NO sobreescribimos console.log global porque con múltiples bots en cadena
        // cada bot captura el console.log ya sobreescrito del anterior, rompiendo el restore.
        let _restoreConsole = null;

        if (!useMsaSession && this.settings.auth === 'microsoft') {
            const botRef = this;
            botRef._codeSent = false;

            const _msaFilter = (chunk) => {
                const msg = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
                const codeMatch = msg.match(/otc=([A-Z0-9]{6,9})/i) ||
                                  msg.match(/use the code\s+([A-Z0-9]{6,9})/i) ||
                                  msg.match(/enter the code\s+([A-Z0-9]{6,9})/i);
                if (codeMatch && !botRef._codeSent) {
                    botRef._codeSent = true;
                    const code = codeMatch[1].toUpperCase();
                    io.emit('msa-device-code', {
                        id: botRef.id,
                        username: botRef.settings.username,
                        code: code,
                        url: 'https://www.microsoft.com/link'
                    });
                }
            };

            // Guardamos los writes anteriores (pueden ser de otro bot)
            const _prevStdout = process.stdout.write;
            const _prevStderr = process.stderr.write;
            process.stdout.write = function(chunk, enc, cb) { _msaFilter(chunk); return _prevStdout.call(process.stdout, chunk, enc, cb); };
            process.stderr.write = function(chunk, enc, cb) { _msaFilter(chunk); return _prevStderr.call(process.stderr, chunk, enc, cb); };

            _restoreConsole = () => {
                process.stdout.write = _prevStdout;
                process.stderr.write = _prevStderr;
            };
        }

        this.bot = mineflayer.createBot(botOptions);

        // Spoofear el brand del cliente para parecer un cliente normal
        this.bot.once('login', () => {
            if (this.bot._client && this.bot._client.write) {
                try {
                    this.bot._client.write('custom_payload', {
                        channel: 'brand',
                        data: Buffer.from('vanilla')
                    });
                } catch (e) {
                    // Ignorar errores
                }
            }
        });

        this.bot.on('login', () => {
            if (_restoreConsole) _restoreConsole();
            if (!useMsaSession && this.settings.auth === 'microsoft') {
                io.emit('msa-device-code-done', { id: this.id });
            }
            this.emitStatus('Authenticated, entering...');
            if (this.settings.auth === 'microsoft') {
                this.settings.username = this.bot.username;
                io.emit('msa-username-resolved', { id: this.id, username: this.bot.username });
            }
        });
        this.bot.on('spawn', () => {
            if (this.isSpawned) return;
            this.isSpawned = true;
            this.reconnectAttempts = 0;
            this.serverSwitching = false;
            if (this._serverSwitchTimeout) {
                clearTimeout(this._serverSwitchTimeout);
                this._serverSwitchTimeout = null;
            }
            this.emitStatus('Online');
            io.to(this.id).emit('log', '§a[System] Bot has appeared in the world.');
            // Delay para asegurar que el bot esté listo antes de iniciar anti-AFK
            setTimeout(() => {
                if (typeof this.startAntiAfk === 'function' && this.isSpawned && this.bot && this.bot.entity) {
                    this.startAntiAfk();
                }
            }, 1500);
            if (this.viewerStarted && typeof this.refreshViewer === 'function') this.refreshViewer();
        });

        this.bot.on('message', (jsonMsg) => {
            const raw = jsonMsg.toString();
            const clean = raw.replace(/§[0-9a-fk-or]/gi, '');
            io.to(this.id).emit('log', `§f[Message] ${clean}`);
            io.emit('server-message', { botId: this.id, message: clean });
        });

        this.bot.once('login', () => {
            if (!this.bot._client) return;
            const originalWrite = this.bot._client.write.bind(this.bot._client);
            this.bot._client.write = (name, data) => {
                if (this.serverSwitching && !['keep_alive', 'teleport_confirm', 'settings'].includes(name)) {
                    return;
                }
                try { originalWrite(name, data); } catch (e) {}
            };
        });

        // Fix Bug 3: detectar cambios de servidor BungeeCord/Velocity (/server <name>)
        // El kick con "Connecting to" indica transferencia interna, no desconexión real
        this.bot.on('kicked', (reason) => {
            let msg = reason;
            try { msg = JSON.parse(reason).text || reason; } catch (e) {}
            const isBungeeTransfer = /Connecting to|Connected to|Transferring|You are already/i.test(msg);
            if (isBungeeTransfer) {
                this.serverSwitching = true;
                this.isSpawned = false;
                this.emitStatus('Switching server...');
                io.to(this.id).emit('log', `§e[System] Switching server: ${msg}`);
                // Fix: Limpiar cualquier timer anterior para evitar condiciones de carrera
                if (this._serverSwitchTimeout) {
                    clearTimeout(this._serverSwitchTimeout);
                }
                // Si tras 20s no se spawneó, resetear el flag para no bloquear paquetes indefinidamente
                this._serverSwitchTimeout = setTimeout(() => {
                    if (this.serverSwitching) {
                        this.serverSwitching = false;
                        this._serverSwitchTimeout = null;
                        console.warn(`[BotManager] serverSwitching timeout para ${botUsername}, reseteando.`);
                    }
                }, 20000);
            }
        });

        // Enhanced error handling for parsing issues
        this.bot.on('error', (err) => {
            if (_restoreConsole) _restoreConsole();
            
            // Check for parsing errors with abnormally large arrays
            const isParseError = err.message && (
                err.message.includes('Parse error') ||
                err.message.includes('array size is abnormally large') ||
                err.message.includes('Read error for undefined')
            );
            
            if (isParseError) {
                console.error(`[ParseError] ${botUsername}:`, err.message);
                io.to(this.id).emit('log', `§c[Error] Could not connect: ${err.message}`);
                
                // Force disconnect and retry with delay
                if (!this.intentionalDisconnect && this.bot) {
                    try { this.bot.end(); } catch (e) {}
                    this.bot = null;
                    
                    // Add delay before retry to avoid immediate reconnection
                    const retryDelay = 5000;
                    this.emitStatus(`Parse error. Retrying in ${retryDelay/1000}s...`);
                    io.to(this.id).emit('log', `§e[System] Parse error detected. Retrying in ${retryDelay/1000}s...`);
                    
                    if (!this.reconnectTimer) {
                        this.reconnectTimer = setTimeout(() => {
                            this.reconnectTimer = null;
                            this.start();
                        }, retryDelay);
                    }
                }
                return;
            }
            
            console.error(`[Error crítico - ${botUsername}]`, err.code || err.message);
            io.to(this.id).emit('log', `§c[Error] Could not connect: ${err.code || err.message}`);

            if (this.intentionalDisconnect) {
                if (this.bot) try { this.bot.end(); } catch (e) {}
                return;
            }

            // ENOTFOUND = el hostname no existe → no tiene sentido probar otros puertos,
            // esperar y reintentar con el puerto original.
            if (err.code === 'ENOTFOUND') {
                if (this.bot) { try { this.bot.end(); } catch (e) {} this.bot = null; }
                this.currentPortIndex = 0; // resetear para el próximo intento
                this.reconnectAttempts = (this.reconnectAttempts || 0) + 1;
                const delay = Math.min(15000 * Math.pow(2, this.reconnectAttempts - 1), 60000);
                this.emitStatus(`Reconnecting in ${delay / 1000}s...`);
                io.to(this.id).emit('log', `§e[System] Host not found (DNS). Retrying in ${delay / 1000}s...`);
                if (!this.reconnectTimer) {
                    this.reconnectTimer = setTimeout(() => {
                        this.reconnectTimer = null;
                        this.start();
                    }, delay);
                }
                return;
            }

            // ECONNREFUSED / ETIMEDOUT → reconectar tras delay
            const isPortError = err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT';
            if (isPortError) {
                if (this.bot) { try { this.bot.end(); } catch (e) {} this.bot = null; }
                this.currentPortIndex = 0;
                this.reconnectAttempts = (this.reconnectAttempts || 0) + 1;
                const baseDelay = 10000;
                const delay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempts - 1), 60000);
                this.emitStatus(`Reconnecting in ${delay/1000}s...`);
                if (!this.reconnectTimer) {
                    this.reconnectTimer = setTimeout(() => {
                        this.reconnectTimer = null;
                        this.start();
                    }, delay);
                }
            } else {
                if (this.bot) try { this.bot.end(); } catch (e) {}
            }
        });

        this.bot.on('end', (reason) => {
            if (_restoreConsole) _restoreConsole();
            this.isSpawned = false;
            if (typeof this.stopAntiAfk === 'function') this.stopAntiAfk();
            this.bot = null;
            
            // Si estamos en server switching, reconectar rápidamente sin delay
            const wasSwitching = this.serverSwitching;
            this.serverSwitching = false; // Fix Bug 4: siempre resetear al desconectar
            
            if (this.intentionalDisconnect) {
                this.emitStatus('Stopped');
                io.to(this.id).emit('log', '§7[System] Bot detenido manualmente.');
            } else if (wasSwitching) {
                // Reconexión rápida para cambio de servidor (sin delay exponencial)
                this.reconnectAttempts = 0;
                this.currentPortIndex = 0;
                this.emitStatus('Reconnecting to new server...');
                io.to(this.id).emit('log', `§e[System] Server switch detected. Reconnecting immediately...`);
                if (!this.reconnectTimer) {
                    this.reconnectTimer = setTimeout(() => {
                        this.reconnectTimer = null;
                        this.start();
                    }, 1000); // Solo 1 segundo de delay para server switching
                }
            } else {
                this.reconnectAttempts = (this.reconnectAttempts || 0) + 1;
                const delay = Math.min(10000 * Math.pow(2, this.reconnectAttempts - 1), 60000);
                this.currentPortIndex = 0; // Fix Bug 2: resetear puertos en cada reconexión
                this.emitStatus(`Reconnecting in ${delay/1000}s...`);
                io.to(this.id).emit('log', `§e[System] Connection lost. Retrying...`);
                if (!this.reconnectTimer) {
                    this.reconnectTimer = setTimeout(() => {
                        this.reconnectTimer = null;
                        this.start();
                    }, delay);
                }
            }
        });
    }

    // ===== MÉTODOS DE INVENTARIO =====
    getInventory() {
        if (!this.bot || !this.bot.inventory) return [];
        return this.bot.inventory.items().map(item => ({
            slot: item.slot,
            name: item.name,
            count: item.count,
            displayName: item.displayName,
            metadata: item.metadata || null
        }));
    }

    async dropItem(slot) {
        if (!this.bot || !this.isSpawned) throw new Error('Bot not available');
        const item = this.bot.inventory.slots[slot];
        if (!item) return false;
        await this.bot.toss(item.type, null, item.count);
        return true;
    }

    async dropAll() {
        if (!this.bot || !this.isSpawned) throw new Error('Bot not available');
        const items = this.bot.inventory.items();
        for (const item of items) {
            try {
                await this.bot.toss(item.type, null, item.count);
            } catch (e) {
                console.error(`[DropAll] Error dropping ${item.name}:`, e);
            }
        }
        return true;
    }

    async sendChat(message) {
        if (!this.bot || typeof this.bot.chat !== 'function') {
            throw new Error('Bot not available for chat');
        }
        // Permitir comandos de servidor incluso si isSpawned es false o estamos en switching
        const isServerCommand = message.startsWith('/');
        if (!this.isSpawned && !isServerCommand) {
            throw new Error('Bot not spawned yet');
        }
        try {
            this.bot.chat(message);
        } catch (err) {
            throw new Error(`Error sending message: ${err.message}`);
        }
    }

    // ===== MÉTODOS ORIGINALES (cleanup, stop, control, etc.) =====
    cleanup() {
        if (this.viewerStarted && this.bot?.viewer) {
            try { this.bot.viewer.close(); } catch (e) {}
        }
        this.isSpawned = false;
        this.bot = null;
    }

    stop() {
        this.intentionalDisconnect = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this._serverSwitchTimeout) clearTimeout(this._serverSwitchTimeout);
        this.stopFollowing();
        if (this.bot) try { this.bot.quit(); } catch (e) { this.bot.end(); }
    }

    setControlState(control, state) {
        if (this.bot && this.isSpawned) this.bot.setControlState(control, state);
    }

    look(yaw, pitch) {
        if (this.bot && this.isSpawned) this.bot.look(yaw, pitch);
    }

    startViewer() {
        if (this.viewerStarted || !this.bot) return;
        this.viewerPort = NEXT_VIEWER_PORT++;
        mineflayerViewer(this.bot, { port: this.viewerPort, firstPerson: true });
        this.viewerStarted = true;
        io.to(this.id).emit('viewer-started', { id: this.id, port: this.viewerPort });
    }

    // ===== SISTEMA DE SEGUIMIENTO (FOLLOW) =====
    startFollowing(targetUsername) {
        if (!this.bot || !this.isSpawned) {
            console.log(`[Follow] Bot ${this.settings.username} not spawned, cannot follow`);
            return false;
        }
        if (!targetUsername) {
            console.log(`[Follow] No target username provided`);
            return false;
        }

        this.followTarget = targetUsername;
        const bot = this.bot;
        const self = this;

        // Limpiar intervalo anterior si existe
        if (this.followInterval) {
            clearInterval(this.followInterval);
        }

        this.emitStatus(`Following ${targetUsername}`);
        io.to(this.id).emit('log', `§a[Follow] Starting to follow ${targetUsername}`);

        this.followInterval = setInterval(() => {
            if (!self.isSpawned || !bot.entity) return;

            // Buscar al jugador objetivo
            const target = Object.values(bot.players).find(p => p.username === targetUsername);

            if (!target || !target.entity) {
                // El jugador no está visible o no está en el servidor
                return;
            }

            const targetPos = target.entity.position;
            const botPos = bot.entity.position;

            // Calcular distancia
            const distance = targetPos.distanceTo(botPos);

            // Si está muy cerca, detenerse
            if (distance < 2.5) {
                bot.setControlState('forward', false);
                bot.setControlState('sprint', false);
                bot.lookAt(target.entity.position.offset(0, 1.6, 0), true);
                return;
            }

            // Mirar al objetivo
            bot.lookAt(target.entity.position.offset(0, 1.6, 0), true);

            // Moverse hacia el objetivo
            bot.setControlState('forward', true);

            // Correr si está lejos
            if (distance > 8) {
                bot.setControlState('sprint', true);
            } else {
                bot.setControlState('sprint', false);
            }

            // Saltar si hay obstáculos (simple)
            if (bot.entity.onGround && distance > 3) {
                bot.setControlState('jump', true);
                setTimeout(() => bot.setControlState('jump', false), 250);
            }

        }, 250); // Actualizar 4 veces por segundo

        return true;
    }

    stopFollowing() {
        if (this.followInterval) {
            clearInterval(this.followInterval);
            this.followInterval = null;
        }
        if (this.followTarget) {
            this.followTarget = null;
            if (this.bot && this.isSpawned) {
                this.bot.setControlState('forward', false);
                this.bot.setControlState('sprint', false);
                this.bot.setControlState('jump', false);
            }
            this.emitStatus('Online');
            io.to(this.id).emit('log', '§e[Follow] Stopped following');
        }
    }

    isFollowing() {
        return this.followInterval !== null;
    }

    getFollowTarget() {
        return this.followTarget;
    }

    // ===== SISTEMA ANTI-AFK =====
    startAntiAfk() {
        if (!this.bot || !this.isSpawned) return;
        
        // Limpiar timer anterior si existe
        if (this.antiAfkTimer) {
            clearInterval(this.antiAfkTimer);
        }

        const method = this.settings.antiafk || 'look';
        const bot = this.bot;
        
        io.to(this.id).emit('log', `§a[System] Anti-AFK started (${method})`);

        switch (method) {
            case 'look':
                // Movimiento de cabeza aleatorio cada 5-10 segundos
                this.antiAfkTimer = setInterval(() => {
                    if (!bot.entity) return;
                    const yaw = Math.random() * Math.PI * 2;
                    const pitch = (Math.random() - 0.5) * 0.5;
                    bot.look(yaw, pitch, true);
                }, 5000 + Math.random() * 5000);
                break;
                
            case 'swing':
                // Balanceo de brazo cada 3-5 segundos
                this.antiAfkTimer = setInterval(() => {
                    if (!bot.entity) return;
                    bot.swingArm();
                }, 3000 + Math.random() * 2000);
                break;
                
            case 'jump':
                // Saltos cada 10-15 segundos
                this.antiAfkTimer = setInterval(() => {
                    if (!bot.entity || !bot.entity.onGround) return;
                    bot.setControlState('jump', true);
                    setTimeout(() => bot.setControlState('jump', false), 250);
                }, 10000 + Math.random() * 5000);
                break;
                
            default:
                // Por defecto: look
                this.antiAfkTimer = setInterval(() => {
                    if (!bot.entity) return;
                    const yaw = Math.random() * Math.PI * 2;
                    bot.look(yaw, 0, true);
                }, 5000);
        }
    }

    stopAntiAfk() {
        if (this.antiAfkTimer) {
            clearInterval(this.antiAfkTimer);
            this.antiAfkTimer = null;
            io.to(this.id).emit('log', '§e[System] Anti-AFK stopped');
        }
    }
}

// ================= EVENTOS DE SOCKET.IO =================
io.on('connection', (socket) => {
    console.log('Cliente conectado:', socket.id);

    socket.on('add-microsoft-account', async () => {
        try {
            const profile = await msaAuth.login();
            socket.emit('account-added', profile);
            msaAuth.primeProfile(profile.username).catch(err => {
                console.error(`[AuthManager] Error al hacer prime de la cuenta ${profile.username}:`, err);
            });
        } catch (error) {
            console.error('[AuthManager] Error en login:', error);
            socket.emit('log', `§c[Auth Error] ${error.message}`);
            socket.emit('microsoft-auth-error', error.message);
        }
    });

    socket.on('add-bot', async (settings) => {
        const botId = settings.id || Date.now().toString();
        if (bots.has(botId)) {
            socket.emit('log', '§e[Warning] Bot is already running.');
            return;
        }
        try {
            if (!settings || !settings.host) {
                socket.emit('log', '§c[Error] Invalid host or IP.');
                return;
            }
            let finalOptions = {
                host: settings.host.replace(/[^a-zA-Z0-9.\-]/g, '').slice(0, 255),
                port: parseInt(settings.port) || 25565,
                version: settings.version === 'auto' || !settings.version ? false : settings.version,
                proxy: settings.proxy || null,
                auth: settings.auth || 'offline'
            };
            if (settings.auth === 'microsoft') {
                const username = settings.profile?.username || settings.username;
                const session = await msaAuth.getBotSession(username);
                if (!session) {
                    socket.emit('log', `§c[Error] No saved session for ${username}. Add the account first.`);
                    return;
                }
                finalOptions.username = session.selectedProfile.name;
                finalOptions.msaData = session;
                socket.emit('log', `§a[System] §fLoading session for: §b${finalOptions.username}`);
            } else {
                let offlineName = (settings.username || '')
                    .replace(/[^a-zA-Z0-9_]/g, '')
                    .slice(0, 16);
                if (!offlineName || offlineName.length < 2) offlineName = 'Bot_' + Date.now().toString().slice(-4);
                finalOptions.username = offlineName;
                socket.emit('log', `§7[System] §fStarting No-Premium bot: §e${offlineName}`);
            }
            const newBot = new AFKBot(botId, finalOptions);
            bots.set(botId, newBot);
            io.emit('bot-added', {
                id: botId,
                settings: { ...finalOptions, name: finalOptions.username, host: finalOptions.host, port: finalOptions.port }
            });
            newBot.start();
        } catch (error) {
            console.error("[AddBot Error]:", error);
            socket.emit('log', `§c[Fatal Error] ${error.message}`);
        }
    });

    socket.on('deploy-fleet', async (data) => {
        const { usernames, host, port, version, proxy, offlineNames = [] } = data;
        if (!usernames || !Array.isArray(usernames)) return;

        const finalPort = parseInt(port) || 25565;
        const cleanHost = host.replace(/[^a-zA-Z0-9.\-]/g, '').slice(0, 255);
        const cleanVersion = version === 'auto' || !version ? false : version;
        console.log('[Fleet] Desplegando ' + usernames.length + ' MS + ' + offlineNames.length + ' offline en ' + cleanHost + ':' + finalPort);

        // Fix Bug A: cargar TODAS las sesiones en paralelo antes de crear bots.
        const sessionResults = await Promise.allSettled(
            usernames.map(rawName => {
                const name = rawName.trim();
                return msaAuth.getBotSession(name).then(s => ({ name, session: s }));
            })
        );

        let msDelay = 0;
        for (const result of sessionResults) {
            if (result.status === 'rejected' || !result.value || !result.value.session) {
                const failName = (result.value && result.value.name) ? result.value.name : '?';
                console.warn('[Fleet] No session for ' + failName);
                socket.emit('log', '§c[Error] No session for ' + failName + '. Add it first.');
                continue;
            }
            const { name, session } = result.value;
            const botId = 'fleet-' + name + '-' + Date.now();
            const fleetOptions = {
                host: cleanHost,
                port: finalPort,
                version: cleanVersion,
                proxy: proxy || null,
                auth: 'microsoft',
                username: session.selectedProfile.name,
                msaData: session
            };
            const fleetBot = new AFKBot(botId, fleetOptions);
            bots.set(botId, fleetBot);
            io.emit('bot-added', { id: botId, settings: { ...fleetOptions, name: fleetOptions.username, host: fleetOptions.host, port: fleetOptions.port } });
            // Delay escalonado de 500ms para evitar rate limiting 429
            setTimeout(() => fleetBot.start(), msDelay);
            msDelay += 500;
        }

        for (let index = 0; index < offlineNames.length; index++) {
            const name = offlineNames[index].trim();
            if (!name) continue;
            const botId = 'offline-' + name + '-' + Date.now() + '-' + index;
            const fleetOptions = {
                host: cleanHost,
                port: finalPort,
                version: cleanVersion,
                proxy: proxy || null,
                auth: 'offline',
                username: (() => { const u = name.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 16); return (u && u.length >= 2) ? u : 'Bot_' + Date.now().toString().slice(-4); })()
            };
            const fleetBot = new AFKBot(botId, fleetOptions);
            bots.set(botId, fleetBot);
            io.emit('bot-added', { id: botId, settings: { ...fleetOptions, name: fleetOptions.username, host: fleetOptions.host, port: fleetOptions.port } });
            // Delay escalonado de 500ms para evitar rate limiting
            setTimeout(() => fleetBot.start(), msDelay + index * 500);
        }
    });

    socket.on('remove-bot', (id) => {
        const b = bots.get(id);
        if (b) {
            b.stop();
            bots.delete(id);
            io.emit('bot-removed', id);
        }
    });

    socket.on('stop-bot', (id) => {
        const b = bots.get(id);
        if (b) b.stop();
    });

    // Chat con protección - permitir comandos de servidor durante switching
    socket.on('bot-chat', async ({ id, msg }) => {
        const b = bots.get(id);
        if (!b) return;
        
        // Permitir comandos de servidor (/server, /connect, etc.) incluso durante switching
        const isServerCommand = msg.startsWith('/');
        
        if (!b.isSpawned && !isServerCommand) {
            socket.emit('log', `§e[Warning] ${b.settings?.username || id} is not in the world yet.`);
            return;
        }
        
        // Si es comando de servidor y estamos en switching, igual permitirlo
        // porque BungeeCord/Velocity lo necesita procesar
        try {
            await b.sendChat(msg);
        } catch (err) {
            console.error(`[Chat] Error con bot ${id}:`, err);
            io.to(id).emit('log', `§c[Error] Could not send message: ${err.message}`);
        }
    });

    socket.on('bot-control-state', ({ id, control, state }) => {
        const b = bots.get(id);
        if (b) {
            try {
                b.setControlState(control, state);
            } catch (err) {
                console.error(`[Control] Error en bot ${id}:`, err);
            }
        }
    });

    socket.on('bot-look', ({ id, yaw, pitch }) => {
        const b = bots.get(id);
        if (b) {
            try {
                b.look(yaw, pitch);
            } catch (err) {
                console.error(`[Look] Error en bot ${id}:`, err);
            }
        }
    });

    socket.on('start-viewer', (id) => {
        const b = bots.get(id);
        if (b) b.startViewer();
    });

    socket.on('toggle-viewer', ({ id, enabled }) => {
        const b = bots.get(id);
        if (b) {
            if (enabled) b.startViewer();
            else b.cleanup();
        }
    });

    socket.on('join-bot-logs', (id) => {
        socket.join(id);
    });

    socket.on('bot-click-window', async ({ id, slot }) => {
        const b = bots.get(id);
        if (b?.bot?.currentWindow) {
            try { await b.bot.clickWindow(slot, 0, 0); } catch (e) {}
        }
    });

    // ===== INVENTARIO (CORREGIDO) =====
    socket.on('get-inventory', (id) => {
        const b = bots.get(id);
        if (!b || !b.bot || !b.isSpawned) {
            socket.emit('inventory-error', { id, error: 'Bot not available' });
            return;
        }
        const items = b.getInventory();
        socket.emit('inventory-data', { id, items });
    });

    socket.on('drop-item', async ({ id, slot }) => {
        const b = bots.get(id);
        if (!b || !b.bot || !b.isSpawned) {
            socket.emit('inventory-error', { id, error: 'Bot not available' });
            return;
        }
        try {
            const dropped = await b.dropItem(slot);
            if (dropped) {
                io.to(id).emit('log', `§a[Inventory] Item from slot ${slot} dropped.`);
                // Enviar inventario actualizado
                const items = b.getInventory();
                socket.emit('inventory-data', { id, items });
            } else {
                io.to(id).emit('log', `§e[Inventory] No item in slot ${slot}.`);
            }
        } catch (err) {
            console.error(`[DropItem] Error en bot ${id}:`, err);
            io.to(id).emit('log', `§c[Error] Could not drop: ${err.message}`);
            socket.emit('inventory-error', { id, error: err.message });
        }
    });

    socket.on('drop-all', async (id) => {
        const b = bots.get(id);
        if (!b || !b.bot || !b.isSpawned) {
            socket.emit('inventory-error', { id, error: 'Bot not available' });
            return;
        }
        try {
            await b.dropAll();
            io.to(id).emit('log', '§a[Inventory] Entire inventory was dropped.');
            const items = b.getInventory();
            socket.emit('inventory-data', { id, items });
        } catch (err) {
            console.error(`[DropAll] Error en bot ${id}:`, err);
            io.to(id).emit('log', `§c[Error] Could not drop entire inventory: ${err.message}`);
            socket.emit('inventory-error', { id, error: err.message });
        }
    });

    // ===== SISTEMA DE SEGUIMIENTO (FOLLOW) =====
    socket.on('start-follow', ({ id, targetUsername }) => {
        const b = bots.get(id);
        if (!b) {
            socket.emit('log', `§c[Error] Bot not found`);
            return;
        }
        if (!b.isSpawned) {
            socket.emit('log', `§e[Warning] ${b.settings?.username || id} is not in the world yet.`);
            return;
        }
        const success = b.startFollowing(targetUsername);
        if (success) {
            socket.emit('follow-started', { id, targetUsername });
        } else {
            socket.emit('log', `§c[Error] Could not start following ${targetUsername}`);
        }
    });

    socket.on('stop-follow', (id) => {
        const b = bots.get(id);
        if (b) {
            b.stopFollowing();
            socket.emit('follow-stopped', { id });
        }
    });

    socket.on('follow-all-owner', (ownerNick) => {
        if (!ownerNick) {
            socket.emit('log', '§c[Error] Owner nickname not provided');
            return;
        }
        let count = 0;
        bots.forEach((b, id) => {
            if (b.isSpawned && b.settings.username !== ownerNick) {
                b.startFollowing(ownerNick);
                count++;
            }
        });
        socket.emit('log', `§a[Follow] ${count} bots now following ${ownerNick}`);
        socket.emit('toast', { type: 'info', title: 'Following Started', message: `${count} bots following ${ownerNick}` });
    });

    socket.on('stop-all-follow', () => {
        let count = 0;
        bots.forEach((b, id) => {
            if (b.isFollowing()) {
                b.stopFollowing();
                count++;
            }
        });
        socket.emit('log', `§e[Follow] Stopped ${count} bots from following`);
    });

    // ===== CAMBIAR MÉTODO ANTI-AFK =====
    socket.on('set-antiafk-method', ({ id, method }) => {
        const b = bots.get(id);
        if (!b) {
            socket.emit('log', `§c[Error] Bot not found`);
            return;
        }
        // Actualizar configuración
        b.settings.antiafk = method;
        // Reiniciar anti-AFK con nuevo método si está activo
        if (b.isSpawned) {
            b.stopAntiAfk();
            b.startAntiAfk();
        }
        socket.emit('log', `§a[System] Anti-AFK method set to ${method}`);
    });

    // ===== EVENTOS DE DISCORD BOT (USAR io PARA ESCUCHAR) =====
    // Estos eventos se emiten desde discordbot.js y escuchamos en io
    
    // Store discord socket reference for responses
    let discordSocket = null;
    socket.on('discord-register', () => {
        discordSocket = socket;
        console.log('[Discord] Bot registered for events');
    });

    // Request status - emitido desde Discord
    socket.on('discord-request-status', () => {
        const botList = [];
        bots.forEach((b, id) => {
            botList.push({
                id: id,
                name: b.settings.username,
                status: b.isSpawned ? 'Online' : (b.serverSwitching ? 'Switching server...' : 'Offline'),
                host: b.settings.host,
                port: b.settings.port,
                auth: b.settings.auth
            });
        });
        // Emitir a todos los sockets para que Discord lo reciba
        io.emit('discord-status-response', { bots: botList });
    });

    socket.on('discord-follow-all', ({ target }) => {
        const ownerNick = target || 'Owner';
        let count = 0;
        bots.forEach((b, id) => {
            if (b.isSpawned && b.settings.username !== ownerNick) {
                b.startFollowing(ownerNick);
                count++;
            }
        });
        console.log(`[Discord] ${count} bots now following ${ownerNick}`);
        io.emit('discord-follow-response', { success: true, count, target: ownerNick });
    });

    socket.on('discord-stop-all-follow', () => {
        let count = 0;
        bots.forEach((b, id) => {
            if (b.isFollowing()) {
                b.stopFollowing();
                count++;
            }
        });
        console.log(`[Discord] Stopped ${count} bots from following`);
        io.emit('discord-stop-follow-response', { success: true, count });
    });

    socket.on('discord-request-inventory', ({ botName }) => {
        let foundBot = null;
        const searchName = botName.toLowerCase().trim();
        
        bots.forEach((b, id) => {
            const botUsername = (b.settings.username || '').toLowerCase();
            const botId = id.toLowerCase();
            // Buscar por username exacto, username parcial, o ID
            if (botUsername === searchName || 
                botId === searchName ||
                botUsername.includes(searchName) ||
                searchName.includes(botUsername)) {
                foundBot = b;
            }
        });
        
        if (foundBot && foundBot.isSpawned) {
            const items = foundBot.getInventory();
            io.emit('discord-inventory-response', { 
                botName: foundBot.settings.username,
                botId: foundBot.id,
                items: items 
            });
        } else {
            io.emit('discord-inventory-response', { 
                botName: botName,
                items: [],
                error: 'Bot not found or not spawned'
            });
        }
    });

    socket.on('discord-drop-item', ({ botName, slot }) => {
        const searchName = botName.toLowerCase().trim();
        let dropped = false;
        
        bots.forEach((b, id) => {
            const botUsername = (b.settings.username || '').toLowerCase();
            const botId = id.toLowerCase();
            
            if ((botUsername === searchName || 
                 botId === searchName ||
                 botUsername.includes(searchName) ||
                 searchName.includes(botUsername)) && b.isSpawned) {
                b.dropItem(slot).then(() => {
                    console.log(`[Discord] Dropped item from slot ${slot} on ${b.settings.username}`);
                }).catch(e => {
                    console.error(`[Discord] Error dropping item:`, e);
                });
                dropped = true;
            }
        });
        
        if (!dropped) {
            console.log(`[Discord] No bot found for drop: ${botName}`);
        }
    });

    socket.on('discord-drop-all', ({ botName }) => {
        const searchName = botName.toLowerCase().trim();
        let dropped = false;
        
        bots.forEach((b, id) => {
            const botUsername = (b.settings.username || '').toLowerCase();
            const botId = id.toLowerCase();
            
            if ((botUsername === searchName || 
                 botId === searchName ||
                 botUsername.includes(searchName) ||
                 searchName.includes(botUsername)) && b.isSpawned) {
                b.dropAll().then(() => {
                    console.log(`[Discord] Dropped all items from ${b.settings.username}`);
                }).catch(e => {
                    console.error(`[Discord] Error dropping all:`, e);
                });
                dropped = true;
            }
        });
        
        if (!dropped) {
            console.log(`[Discord] No bot found for dropall: ${botName}`);
        }
    });

    socket.on('discord-request-capture', ({ botName, requestId }) => {
        let found = false;
        bots.forEach((b, id) => {
            const searchName = botName.toLowerCase().trim();
            const botUsername = (b.settings.username || '').toLowerCase();
            const botId = id.toLowerCase();
            
            if (botUsername === searchName || 
                botId === searchName ||
                botUsername.includes(searchName) ||
                searchName.includes(botUsername)) {
                
                // Auto-start viewer if not enabled
                if (!b.viewerPort && b.isSpawned) {
                    b.startViewer();
                }
                
                if (b.viewerPort) {
                    found = true;
                    io.emit('discord-capture-response', {
                        requestId: requestId,
                        success: true,
                        botName: b.settings.username,
                        port: b.viewerPort
                    });
                }
            }
        });
        
        // Only emit error if bot was not found
        if (!found) {
            io.emit('discord-capture-response', {
                requestId: requestId,
                success: false,
                error: 'Bot not found or not spawned'
            });
        }
    });

    socket.on('discord-chat-all', ({ message }) => {
        bots.forEach((b, id) => {
            if (b.isSpawned) {
                b.sendChat(message).catch(() => {});
            }
        });
        console.log(`[Discord] Chat sent to all bots: ${message}`);
        io.emit('discord-chat-response', { success: true, message });
    });

    socket.on('discord-command-all', ({ command, botName }) => {
        if (botName) {
            // Send to specific bot
            bots.forEach((b, id) => {
                if ((b.settings.username === botName || id === botName) && (b.isSpawned || command.startsWith('/'))) {
                    b.sendChat(command).catch(() => {});
                }
            });
            console.log(`[Discord] Command sent to ${botName}: ${command}`);
        } else {
            // Send to all bots
            bots.forEach((b, id) => {
                if (b.isSpawned || command.startsWith('/')) {
                    b.sendChat(command).catch(() => {});
                }
            });
            console.log(`[Discord] Command sent to all bots: ${command}`);
        }
        io.emit('discord-command-response', { success: true, command, botName });
    });

    socket.on('discord-server-switch', ({ server, port, version, botName }) => {
        if (botName) {
            // Switch specific bot
            bots.forEach((b, id) => {
                if ((b.settings.username === botName || id === botName) && b.isSpawned) {
                    b.sendChat(`/server ${server}`).catch(() => {});
                    console.log(`[Discord] Server switch sent to ${botName}: ${server}`);
                }
            });
        } else {
            // Switch all bots
            bots.forEach((b, id) => {
                if (b.isSpawned) {
                    b.sendChat(`/server ${server}`).catch(() => {});
                }
            });
            console.log(`[Discord] Server switch command sent: ${server}${port ? ':' + port : ''}${version ? ' (v' + version + ')' : ''}`);
        }
        io.emit('discord-server-response', { success: true, server, botName });
    });
});

// ================= EXPORTAR FUNCIÓN DE INICIO =================
const startServer = () => {
    if (serverStarted) return;
    serverStarted = true;

    const userDataPath = electronApp.getPath('userData');
    sessionsPath = path.join(userDataPath, 'msa-profiles');
    try {
        if (!fs.existsSync(sessionsPath)) {
            fs.mkdirSync(sessionsPath, { recursive: true });
            console.log('[Server] Sessions directory created:', sessionsPath);
        } else {
            console.log('[Server] Sessions directory already exists:', sessionsPath);
        }
    } catch (err) {
        console.error('[Server] Error creating sessions directory:', err);
    }

    // Avoid crashing if another app instance already bound the port.
    server.once('error', (err) => {
        if (err && err.code === 'EADDRINUSE') {
            console.warn(`[Server] Port ${PORT} already in use (EADDRINUSE). Reusing existing server.`);
            return;
        }
        throw err;
    });

    server.listen(PORT, () => {
        console.log(`\n==========================================`);
        console.log(`[Server] Panel Pro listo en http://localhost:${PORT}`);
        console.log(`==========================================\n`);
    });

    return { io, server };
};

module.exports = startServer;