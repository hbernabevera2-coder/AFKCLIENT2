// proxy_manager.js
const { ProxyAgent } = require('proxy-agent');
const fs = require('fs');
const path = require('path');

class ProxyManager {
    // Función para limpiar o resetear (puedes llamarla si quieres borrar rastros)
    static clearProxyConfig() {
        console.log("[Proxy] Clearing proxy configuration...");
        // Si tuvieras un archivo JSON de base de datos de proxies, aquí lo borrarías:
        // const proxyFile = path.join(__dirname, 'proxies.json');
        // if (fs.existsSync(proxyFile)) fs.unlinkSync(proxyFile);
    }

    static parseProxy(proxyString) {
        // Si no hay proxy, es "None", o es un string vacío, devolvemos null
        if (!proxyString || proxyString === 'None' || proxyString === 'none' || proxyString.trim() === '') {
            return null;
        }

        let formattedProxy = proxyString.trim();

        // Si el usuario puso algo como "aaaaaa" (inválido), evitamos que rompa el bot
        if (formattedProxy.length < 4) return null; 

        if (!formattedProxy.includes('://')) {
            const parts = formattedProxy.split(':');
            
            if (parts.length === 2) {
                // Formato: ip:puerto -> SOCKS5 por defecto
                formattedProxy = `socks5://${parts[0]}:${parts[1]}`;
            } else if (parts.length === 4) {
                // Formato: ip:puerto:user:pass
                formattedProxy = `socks5://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
            } else {
                formattedProxy = `socks5://${formattedProxy}`;
            }
        }

        return formattedProxy;
    }

    static getAgent(proxyString) {
        try {
            const url = this.parseProxy(proxyString);
            if (!url) return null;

            // Verificamos si la URL es válida antes de crear el agente
            new URL(url); 
            
            console.log(`[Proxy] Applying proxy: ${url}`);
            return new ProxyAgent(url);
        } catch (e) {
            console.error(`[Proxy Error] Proxy "${proxyString}" is invalid. Using direct connection.`);
            return null;
        }
    }
}

module.exports = ProxyManager;