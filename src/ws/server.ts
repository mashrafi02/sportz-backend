import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import type { Server as HTTPServer, IncomingMessage } from 'http';
import type { Socket } from 'net';
import { wsArcjet } from '../arcjet.js';

type AliveWebSocket = WebSocket & {
    isAlive: boolean;
    subscriptions: Set<number>;
    messageCount: number;
    messageWindowStart: number;
};

interface WebSocketServerResult {
    broadcastMatchCreated: (match: unknown) => void;
    broadcastCommentary: (matchId: number, commentary: unknown) => void;
    broadcastMatchUpdated: (match: unknown) => void;
}

const matchSubscribers = new Map<number, Set<AliveWebSocket>>();

const WS_MESSAGE_RATE_LIMIT = 20;
const WS_MESSAGE_RATE_WINDOW_MS = 10_000;

// Tracks per-socket message rate, resetting the window once it elapses.
// Returns true once the socket has exceeded its allowance for the current window.
function isRateLimited(socket: AliveWebSocket): boolean {
    const now = Date.now();

    if (now - socket.messageWindowStart >= WS_MESSAGE_RATE_WINDOW_MS) {
        socket.messageWindowStart = now;
        socket.messageCount = 0;
    }

    socket.messageCount += 1;

    return socket.messageCount > WS_MESSAGE_RATE_LIMIT;
}

// Adds a socket to the set of subscribers for a match
function subscribe(matchId: number, socket: AliveWebSocket): void {

    if (!matchSubscribers.has(matchId)) {
        matchSubscribers.set(matchId, new Set());
    }

    matchSubscribers.get(matchId)?.add(socket);
}

// Removes a socket from a match's subscriber set, dropping the entry entirely once empty
function unsubscribe(matchId: number, socket: AliveWebSocket): void {

    const subscribers = matchSubscribers.get(matchId);

    if (!subscribers) return;

    subscribers.delete(socket);

    if (subscribers.size === 0) {
        matchSubscribers.delete(matchId);
    }

}

// Unsubscribes a socket from every match it was subscribed to, e.g. on disconnect
function cleanupSubscriptions(socket: AliveWebSocket): void {

    for (const matchId of socket.subscriptions) {
        unsubscribe(matchId, socket)
    }

}

// Rejects a WebSocket upgrade request with a raw HTTP response and closes the socket
function rejectUpgrade(socket: Socket, status: number, message: string): void {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
}

// Sends a JSON payload to a single socket if it's currently open
function sendJson(socket: WebSocket, payload: Record<string, unknown>): void {
    
    if (socket.readyState !== WebSocket.OPEN) return;
    
    socket.send(JSON.stringify(payload));
}

// Sends a JSON payload to every connected, open socket
function broadcastToAll(wss: WebSocketServer, payload: Record<string, unknown>): void {
    
    for (const client of wss.clients) {
        
        if (client.readyState !== WebSocket.OPEN) continue;
        
        client.send(JSON.stringify(payload));
    }
}

// Sends a JSON payload to every open socket subscribed to a given match
function broadcastToMatch(matchId: number, payload: Record<string, unknown>): void {

    const subscribers = matchSubscribers.get(matchId);

    if (!subscribers || subscribers.size === 0) return;

    const message = JSON.stringify(payload);

    for (const subscriber of subscribers) {
        if (subscriber.readyState === WebSocket.OPEN) {
            subscriber.send(message);
        }
    }
}

// Parses an incoming client message and handles subscribe/unsubscribe requests
function handleMessage(socket: AliveWebSocket, data: RawData): void {
    if (isRateLimited(socket)) {
        if (socket.messageCount === WS_MESSAGE_RATE_LIMIT + 1) {
            sendJson(socket, { type: 'error', message: 'Too many messages, slow down' });
        }
        return;
    }

    let message: { type?: unknown; matchId?: unknown };

    try {
        message = JSON.parse(data.toString());
    } catch (error) {
        sendJson(socket, { type: 'error', message: 'Invalid message format' });
        return;
    }

    const matchId = message?.matchId;

    if (typeof matchId !== "number" || !Number.isInteger(matchId)) return;

    if (message?.type === "subscribe") {
        subscribe(matchId, socket);
        socket.subscriptions.add(matchId);
        sendJson(socket, { type: 'subscribed', matchId });
    }

    if (message?.type === "unsubscribe") {
        unsubscribe(matchId, socket);
        socket.subscriptions.delete(matchId);
        sendJson(socket, { type: 'unsubscribed', matchId });
    }
}

// Sets up the WebSocket server: handles upgrades (with Arcjet protection), connections,
// keepalive pings, and returns broadcast helpers for the REST routes to use
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

        socket.subscriptions = new Set();
        socket.messageCount = 0;
        socket.messageWindowStart = Date.now();

        sendJson(socket, { type: 'welcome', message: 'Welcome to the WebSocket server!' });

        socket.on('message', (data) => handleMessage(socket, data));

        socket.on('close', () => {
            cleanupSubscriptions(socket);
        });

        socket.on('error', (error: Error) => {
            console.error('WebSocket error:', error);
            socket.terminate();
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

    // Notifies all connected clients that a new match was created
    function broadcastMatchCreated(match: unknown): void {
        broadcastToAll(wss, { type: 'match_created', data: match });
    }

    // Notifies clients subscribed to a match that new commentary was added
    function broadcastCommentary(matchId: number, commentary: unknown): void {
        broadcastToMatch(matchId, { type: 'commentary_update', data: commentary });
    }

    // Notifies all connected clients that a match was updated (e.g. score change)
    function broadcastMatchUpdated(match: unknown): void {
        broadcastToAll(wss, { type: 'match_updated', data: match });
    }

    return { broadcastMatchCreated, broadcastCommentary, broadcastMatchUpdated };
}