const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');

class DiscordBotManager {
    constructor() {
        this.client = null;
        this.token = null;
        this.guildId = null;
        this.isConnected = false;
        this.socket = null; // Socket.IO client connection to server.js
        this.tempCaptures = new Map(); // Temporary storage for capture requests
        this.knownBots = new Map(); // Store known bots for autocomplete
    }

    connectSocket() {
        if (this.socket && this.socket.connected) return true;
        if (this.socket && !this.socket.connected) {
            this.socket.connect();
            return true;
        }
        
        try {
            // Connect as client to local server
            this.socket = io('http://localhost:3000', {
                reconnection: true,
                reconnectionAttempts: 10,
                reconnectionDelay: 1000
            });
            
            this.socket.on('connect', () => {
                console.log('[DiscordBot] Socket connected to server');
                // Register as Discord bot
                this.socket.emit('discord-register');
            });
            
            this.socket.on('disconnect', () => {
                console.log('[DiscordBot] Socket disconnected, will retry...');
            });
            
            this.socket.on('connect_error', (err) => {
                console.log('[DiscordBot] Socket connection error:', err.message);
            });
            
            // Listen for bot list updates
            this.socket.on('init-bots', (bots) => {
                this.knownBots.clear();
                bots.forEach(b => this.knownBots.set(b.id, b));
            });
            
            this.socket.on('bot-added', (bot) => {
                this.knownBots.set(bot.id, bot);
            });
            
            this.socket.on('bot-removed', (id) => {
                // Don't remove, just mark as offline so they still appear in status
                const bot = this.knownBots.get(id);
                if (bot) {
                    bot.status = 'Offline';
                    this.knownBots.set(id, bot);
                }
            });
            
            this.socket.on('bot-status', ({ id, status }) => {
                const bot = this.knownBots.get(id);
                if (bot) {
                    bot.status = status;
                    this.knownBots.set(id, bot);
                }
            });
            
            return true;
        } catch (e) {
            console.error('[DiscordBot] Failed to connect socket:', e);
            return false;
        }
    }

    loadConfig() {
        try {
            // Use Electron's userData path for config storage
            const { app } = require('electron');
            const configPath = path.join(app.getPath('userData'), 'discord_config.json');
            if (fs.existsSync(configPath)) {
                const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                this.token = config.token;
                this.guildId = config.guildId;
                return true;
            }
        } catch (e) {
            console.error('[DiscordBot] Error loading config:', e);
        }
        return false;
    }

    saveConfig(token, guildId) {
        try {
            // Use Electron's userData path for config storage
            const { app } = require('electron');
            const configPath = path.join(app.getPath('userData'), 'discord_config.json');
            fs.writeFileSync(configPath, JSON.stringify({ token, guildId }, null, 2));
            this.token = token;
            this.guildId = guildId;
            return true;
        } catch (e) {
            console.error('[DiscordBot] Error saving config:', e);
            return false;
        }
    }

