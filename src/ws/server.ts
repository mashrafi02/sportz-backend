import { WebSocket, WebSocketServer } from 'ws';
import type { Server as HTTPServer } from 'http';

type AliveWebSocket = WebSocket & { isAlive: boolean };

function sendJson(socket: WebSocket, payload: Record<string, unknown>): void {

    if (socket.readyState !== WebSocket.OPEN) return;
    
    socket.send(JSON.stringify(payload));
}

function broadcastJson(wss: WebSocketServer, payload: Record<string, unknown>): void {

    for (const client of wss.clients) {

        if (client.readyState !== WebSocket.OPEN) continue;

        client.send(JSON.stringify(payload));
    }
}

interface WebSocketServerResult {
    broadcastMatchCreated: (match: unknown) => void;
}

export function attachWebSocketServer(server: HTTPServer): WebSocketServerResult {

    const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 * 1024 });

    wss.on('connection', (socket: AliveWebSocket) => {

        socket.isAlive = true;
        socket.on('pong', () => { socket.isAlive = true; });

        sendJson(socket, { type: 'welcome', message: 'Welcome to the WebSocket server!' });

        socket.on('error', (error: Error) => {
            console.error('WebSocket error:', error);
        });
    })

    const interval = setInterval(() => {
        wss.clients.forEach(ws => {
            const aliveSocket = ws as AliveWebSocket;

            if (aliveSocket.isAlive === false) return aliveSocket.terminate();
            aliveSocket.isAlive = false;
            aliveSocket.ping();  
        })
    }, 30000)

    wss.on('close', () => { clearInterval(interval); });

    function broadcastMatchCreated(match: unknown): void {
        broadcastJson(wss, { type: 'match_created', data: match });
    }

    return { broadcastMatchCreated };
}