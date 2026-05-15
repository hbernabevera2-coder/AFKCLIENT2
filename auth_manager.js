const http = require('http');
const { shell, app } = require('electron');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const mineflayer = require('mineflayer');
const { exec } = require('child_process');

class AuthManager {
    constructor() {
        this.clientId = 'a332a5f6-c4dc-45b6-9fe3-d881490252b2';
        this.redirectUri = 'http://localhost:46521';
        this.port = 46521;
        this.profilesFolder = path.join(app.getPath('userData'), 'msa-profiles');

        if (!fs.existsSync(this.profilesFolder)) {
            fs.mkdirSync(this.profilesFolder, { recursive: true });
        }
    }

    getCachePath(username) {
        return path.join(
            this.profilesFolder,
            username,
            this.clientId.substring(0, 8),
            'mca-cache.json'
        );
    }

    loadCache(username) {
        try {
            const filePath = this.getCachePath(username);
            if (fs.existsSync(filePath)) {
                return JSON.parse(fs.readFileSync(filePath, 'utf8'));
            }
        } catch (e) {
            console.warn(`[AuthManager] Could not read cache for ${username}:`, e.message);
        }
        return null;
    }

    saveCache(username, data) {
        const filePath = this.getCachePath(username);
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        console.log(`[AuthManager] Saved session for: ${username}`);
    }

    isTokenExpired(cache) {
        if (!cache?.mca?.issued_at || !cache?.mca?.expires_in) return true;
        const issuedAt = new Date(cache.mca.issued_at).getTime();
        const expiresMs = (cache.mca.expires_in - 300) * 1000;
        return Date.now() > issuedAt + expiresMs;
    }

    isMcTokenExpired(mct) {
        if (!mct?.issued_at || !mct?.expires_in) return true;
        const issuedAt = new Date(mct.issued_at).getTime();
        const expiresMs = mct.expires_in * 1000;
        return Date.now() > issuedAt + expiresMs;
    }

