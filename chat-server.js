const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');
const EventEmitter = require('events');
const https = require('https');

class ChatServer extends EventEmitter {
    constructor(options = {}) {
        super();
        this.port = options.port || process.env.PORT || 8080;
        this.maxClients = options.maxClients || 1000;
        this.rateLimit = options.rateLimit || { messages: 20, window: 60000 }; // 20 messages per minute
        this.maxMessageLength = options.maxMessageLength || 1000;
        this.heartbeatInterval = options.heartbeatInterval || 60000;
        this.cleanupInterval = options.cleanupInterval || 60000;
        
        this.clients = new Map();
        this.messageHistory = [];
        this.maxHistorySize = 100;
        this.bannedIPs = new Set();
        this.connectionsPerIP = new Map();
        this.maxPerIP = 2;
        
        this.server = null;
        this.wss = null;
        
        this.stats = {
            totalConnections: 0,
            currentConnections: 0,
            totalMessages: 0,
            startTime: Date.now()
        };
        
        // Profanity filter
        this.profanityWords = new Set();
        this.profanityFilterLoaded = false;
        
        this.initServer();
        this.startCleanupTask();
        this.loadProfanityFilter();
    }
        
    initServer() {
        this.server = http.createServer((req, res) => {
            const url = new URL(req.url, `http://${req.headers.host}`);
            
            if (url.pathname === '/stats') {
                this.handleStatsRequest(res);
            } else if (url.pathname === '/health') {
                this.handleHealthCheck(res);
            } else {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(`
                    <html>
                        <head><title>Aquarius Chat Server</title></head>
                        <body>
                            <h1>Aquarius Chat Server</h1>
                            <p>WebSocket endpoint: ws://${req.headers.host}/chat</p>
                            <p>Connected clients: ${this.stats.currentConnections}</p>
                            <p>Total messages: ${this.stats.totalMessages}</p>
                            <p>Uptime: ${Math.floor((Date.now() - this.stats.startTime) / 1000)}s</p>
                        </body>
                    </html>
                `);
            }
        });
        
        this.wss = new WebSocket.Server({
            server: this.server,
            path: '/chat',
            perMessageDeflate: true,
            maxPayload: 16 * 1024, // 16KB max message size
            clientTracking: false // We'll handle tracking ourselves
        });
        
        this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
        this.server.on('error', (error) => this.handleServerError(error));
    }
    
    handleConnection(ws, req) {
        const clientIP = this.getClientIP(req);
        
        if (this.bannedIPs.has(clientIP)) {
            console.log(`Rejected connection from banned IP: ${clientIP}`);
            ws.close(1008, 'IP banned');
            return;
        }
        
        let ipConnections = this.connectionsPerIP.get(clientIP) || 0;
        if (ipConnections >= this.maxPerIP) {
            console.log(`Rejected connection: too many from IP ${clientIP}`);
            ws.close(1008, 'Too many connections from your IP');
            return;
        }
        
        if (this.clients.size >= this.maxClients) {
            console.log(`Rejected connection: server full (${this.clients.size}/${this.maxClients})`);
            ws.close(1013, 'Server full');
            return;
        }
        
        const clientId = this.generateClientId();
        const client = {
            id: clientId,
            ws: ws,
            ip: clientIP,
            connectedAt: Date.now(),
            lastActivity: Date.now(),
            messageCount: 0,
            rateLimitReset: Date.now() + this.rateLimit.window,
            username: null,
            isAlive: true
        };
        
        this.clients.set(clientId, client);
        this.connectionsPerIP.set(clientIP, (this.connectionsPerIP.get(clientIP) || 0) + 1);
        this.stats.totalConnections++;
        this.stats.currentConnections++;
        
        console.log(`Client connected: ${clientId} from ${clientIP} (${this.stats.currentConnections} total)`);
        
        ws.on('message', (data) => this.handleMessage(client, data));
        ws.on('close', (code, reason) => this.handleDisconnection(client, code, reason));
        ws.on('error', (error) => this.handleClientError(client, error));
        ws.on('pong', () => this.handlePong(client));
        
        this.sendToClient(client, {
            type: 'system',
            message: 'Welcome to Aquarius Chat!',
            timestamp: Date.now(),
            clientId: clientId
        });
        
        this.sendRecentHistory(client);
        this.emit('clientConnected', client);
    }
    