    async start() {
        if (!this.loadConfig()) {
            console.log('[DiscordBot] No config found. Please set token and guild ID in settings.');
            return false;
        }

        if (!this.token || !this.guildId) {
            console.log('[DiscordBot] Token or Guild ID missing.');
            return false;
        }

        // Connect Socket.IO client first
        this.connectSocket();

        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.GuildMembers
            ]
        });

        this.client.on('ready', async () => {
            console.log(`[DiscordBot] Logged in as ${this.client.user.tag}`);
            this.isConnected = true;
            await this.registerSlashCommands();
        });

        this.client.on('interactionCreate', async (interaction) => {
            if (interaction.isButton()) {
                await this.handleButton(interaction);
                return;
            }
            if (interaction.isAutocomplete()) {
                await this.handleAutocomplete(interaction);
                return;
            }
            if (!interaction.isChatInputCommand()) return;
            await this.handleCommand(interaction);
        });

        try {
            await this.client.login(this.token);
            return true;
        } catch (e) {
            console.error('[DiscordBot] Login failed:', e.message);
            return false;
        }
    }

    async registerSlashCommands() {
        const commands = [
            new SlashCommandBuilder()
                .setName('help')
                .setDescription('Show all available commands and how to use them'),
            
            new SlashCommandBuilder()
                .setName('status')
                .setDescription('Show status of all bots'),
            
            new SlashCommandBuilder()
                .setName('follow')
                .setDescription('Make all bots follow the owner')
                .addStringOption(option =>
                    option.setName('target')
                        .setDescription('Target player to follow (optional, uses owner if not set)')
                        .setRequired(false)),
            
            new SlashCommandBuilder()
                .setName('stop')
                .setDescription('Stop all bots from following'),
            
            new SlashCommandBuilder()
                .setName('showinventory')
                .setDescription('Show inventory of a bot')
                .addStringOption(option =>
                    option.setName('bot')
                        .setDescription('Bot name or ID')
                        .setRequired(true)
                        .setAutocomplete(true)),
            
            new SlashCommandBuilder()
                .setName('drop')
                .setDescription('Drop an item from bot inventory')
                .addStringOption(option =>
                    option.setName('bot')
                        .setDescription('Bot name or ID')
                        .setRequired(true)
                        .setAutocomplete(true))
                .addIntegerOption(option =>
                    option.setName('slot')
                        .setDescription('Slot number to drop')
                        .setRequired(true)
                        .setMinValue(0)
                        .setMaxValue(35)),
            
            new SlashCommandBuilder()
                .setName('dropall')
                .setDescription('Drop all items from bot inventory')
                .addStringOption(option =>
                    option.setName('bot')
                        .setDescription('Bot name or ID')
                        .setRequired(true)
                        .setAutocomplete(true)),
            
            new SlashCommandBuilder()
                .setName('capture')
                .setDescription('Capture what a bot sees (3D viewer)')
                .addStringOption(option =>
                    option.setName('bot')
                        .setDescription('Bot name or ID')
                        .setRequired(true)
                        .setAutocomplete(true)),
            
            new SlashCommandBuilder()
                .setName('chat')
                .setDescription('Send a message as all bots')
                .addStringOption(option =>
                    option.setName('message')
                        .setDescription('Message to send')
                        .setRequired(true)),
            
            new SlashCommandBuilder()
                .setName('command')
                .setDescription('Send a command to bots')
                .addStringOption(option =>
                    option.setName('cmd')
                        .setDescription('Command to execute (with /)')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('bot')
                        .setDescription('Bot name (leave empty for all bots)')
                        .setRequired(false)
                        .setAutocomplete(true)),
            
            new SlashCommandBuilder()
                .setName('killall')
                .setDescription('Stop all bots'),
            
            new SlashCommandBuilder()
                .setName('server')
                .setDescription('Switch bots to a different server')
                .addStringOption(option =>
                    option.setName('server')
                        .setDescription('Server name (e.g., practice, afk, lobby) or IP')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('port')
                        .setDescription('Server port (default: 25565)')
                        .setRequired(false))
                .addStringOption(option =>
                    option.setName('version')
                        .setDescription('Minecraft version (e.g., 1.20.1, 1.8.9)')
                        .setRequired(false))
                .addStringOption(option =>
                    option.setName('bot')
                        .setDescription('Bot name (leave empty for all bots)')
                        .setRequired(false)
                        .setAutocomplete(true)),
        ];

        const rest = new REST({ version: '10' }).setToken(this.token);

        try {
            console.log('[DiscordBot] Registering slash commands...');
            await rest.put(
                Routes.applicationGuildCommands(this.client.user.id, this.guildId),
                { body: commands.map(cmd => cmd.toJSON()) }
            );
            console.log('[DiscordBot] Slash commands registered.');
        } catch (e) {
            console.error('[DiscordBot] Failed to register commands:', e.message);
        }
    }

    async handleCommand(interaction) {
        const { commandName } = interaction;

        switch (commandName) {
            case 'help':
                await this.handleHelp(interaction);
                break;
            case 'status':
                await this.handleStatus(interaction);
                break;
            case 'follow':
                await this.handleFollow(interaction);
                break;
            case 'stop':
                await this.handleStop(interaction);
                break;
            case 'showinventory':
                await this.handleShowInventory(interaction);
                break;
            case 'drop':
                await this.handleDrop(interaction);
                break;
            case 'dropall':
                await this.handleDropAll(interaction);
                break;
            case 'capture':
                await this.handleCapture(interaction);
                break;
            case 'chat':
                await this.handleChat(interaction);
                break;
            case 'command':
                await this.handleCommandCmd(interaction);
                break;
            case 'killall':
                await this.handleKillAll(interaction);
                break;
            case 'server':
                await this.handleServerSwitch(interaction);
                break;
        }
    }

    async handleButton(interaction) {
        if (!interaction.isButton()) return;
        
        const customId = interaction.customId;
        
        // Handle drop all button from inventory
        if (customId.startsWith('dropall_')) {
            const botId = customId.replace('dropall_', '');
            
            // Find bot name from known bots
            const bot = this.knownBots.get(botId);
            const botName = bot?.settings?.username || bot?.name || botId;
            
            await interaction.deferReply({ ephemeral: true });
            
            this.socket.emit('discord-drop-all', { botName });
            
            await interaction.editReply(`🗑️ Dropping **all items** from bot **${botName}**`);
        }
    }

    async handleAutocomplete(interaction) {
        const focusedOption = interaction.options.getFocused(true);
        
        // Only handle 'bot' option autocomplete
        if (focusedOption.name !== 'bot') return;
        
        const choices = [];
        
        // Add "All Bots" option
        choices.push({ name: '🤖 All Bots', value: '' });
        
        // Add known bots from the app
        this.knownBots.forEach((bot, id) => {
            const status = bot.status || 'Unknown';
            const statusEmoji = status === 'Online' ? '🟢' : status.includes('Reconnect') ? '🟡' : '🔴';
            choices.push({
                name: `${statusEmoji} ${bot.settings?.username || bot.name || id} (${status})`,
                value: bot.settings?.username || bot.name || id
            });
        });
        
        // Filter based on user input
        const filtered = choices.filter(choice => 
            choice.name.toLowerCase().includes(focusedOption.value.toLowerCase()) ||
            choice.value.toLowerCase().includes(focusedOption.value.toLowerCase())
        );
        
        // Limit to 25 choices (Discord max)
        await interaction.respond(filtered.slice(0, 25));
    }

    async handleHelp(interaction) {
        const embed = new EmbedBuilder()
            .setTitle('🤖 AFK Client - Command Help')
            .setDescription('Here are all available commands:')
            .setColor(0x7289DA)
            .addFields(
                { name: '/status', value: 'Show status of all connected bots', inline: true },
                { name: '/follow [target]', value: 'Make bots follow owner or specific player', inline: true },
                { name: '/stop', value: 'Stop all bots from following', inline: true },
                { name: '/showinventory <bot>', value: 'Show inventory of a specific bot', inline: true },
                { name: '/drop <bot> <slot>', value: 'Drop item from specific slot', inline: true },
                { name: '/dropall <bot>', value: 'Drop all items from bot', inline: true },
                { name: '/capture <bot>', value: 'Open 3D viewer for bot', inline: true },
                { name: '/chat <message>', value: 'Send chat message from all bots', inline: true },
                { name: '/command <cmd> [bot]', value: 'Send command (use bot param for specific bot)', inline: true },
                { name: '/server <name> [port] [version] [bot]', value: 'Switch server. Example: `/server adrenalin 25565 1.20.1`', inline: false },
                { name: '/killall', value: 'Stop all bots (with confirmation)', inline: true },
                { name: '/help', value: 'Show this help message', inline: true }
            )
            .setFooter({ text: 'Tip: Use bot parameter to target specific bot, leave empty for all bots' })
            .setTimestamp();

        await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    async handleStatus(interaction) {
        await interaction.deferReply();
        
        // If no known bots, request from server
        if (this.knownBots.size === 0) {
            // Ensure socket is connected
            this.connectSocket();
            
            // Wait for socket connection
            let attempts = 0;
            while (!this.socket?.connected && attempts < 5) {
                await new Promise(resolve => setTimeout(resolve, 200));
                attempts++;
            }
            
            if (this.socket?.connected) {
                // Request current bot list from server
                this.socket.emit('discord-request-status');
                
                // Wait for response with timeout
                const botList = await new Promise((resolve) => {
                    const timeout = setTimeout(() => resolve([]), 3000);
                    this.socket.once('discord-status-response', (data) => {
                        clearTimeout(timeout);
                        resolve(data.bots || []);
                    });
                });
                
                // Populate knownBots from response
                botList.forEach(bot => {
                    this.knownBots.set(bot.id, bot);
                });
            }
        }
        
        const botList = Array.from(this.knownBots.values());
        
        if (botList.length === 0) {
            await interaction.editReply('📭 No bots found. Start some bots first.');
            return;
        }

        const embed = new EmbedBuilder()
            .setTitle('🤖 AFK Client - Bot Status')
            .setDescription(`Total bots: ${botList.length}`)
            .setColor(0x7289DA)
            .setTimestamp();

        // Sort: Online first, then offline
        const sortedBots = botList.sort((a, b) => {
            const aOnline = a.status === 'Online' || a.status === 'Active';
            const bOnline = b.status === 'Online' || b.status === 'Active';
            return bOnline - aOnline;
        });

        sortedBots.forEach(bot => {
            const status = bot.status || 'Unknown';
            const isOnline = status === 'Online' || status === 'Active';
            const isReconnecting = status.includes('Reconnect') || status.includes('Switching');
            const statusEmoji = isOnline ? '🟢' : isReconnecting ? '🟡' : '🔴';
            const host = bot.settings?.host || bot.host || 'N/A';
            const port = bot.settings?.port || bot.port || 'N/A';
            const auth = bot.settings?.auth || bot.auth || 'offline';
            
            embed.addFields({
                name: `${statusEmoji} ${bot.settings?.username || bot.name || bot.id}`,
                value: `Status: **${status}**\nServer: ${host}:${port}\nAuth: ${auth}`,
                inline: true
            });
        });

        await interaction.editReply({ embeds: [embed] });
    }

    async handleFollow(interaction) {
        const target = interaction.options.getString('target');
        
        await interaction.deferReply();
        
        this.socket.emit('discord-follow-all', { target });
        
        await interaction.editReply(target 
            ? `👥 All bots are now following **${target}**`
            : `👥 All bots are now following the owner`);
    }

    async handleStop(interaction) {
        await interaction.deferReply();
        
        this.socket.emit('discord-stop-all-follow');
        
        await interaction.editReply('🛑 All bots stopped following.');
    }

    async handleShowInventory(interaction) {
        const botName = interaction.options.getString('bot');
        
        await interaction.deferReply();
        
        this.socket.emit('discord-request-inventory', { botName });
        
        const timeout = setTimeout(async () => {
            await interaction.editReply('❌ Timeout getting inventory. Bot may be offline.');
        }, 5000);

        this.socket.once('discord-inventory-response', async (data) => {
            clearTimeout(timeout);
            
            if (!data.items || data.items.length === 0) {
                await interaction.editReply(`📭 **${data.botName}** has an empty inventory.`);
                return;
            }

            const embed = new EmbedBuilder()
                .setTitle(`🎒 ${data.botName}'s Inventory`)
                .setColor(0x0099ff)
                .setTimestamp();

            let description = '';
            data.items.forEach(item => {
                description += `Slot ${item.slot}: **${item.displayName || item.name}** x${item.count}\n`;
            });
            
            embed.setDescription(description);
            
            // Add drop buttons
            const rows = [];
            const dropAllButton = new ButtonBuilder()
                .setCustomId(`dropall_${data.botId}`)
                .setLabel('Drop All')
                .setStyle(ButtonStyle.Danger);
            
            rows.push(new ActionRowBuilder().addComponents(dropAllButton));
            
            await interaction.editReply({ embeds: [embed], components: rows });
        });
    }

    async handleDrop(interaction) {
        const botName = interaction.options.getString('bot');
        const slot = interaction.options.getInteger('slot');
        
        await interaction.deferReply();
        
        this.socket.emit('discord-drop-item', { botName, slot });
        
        await interaction.editReply(`🗑️ Dropping item from slot **${slot}** on bot **${botName}**`);
    }

    async handleDropAll(interaction) {
        const botName = interaction.options.getString('bot');
        
        await interaction.deferReply();
        
        this.socket.emit('discord-drop-all', { botName });
        
        await interaction.editReply(`🗑️ Dropping **all items** from bot **${botName}**`);
    }

    async handleCapture(interaction) {
        const botName = interaction.options.getString('bot');
        
        await interaction.deferReply();
        
        this.socket.emit('discord-request-capture', { botName, requestId: interaction.id });
        
        // Store the interaction for later response
        this.tempCaptures.set(interaction.id, interaction);
        
        const timeout = setTimeout(async () => {
            this.tempCaptures.delete(interaction.id);
            await interaction.editReply('❌ Timeout getting capture. Bot may not have 3D viewer enabled.');
        }, 10000);

        this.socket.once('discord-capture-response', async (data) => {
            if (data.requestId !== interaction.id) return;
            
            clearTimeout(timeout);
            this.tempCaptures.delete(interaction.id);
            
            if (!data.success) {
                await interaction.editReply(`❌ ${data.error || 'Failed to capture'}`);
                return;
            }

            const embed = new EmbedBuilder()
                .setTitle(`📸 ${data.botName} - Live View`)
                .setDescription(`🌐 [Click to open 3D Viewer](http://localhost:${data.port})\n\nOr use the button below:`)
                .setColor(0xff6600)
                .setImage(`http://localhost:${data.port}/screenshot?t=${Date.now()}`)
                .setTimestamp();

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setLabel('Open 3D Viewer')
                        .setURL(`http://localhost:${data.port}`)
                        .setStyle(ButtonStyle.Link)
                );

            await interaction.editReply({ embeds: [embed], components: [row] });
        });
    }

    async handleChat(interaction) {
        const message = interaction.options.getString('message');
        
        await interaction.deferReply();
        
        this.socket.emit('discord-chat-all', { message });
        
        await interaction.editReply(`💬 Message sent to all bots: "${message}"`);
    }

    async handleCommandCmd(interaction) {
        const cmd = interaction.options.getString('cmd');
        const botName = interaction.options.getString('bot');
        
        await interaction.deferReply();
        
        this.socket.emit('discord-command-all', { command: cmd, botName });
        
        if (botName) {
            await interaction.editReply(`⚡ Command \`${cmd}\` sent to bot **${botName}**`);
        } else {
            await interaction.editReply(`⚡ Command sent to all bots: \`${cmd}\``);
        }
    }

    async handleKillAll(interaction) {
        await interaction.deferReply();
        
        const confirmRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('confirm_killall')
                    .setLabel('Yes, Stop All')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId('cancel_killall')
                    .setLabel('Cancel')
                    .setStyle(ButtonStyle.Secondary)
            );

        await interaction.editReply({
            content: '⚠️ Are you sure you want to **STOP ALL BOTS**?',
            components: [confirmRow]
        });

        // Handle button interaction
        const filter = i => i.customId === 'confirm_killall' || i.customId === 'cancel_killall';
        const collector = interaction.channel.createMessageComponentCollector({ filter, time: 15000 });

        collector.on('collect', async i => {
            if (i.customId === 'confirm_killall') {
                this.socket.emit('discord-kill-all');
                await i.update({ content: '☠️ All bots have been stopped.', components: [] });
            } else {
                await i.update({ content: '✅ Cancelled.', components: [] });
            }
        });
    }

    async handleServerSwitch(interaction) {
        const server = interaction.options.getString('server');
        const port = interaction.options.getString('port') || '25565';
        const version = interaction.options.getString('version');
        const botName = interaction.options.getString('bot');
        
        await interaction.deferReply();
        
        this.socket.emit('discord-server-switch', { server, port, version, botName });
        
        let reply = `🌐 Sending ${botName || 'all bots'} to server: **${server}**`;
        if (port !== '25565') reply += `\nPort: ${port}`;
        if (version) reply += `\nVersion: ${version}`;
        
        await interaction.editReply(reply);
    }

    stop() {
        if (this.client) {
            this.client.destroy();
            this.isConnected = false;
            console.log('[DiscordBot] Disconnected.');
        }
    }
}

module.exports = DiscordBotManager;
