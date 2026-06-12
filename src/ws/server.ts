import { WebSocket, WebSocketServer } from 'ws';
import type { Server as HTTPServer } from 'http';

function sendJson(socket: WebSocket, payload: Record<string, unknown>): void {

    if (socket.readyState !== WebSocket.OPEN) return;
    
    socket.send(JSON.stringify(payload));
}

function broadcastJson(wss: WebSocketServer, payload: Record<string, unknown>): void {

    for (const client of wss.clients) {

        if (client.readyState !== WebSocket.OPEN) return;

        client.send(JSON.stringify(payload));
    }
}

interface WebSocketServerResult {
    broadcastMatchCreated: (match: unknown) => void;
}

export function attachWebSocketServer(server: HTTPServer): WebSocketServerResult {

    const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 * 1024 });

    wss.on('connection', (socket: WebSocket) => {
        sendJson(socket, { type: 'welcome', message: 'Welcome to the WebSocket server!' });
    })

    wss.on('error', (error: Error) => {
        console.error('WebSocket error:', error);
    });

    function broadcastMatchCreated(match: unknown): void {
        broadcastJson(wss, { type: 'match_created', data: match });
    }

    return { broadcastMatchCreated };
}