    handleMessage(client, data) {
        try {
            client.lastActivity = Date.now();
            
            if (!this.checkRateLimit(client)) {
                this.sendToClient(client, {
                    type: 'error',
                    message: 'Rate limit exceeded. Please slow down.',
                    timestamp: Date.now()
                });
                return;
            }
            
            let message;
            try {
                message = JSON.parse(data.toString());
            } catch (parseError) {
                this.sendToClient(client, {
                    type: 'error',
                    message: 'Invalid JSON format',
                    timestamp: Date.now()
                });
                return;
            }
            
            if (!this.validateMessage(message)) {
                this.sendToClient(client, {
                    type: 'error',
                    message: 'Invalid message format',
                    timestamp: Date.now()
                });
                return;
            }
            
            this.processMessage(client, message);
            
        } catch (error) {
            console.error(`Error handling message from ${client.id}:`, error);
            this.sendToClient(client, {
                type: 'error',
                message: 'Server error processing message',
                timestamp: Date.now()
            });
        }
    }
    
    processMessage(client, message) {
        switch (message.type) {
            case 'chat':
                this.handleChatMessage(client, message);
                break;
            case 'ping':
                this.handlePingMessage(client, message);
                break;
            case 'setUsername':
                this.handleSetUsername(client, message);
                break;
            default:
                this.sendToClient(client, {
                    type: 'error',
                    message: `Unknown message type: ${message.type}`,
                    timestamp: Date.now()
                });
        }
    }
    
    handleChatMessage(client, message) {
        if (!message.sender || !message.message) {
            this.sendToClient(client, {
                type: 'error',
                message: 'Chat message must have sender and message fields',
                timestamp: Date.now()
            });
            return;
        }
        
        if (message.message.length > this.maxMessageLength) {
            this.sendToClient(client, {
                type: 'error',
                message: `Message too long (max ${this.maxMessageLength} characters)`,
                timestamp: Date.now()
            });
            return;
        }
        
        const sanitizedMessage = this.sanitizeMessage(message.message);
        if (!sanitizedMessage) {
            this.sendToClient(client, {
                type: 'error',
                message: 'Message contains prohibited content',
                timestamp: Date.now()
            });
            return;
        }
        
        // Check if username is already taken by another client
        if (!client.username || client.username !== message.sender) {
            if (this.isUsernameTaken(message.sender, client.id)) {
                this.sendToClient(client, {
                    type: 'error',
                    message: `Username '${message.sender}' is already taken. Please choose a different username.`,
                    timestamp: Date.now()
                });
                return;
            }
        }
        
        client.username = message.sender;
        client.messageCount++;
        this.stats.totalMessages++;
        
        const chatMessage = {
            type: 'chat',
            sender: message.sender,
            message: sanitizedMessage,
            timestamp: message.timestamp || Date.now(),
            messageId: this.generateMessageId()
        };
        
        this.addToHistory(chatMessage);
        this.broadcast(chatMessage);
        
        console.log(`Chat message from ${client.username} (${client.id}): ${sanitizedMessage}`);
        this.emit('chatMessage', client, chatMessage);
    }
    
    handlePingMessage(client, message) {
        this.sendToClient(client, {
            type: 'pong',
            timestamp: Date.now(),
            serverTime: Date.now()
        });
    }
    
