const mineflayer = require('mineflayer');
const readline = require('readline');

const options = {
    host: 'localhost',
    port: 25565,
    username: 'AFK_Bot',
    version: false,
    auth: 'offline',
};

let bot;
let isSpawned = false;

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
});

// Start terminal input immediately
rl.on('line', (line) => {
    const input = line.trim();
    if (!input) return;

    if (!bot) {
        console.warn('[Terminal] Bot has not started yet.');
        return;
    }

    if (input.startsWith('!')) {
        const [command, ...args] = input.slice(1).split(' ');
        handleCommand(command, args.join(' '));
    } else {
        if (!isSpawned && !input.startsWith('/')) {
            console.warn('[Terminal] Bot has not spawned yet. You can only send commands (e.g., /login).');
            if (!input.startsWith('/')) return;
        }
        console.log(`[AFKBot] Sending: ${input}`);
        bot.chat(input);
    }
});

function createBot() {
    isSpawned = false;
    console.log(`[AFKBot] Connecting to ${options.host}:${options.port} as ${options.username}...`);
    
    bot = mineflayer.createBot(options);

    bot.on('message', (jsonMsg) => {
        console.log(`[Server] ${jsonMsg.toAnsi()}`);
    });

    bot.on('login', () => {
        console.log('[AFKBot] Logged into server! Waiting for spawn...');
    });

    bot.once('spawn', () => {
        isSpawned = true;
        console.log('[AFKBot] Bot spawned successfully in the world.');
        console.log('[Terminal] Type text and press Enter to send chat. For help: !help');
    });

    bot.on('error', (err) => {
        console.error('[AFKBot] Error Occurred:', err.message);
    });

    bot.on('kicked', (reason) => {
        let message = reason;
        try {
            const parsed = JSON.parse(reason);
            message = parsed.text || reason;
        } catch (e) {
            // reason is not JSON
        }
        console.warn('[AFKBot] Kicked from server:', message);
    });

    bot.on('end', () => {
        isSpawned = false;
        console.warn('[AFKBot] Connection lost.');
        const delay = 10000;
        console.log(`[AFKBot] Reconnecting in ${delay / 1000} seconds...`);
        setTimeout(createBot, delay);
    });
}

function handleCommand(command, arg) {
    if (!bot) return;

    switch (command.toLowerCase()) {
        case 'help':
            console.log('\n--- AFKBot Commands ---');
            console.log('!chat <message>  : Sends group message (or just type)');
            console.log('!left            : Left click (Attack)');
            console.log('!right           : Right click (Use item)');
            console.log('!exit            : Closes the bot');
            console.log('!help            : Shows this help menu');
            console.log('-----------------------\n');
            break;
        case 'chat':
            bot.chat(arg);
            break;
        case 'left':
            console.log('[AFKBot] Performing left click...');
            const entity = bot.nearestEntity();
            if (entity) {
                bot.attack(entity);
            } else {
                bot.swingArm();
            }
            break;
        case 'right':
            console.log('[AFKBot] Performing right click...');
            bot.activateItem();
            break;
        case 'exit':
            if (bot) {
                console.log('[AFKBot] Leaving server...');
                bot.quit();
            }
            setTimeout(() => process.exit(), 1000);
            break;
        default:
            console.log('[Terminal] Unknown command. Type !help for the list.');
    }
}

// Graceful shutdown handling
const gracefulShutdown = () => {
    console.log('\n[AFKBot] Shutting down...');
    if (bot) {
        bot.quit();
    }
    setTimeout(() => {
        process.exit(0);
    }, 1000);
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

createBot();