    async refreshTokens(username) {
        const cache = this.loadCache(username);
        if (!cache?.mca?.refresh_token) {
            throw new Error('No refresh_token found. Manual login is required.');
        }

        console.log(`[AuthManager] Renovando token para ${username}...`);

        const tokenRes = await axios.post(
            'https://login.live.com/oauth20_token.srf',
            new URLSearchParams({
                client_id: this.clientId,
                refresh_token: cache.mca.refresh_token,
                grant_type: 'refresh_token',
                redirect_uri: this.redirectUri,
                scope: 'Xboxlive.signin offline_access'
            }).toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        const oauth = tokenRes.data;
        if (!oauth.access_token) throw new Error('Invalid or expired refresh token.');

        const mcData = await this.getMcSession(oauth);
        const newCache = this.buildCache(oauth, mcData);
        this.saveCache(username, newCache);

        console.log(`[AuthManager] Token renovado correctamente para ${username}.`);
        return { username: mcData.username, uuid: mcData.uuid };
    }

    // Método que lanza el servidor OAuth y abre la URL
    async login() {
        return new Promise((resolve, reject) => {
            const loginState = Math.random().toString(36).substring(7);
            let server = null;

            // Intentamos usar el puerto configurado, si falla probamos otro
            const tryListen = (port) => {
                server = http.createServer(async (req, res) => {
                    const url = new URL(req.url, this.redirectUri);
                    const code = url.searchParams.get('code');
                    const state = url.searchParams.get('state');

                    if (code) {
                        if (state !== loginState) {
                            res.writeHead(403);
                            res.end('Security Error');
                            return;
                        }

                        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(`
                            <html>
                                <body style="background:#121212;color:white;text-align:center;padding:50px;">
                                    <h1>✅ Authentication successful</h1>
                                    <p>You can close this tab and return to the panel.</p>
                                </body>
                            </html>
                        `);
                        server.close();

                        try {
                            const sessionData = await this.exchangeCodeForMcToken(code);
                            resolve(sessionData);
                        } catch (err) {
                            reject(err);
                        }
                    }
                });

                server.on('error', (err) => {
                    console.error(`[AuthManager] Error en servidor OAuth en puerto ${port}:`, err);
                    if (err.code === 'EADDRINUSE') {
                        // Puerto ocupado, probamos el siguiente
                        console.log(`[AuthManager] Puerto ${port} ocupado, probando puerto ${port + 1}`);
                        tryListen(port + 1);
                    } else {
                        reject(err);
                    }
                });

                server.listen(port, () => {
                    console.log(`[AuthManager] Servidor OAuth escuchando en http://localhost:${port}`);
                    const scope = 'Xboxlive.signin offline_access';
                    const authUrl = `https://login.live.com/oauth20_authorize.srf?client_id=${this.clientId}&response_type=code&redirect_uri=${encodeURIComponent(this.redirectUri)}&scope=${encodeURIComponent(scope)}&state=${loginState}&prompt=select_account`;
                    
                    // Intentar abrir URL con shell.openExternal, si falla usar child_process
                    try {
                        shell.openExternal(authUrl);
                    } catch (e) {
                        console.error('[AuthManager] shell.openExternal falló, usando child_process:', e);
                        const openCommand = process.platform === 'win32' ? 'start' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
                        exec(`${openCommand} "${authUrl}"`, (err) => {
                            if (err) console.error('[AuthManager] Error abriendo URL con child_process:', err);
                        });
                    }
                });
            };

            tryListen(this.port);
        });
    }

    async exchangeCodeForMcToken(code) {
        const tokenRes = await axios.post(
            'https://login.live.com/oauth20_token.srf',
            new URLSearchParams({
                client_id: this.clientId,
                code: code,
                grant_type: 'authorization_code',
                redirect_uri: this.redirectUri,
                scope: 'Xboxlive.signin offline_access'
            }).toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        const oauth = tokenRes.data;
        const mcData = await this.getMcSession(oauth);
        const cacheData = this.buildCache(oauth, mcData);
        this.saveCache(mcData.username, cacheData);
        return { username: mcData.username, uuid: mcData.uuid };
    }

    async getMcSession(oauth) {
        const xblRes = await axios.post('https://user.auth.xboxlive.com/user/authenticate', {
            Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${oauth.access_token}` },
            RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT'
        });

        const xstsRes = await axios.post('https://xsts.auth.xboxlive.com/xsts/authorize', {
            Properties: { SandboxId: 'RETAIL', UserTokens: [xblRes.data.Token] },
            RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT'
        });

        const mcRes = await axios.post('https://api.minecraftservices.com/authentication/login_with_xbox', {
            identityToken: `XBL3.0 x=${xblRes.data.DisplayClaims.xui[0].uhs};${xstsRes.data.Token}`
        });

        const profileRes = await axios.get('https://api.minecraftservices.com/minecraft/profile', {
            headers: { Authorization: `Bearer ${mcRes.data.access_token}` }
        });

        return {
            username: profileRes.data.name,
            uuid: profileRes.data.id,
            mc_access_token: mcRes.data.access_token,
            mc_expires_in: mcRes.data.expires_in
        };
    }

    buildCache(oauth, mcData) {
        return {
            mca: {
                token_type: oauth.token_type,
                expires_in: oauth.expires_in,
                scope: oauth.scope,
                access_token: oauth.access_token,
                refresh_token: oauth.refresh_token,
                user_id: oauth.user_id,
                client_id: this.clientId,
                issued_at: new Date().toISOString()
            },
            mct: {
                access_token: mcData.mc_access_token,
                expires_in: mcData.mc_expires_in,
                issued_at: new Date().toISOString()
            },
            profile: {
                id: mcData.uuid,
                name: mcData.username
            }
        };
    }

    async getValidSession(username) {
        const cache = this.loadCache(username);
        if (!cache) {
            throw new Error(`No saved session for "${username}". Add the account first.`);
        }

        if (this.isTokenExpired(cache)) {
            console.log(`[AuthManager] Token de Microsoft de ${username} expirado. Renovando automáticamente...`);
            return await this.refreshTokens(username);
        }

        console.log(`[AuthManager] Token de Microsoft de ${username} válido.`);
        return { username: cache.profile?.name || username, uuid: cache.profile?.id };
    }

    async getBotSession(username) {
        await this.getValidSession(username);
        const cache = this.loadCache(username);
        if (!cache) return null;

        let profile = cache.profile;
        let mct = cache.mct;

        if (!profile && cache.mca?.access_token) {
            try {
                console.log(`[AuthManager] Recuperando perfil para ${username} desde la API...`);
                const mcData = await this.getMcSession({ access_token: cache.mca.access_token });
                profile = { id: mcData.uuid, name: mcData.username };
                mct = {
                    access_token: mcData.mc_access_token,
                    expires_in: mcData.mc_expires_in,
                    issued_at: new Date().toISOString()
                };
                cache.profile = profile;
                cache.mct = mct;
                this.saveCache(username, cache);
            } catch (e) {
            console.error(`[AuthManager] Could not retrieve profile for ${username}:`, e.message);
                return null;
            }
        }

        if (mct && this.isMcTokenExpired(mct)) {
            console.log(`[AuthManager] Token de Minecraft de ${username} expirado. Renovando...`);
            try {
                await this.refreshTokens(username);
                const newCache = this.loadCache(username);
                if (newCache) {
                    profile = newCache.profile;
                    mct = newCache.mct;
                    console.log(`[AuthManager] Token de Minecraft renovado para ${username}. Nuevo nombre: ${profile?.name}`);
                }
            } catch (e) {
                console.error(`[AuthManager] Could not refresh Minecraft token for ${username}:`, e.message);
                return null;
            }
        }

        if (!profile || !mct?.access_token) {
            console.error(`[AuthManager] Datos de sesión incompletos para ${username}`);
            return null;
        }

        console.log(`[AuthManager] Minecraft session for ${profile.name} prepared.`);
        return {
            accessToken: mct.access_token,
            clientToken: profile.id,
            selectedProfile: {
                id: profile.id,
                name: profile.name
            }
        };
    }

    async primeProfile(username) {
        let session = await this.getBotSession(username);
        if (!session) {
            throw new Error(`Could not obtain a session to prime the account ${username}`);
        }

        console.log(`[AuthManager] Iniciando prime para ${username}...`);

        return new Promise((resolve, reject) => {
            const profilePath = path.join(this.profilesFolder, session.selectedProfile.name);
            const botOptions = {
                host: 'mc.hypixel.net',
                port: 25565,
                username: session.selectedProfile.name,
                auth: 'microsoft',
                profilesFolder: profilePath,
                session: session,
                connectTimeout: 15000,
                checkTimeoutInterval: 30000
            };

            const originalStdoutWrite = process.stdout.write;
            const originalStderrWrite = process.stderr.write;
            let codeCaptured = false;

            const filterOutput = (chunk, encoding, callback, originalFn) => {
                const msg = chunk.toString();
                const codeMatch = msg.match(/otc=([A-Z0-9]{6,9})/i) ||
                                  msg.match(/use the code\s+([A-Z0-9]{6,9})/i) ||
                                  msg.match(/enter the code\s+([A-Z0-9]{6,9})/i);
                if (codeMatch && !codeCaptured) {
                    codeCaptured = true;
                    const code = codeMatch[1].toUpperCase();
                    const url = `https://www.microsoft.com/link?otc=${code}`;
                    console.log(`[AuthManager] Código detectado: ${code}. Abriendo ${url}...`);
                    const { shell } = require('electron');
                    shell.openExternal(url);
                    if (callback) callback();
                    return;
                }
                if (callback) {
                    originalFn.call(process.stdout, chunk, encoding, callback);
                } else {
                    originalFn.call(process.stdout, chunk, encoding);
                }
            };

            process.stdout.write = function(chunk, encoding, callback) {
                filterOutput(chunk, encoding, callback, originalStdoutWrite);
            };
            process.stderr.write = function(chunk, encoding, callback) {
                filterOutput(chunk, encoding, callback, originalStderrWrite);
            };

            const restoreOutput = () => {
                process.stdout.write = originalStdoutWrite;
                process.stderr.write = originalStderrWrite;
            };

            const tempBot = mineflayer.createBot(botOptions);
            let isDone = false;

            const cleanup = () => {
                if (isDone) return;
                isDone = true;
                restoreOutput();
                if (tempBot && typeof tempBot.quit === 'function') {
                    tempBot.quit();
                }
            };

            tempBot.once('spawn', () => {
                console.log(`[AuthManager] Bot temporal de prime para ${username} ha aparecido. Desconectando...`);
                setTimeout(() => {
                    cleanup();
                    resolve();
                }, 2000);
            });

            tempBot.once('error', (err) => {
                console.error(`[AuthManager] Error en bot temporal de prime:`, err.message);
                cleanup();
                reject(err);
            });

            tempBot.once('end', () => {
                if (!isDone) {
                    cleanup();
                    resolve();
                }
            });

            setTimeout(() => {
                if (!isDone) {
                    console.warn(`[AuthManager] Prime timeout para ${username}.`);
                    cleanup();
                    resolve();
                }
            }, 45000);
        });
    }
}

module.exports = AuthManager;