    handleSetUsername(client, message) {
        if (message.username && typeof message.username === 'string') {
            const oldUsername = client.username;
            client.username = message.username.substring(0, 50); // Limit username length
            
            this.sendToClient(client, {
                type: 'usernameSet',
                username: client.username,
                timestamp: Date.now()
            });
            
            if (oldUsername !== client.username) {
                console.log(`Client ${client.id} changed username from ${oldUsername} to ${client.username}`);
            }
        }
    }
    
    handleDisconnection(client, code, reason) {
        this.clients.delete(client.id);
        this.stats.currentConnections--;
        
        let ipConnections = this.connectionsPerIP.get(client.ip) || 0;
        if (ipConnections > 0) {
            this.connectionsPerIP.set(client.ip, ipConnections - 1);
            if (ipConnections - 1 === 0) {
                this.connectionsPerIP.delete(client.ip);
            }
        }
        
        console.log(`Client disconnected: ${client.id} (${client.username || 'unknown'}) - Code: ${code}, Reason: ${reason}`);
        
        this.emit('clientDisconnected', client, code, reason);
    }
    
    handleClientError(client, error) {
        console.error(`Client error for ${client.id}:`, error.message);
        this.emit('clientError', client, error);
    }
    
    handleServerError(error) {
        console.error('Server error:', error);
        this.emit('serverError', error);
    }
    
    handlePong(client) {
        client.isAlive = true;
        client.lastActivity = Date.now();
    }
    
    checkRateLimit(client) {
        const now = Date.now();
        
        if (now > client.rateLimitReset) {
            client.messageCount = 0;
            client.rateLimitReset = now + this.rateLimit.window;
        }
        
        return client.messageCount < this.rateLimit.messages;
    }
    
    validateMessage(message) {
        return (
            typeof message === 'object' &&
            message !== null &&
            typeof message.type === 'string' &&
            message.type.length > 0 &&
            message.type.length <= 50
        );
    }
    
    sanitizeMessage(message) {
        if (typeof message !== 'string') return null;
        
        const trimmed = message.trim();
        if (trimmed.length === 0) return null;
        
        let basicSanitized = trimmed
            .replace(/[\x00-\x1F\x7F]/g, '') // Remove control characters
            .replace(/\s+/g, ' '); // Normalize whitespace
        
        // Censor profanity
        basicSanitized = this.censorProfanity(basicSanitized);
        
        return basicSanitized.length > 0 ? basicSanitized : null;
    }
    
    sendToClient(client, message) {
        if (client.ws.readyState === WebSocket.OPEN) {
            try {
                client.ws.send(JSON.stringify(message));
                return true;
            } catch (error) {
                console.error(`Error sending to client ${client.id}:`, error.message);
                return false;
            }
        }
        return false;
    }
    
    broadcast(message) {
        let sentCount = 0;
        let failedCount = 0;
        
        for (const [clientId, client] of this.clients) {
            if (this.sendToClient(client, message)) {
                sentCount++;
            } else {
                failedCount++;
            }
        }
        
        if (failedCount > 0) {
            console.log(`Broadcast: sent to ${sentCount} clients, failed to send to ${failedCount} clients`);
        }
        
        return { sent: sentCount, failed: failedCount };
    }
    
    addToHistory(message) {
        this.messageHistory.push(message);
        if (this.messageHistory.length > this.maxHistorySize) {
            this.messageHistory.shift();
        }
    }
    
    sendRecentHistory(client) {
        if (this.messageHistory.length > 0) {
            this.sendToClient(client, {
                type: 'messageHistory',
                messages: this.messageHistory.slice(-10), // Send last 10 messages
                timestamp: Date.now()
            });
        }
    }
    
    startCleanupTask() {
        setInterval(() => {
            this.performCleanup();
        }, this.cleanupInterval);
        
        setInterval(() => {
            this.performHeartbeat();
        }, this.heartbeatInterval);
    }
    
