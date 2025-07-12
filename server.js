const WebSocket = require('ws');
const http = require('http');
const url = require('url');

// Create an HTTP server
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Aquarius Chat Server\n');
});

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Store connected clients
const clients = new Set();

// Broadcast function
function broadcast(message) {
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
        }
    });
}

// Handle new connections
wss.on('connection', (ws, req) => {
    console.log('New client connected:', req.socket.remoteAddress);
    clients.add(ws);

    // Send welcome message
    ws.send(JSON.stringify({ type: 'system', message: 'Welcome to Aquarius Chat!' }));

    // Handle incoming messages
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            if (msg.type === 'chat' && msg.sender && msg.message) {
                console.log(`Message from ${msg.sender}: ${msg.message}`);
                broadcast({ type: 'chat', sender: msg.sender, message: msg.message, timestamp: Date.now() });
            }
        } catch (error) {
            console.error('Invalid message:', error);
        }
    });

    // Handle disconnections
    ws.on('close', () => {
        console.log('Client disconnected');
        clients.delete(ws);
    });

    // Handle errors
    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

// Heartbeat to keep connections alive (ping every 30s)
setInterval(() => {
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.ping();
        }
    });
}, 30000);

// Start the server
const PORT = process.env.PORT || 8080;  // Use env var for hosting platforms
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
