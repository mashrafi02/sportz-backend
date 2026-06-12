import { WebSocket, WebSocketServer } from 'ws';
import type { Server as HTTPServer, IncomingMessage } from 'http';
import type { Socket } from 'net';
import { wsArcjet } from '../arcjet.js';

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

function rejectUpgrade(socket: Socket, status: number, message: string): void {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
}

export function attachWebSocketServer(server: HTTPServer): WebSocketServerResult {

    const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

    server.on('upgrade', async (req: IncomingMessage, socket: Socket, head: Buffer) => {

        if (req.url !== '/ws') {
            socket.destroy();
            return;
        }

        if (wsArcjet) {
            try {
                const descision = await wsArcjet.protect(req);

                if (descision.isDenied()) {
                    if (descision.reason.isRateLimit()) {
                        rejectUpgrade(socket, 429, "Too Many Requests");
                    } else {
                        rejectUpgrade(socket, 403, "Forbidden");
                    }
                    return;
                }
            } catch (error) {
                console.error("WS upgrade error", error);
                rejectUpgrade(socket, 500, "Internal Server Error");
                return;
            }
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
        });
    });

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