    performCleanup() {
        const now = Date.now();
        const staleThreshold = 5 * 60 * 1000; // 5 minutes
        let removedCount = 0;
        
        for (const [clientId, client] of this.clients) {
            if (now - client.lastActivity > staleThreshold || client.ws.readyState !== WebSocket.OPEN) {
                console.log(`Removing stale client: ${clientId}`);
                this.clients.delete(clientId);
                this.stats.currentConnections--;
                removedCount++;
                
                if (client.ws.readyState === WebSocket.OPEN) {
                    client.ws.terminate();
                }
            }
        }
        
        if (removedCount > 0) {
            console.log(`Cleanup: removed ${removedCount} stale clients`);
        }
    }
    
    performHeartbeat() {
        let terminatedCount = 0;
        
        for (const [clientId, client] of this.clients) {
            if (!client.isAlive) {
                console.log(`Terminating unresponsive client: ${clientId}`);
                client.ws.terminate();
                this.clients.delete(clientId);
                this.stats.currentConnections--;
                terminatedCount++;
            } else {
                client.isAlive = false;
                if (client.ws.readyState === WebSocket.OPEN) {
                    client.ws.ping();
                }
            }
        }
        
        if (terminatedCount > 0) {
            console.log(`Heartbeat: terminated ${terminatedCount} unresponsive clients`);
        }
    }
    
    getClientIP(req) {
        return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
               req.headers['x-real-ip'] ||
               req.connection?.remoteAddress ||
               req.socket?.remoteAddress ||
               'unknown';
    }
    
    generateClientId() {
        return crypto.randomBytes(16).toString('hex');
    }
    
    generateMessageId() {
        return crypto.randomBytes(8).toString('hex');
    }
    
    isUsernameTaken(username, excludeClientId = null) {
        for (const [clientId, client] of this.clients) {
            if (clientId !== excludeClientId && client.username === username) {
                return true;
            }
        }
        return false;
    }
    
    handleStatsRequest(res) {
        const stats = {
            ...this.stats,
            uptime: Date.now() - this.stats.startTime,
            memoryUsage: process.memoryUsage(),
            connectedClients: Array.from(this.clients.values()).map(client => ({
                id: client.id,
                username: client.username,
                connectedAt: client.connectedAt,
                messageCount: client.messageCount,
                lastActivity: client.lastActivity
            }))
        };
        
        res.writeHead(200, { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify(stats, null, 2));
    }
    
    handleHealthCheck(res) {
        const health = {
            status: 'healthy',
            timestamp: Date.now(),
            uptime: Date.now() - this.stats.startTime,
            connections: this.stats.currentConnections,
            memoryUsage: process.memoryUsage()
        };
        
        res.writeHead(200, { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify(health));
    }
    
    banIP(ip) {
        this.bannedIPs.add(ip);
        console.log(`Banned IP: ${ip}`);
        
        for (const [clientId, client] of this.clients) {
            if (client.ip === ip) {
                client.ws.close(1008, 'IP banned');
            }
        }
    }
    
    unbanIP(ip) {
        this.bannedIPs.delete(ip);
        console.log(`Unbanned IP: ${ip}`);
    }
    
    start() {
        return new Promise((resolve, reject) => {
            this.server.listen(this.port, (error) => {
                if (error) {
                    reject(error);
                } else {
                    console.log(`Aquarius Chat Server running on port ${this.port}`);
                    console.log(`Max clients: ${this.maxClients}`);
                    console.log(`Rate limit: ${this.rateLimit.messages} messages per ${this.rateLimit.window/1000}s`);
                    resolve();
                }
            });
        });
    }
    
    stop() {
        return new Promise((resolve) => {
            console.log('Shutting down server...');
            
            for (const client of this.clients.values()) {
                client.ws.close(1001, 'Server shutting down');
            }
            
            this.server.close(() => {
                console.log('Server stopped');
                resolve();
            });
        });
    }
    
    loadProfanityFilter() {
        const url = 'https://raw.githubusercontent.com/thisandagain/washyourmouthoutwithsoap/refs/heads/develop/data/build.json';
        
        console.log('Loading profanity filter from URL...');
        
        https.get(url, (res) => {
            let data = '';
            
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                try {
                    const filterData = JSON.parse(data);
                    
                    // Load all words from all languages into the set
                    for (const [lang, words] of Object.entries(filterData)) {
                        for (const word of words) {
                            this.profanityWords.add(word.toLowerCase());
                        }
                    }
                    
                    this.profanityFilterLoaded = true;
                    console.log(`Profanity filter loaded: ${this.profanityWords.size} words`);
                } catch (error) {
                    console.error('Error parsing profanity filter:', error);
                }
            });
        }).on('error', (error) => {
            console.error('Error fetching profanity filter:', error);
        });
    }
    
