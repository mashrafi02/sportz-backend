import express from 'express';
import type { Request, Response } from 'express';
import matchesRouter from './routes/matches.route.js';
import http from 'http';
import { attachWebSocketServer } from './ws/server.js';
import { securityMiddleware } from './arcjet.js';


const PORT = parseInt(process.env.PORT || '8000', 10);
const HOST = process.env.HOST || '0.0.0.0';


const app = express();
const server = http.createServer(app);

// Middleware to parse JSON
app.use(express.json());

// Root route
app.get('/', (req: Request, res: Response) => {
  res.send('Welcome to the Sportz API!');
});

app.use(securityMiddleware());

app.use('/matches', matchesRouter);


// Attach WebSocket server
const { broadcastMatchCreated } = attachWebSocketServer(server);
app.locals.broadcastMatchCreated = broadcastMatchCreated;


server.listen(PORT, HOST, () => {

  const baseUrl = HOST === '0.0.0.0' ? `http://localhost:${PORT}` : `http://${HOST}:${PORT}`;

  console.log(`Server is running at ${baseUrl}`);

  console.log(`WebSocket server is available at ${baseUrl.replace('http', 'ws')}/ws`);
});