    censorProfanity(message) {
        if (!this.profanityFilterLoaded || this.profanityWords.size === 0) {
            return message; // Don't modify if filter isn't loaded
        }
        
        let censored = message;
        
        // Sort profanity words by length (longest first) to handle compound words
        const sortedProfanity = Array.from(this.profanityWords).sort((a, b) => b.length - a.length);
        
        for (const badWord of sortedProfanity) {
            // Create a regex that matches the word with word boundaries
            const regex = new RegExp(`\\b${badWord}\\b`, 'gi');
            censored = censored.replace(regex, '*'.repeat(badWord.length));
            
            // Also check for the word without word boundaries (for compound words)
            const regexNoWordBoundary = new RegExp(badWord, 'gi');
            censored = censored.replace(regexNoWordBoundary, '*'.repeat(badWord.length));
        }
        
        return censored;
    }

    loadProfanityFilter() {
        const url = 'https://raw.githubusercontent.com/thisandagain/washyourmouthoutwithsoap/refs/heads/develop/data/build.json';
        
        console.log('Loading profanity filter from URL...');
        
        https.get(url, (res) => {
            let data = '';
            
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                try {
                    const filterData = JSON.parse(data);
                    
                    // Load all words from all languages into the set
                    for (const [lang, words] of Object.entries(filterData)) {
                        for (const word of words) {
                            this.profanityWords.add(word.toLowerCase());
                        }
                    }
                    
                    this.profanityFilterLoaded = true;
                    console.log(`Profanity filter loaded: ${this.profanityWords.size} words`);
                } catch (error) {
                    console.error('Error parsing profanity filter:', error);
                }
            });
        }).on('error', (error) => {
            console.error('Error fetching profanity filter:', error);
        });
    }
    
    containsProfanity(message) {
        if (!this.profanityFilterLoaded || this.profanityWords.size === 0) {
            return false; // Don't block if filter isn't loaded
        }
        
        const lowerMessage = message.toLowerCase();
        
        // Check each word in the message
        const words = lowerMessage.split(/\s+/);
        for (const word of words) {
            // Remove common punctuation from word boundaries
            const cleanWord = word.replace(/[^a-z0-9]/gi, '');
            if (this.profanityWords.has(cleanWord)) {
                return true;
            }
        }
        
        // Also check for words without spaces (concatenated)
        for (const badWord of this.profanityWords) {
            if (lowerMessage.includes(badWord)) {
                return true;
            }
        }
        
        return false;
    }
}

const server = new ChatServer({
    maxClients: 1000,
    rateLimit: { messages: 5, window: 5000 }, // 5 messages per 5 seconds
    maxMessageLength: 500,
    heartbeatInterval: 30000,
    cleanupInterval: 60000
});

server.on('clientConnected', (client) => {
    console.log(`Client connected: ${client.id} from ${client.ip}`);
});

server.on('clientDisconnected', (client) => {
    console.log(`Client disconnected: ${client.username || client.id}`);
});

process.on('SIGINT', async () => {
    console.log('\nReceived SIGINT, shutting down gracefully...');
    await server.stop();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\nReceived SIGTERM, shutting down gracefully...');
    await server.stop();
    process.exit(0);
});

server.start().catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
});
