import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import matchesRouter from './routes/matches.route.js';
import commentaryRouter from './routes/commentary.route.js';
import http from 'http';
import { attachWebSocketServer } from './ws/server.js';
import { securityMiddleware } from './arcjet.js';


const PORT = parseInt(process.env.PORT || '8000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:3000';


const app = express();
const server = http.createServer(app);

// Middleware to parse JSON
app.use(express.json());

// Allow the frontend's origin to call this API from the browser
app.use((req: Request, res: Response, next: NextFunction) => {
  res.header('Access-Control-Allow-Origin', FRONTEND_ORIGIN);
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(securityMiddleware());

// Root route
app.get('/', (req: Request, res: Response) => {
  res.send('Welcome to the Sportz API!');
});

app.use('/matches', matchesRouter);
app.use('/matches/:id/commentary', commentaryRouter);


// Attach WebSocket server
const { broadcastMatchCreated, broadcastCommentary, broadcastMatchUpdated } = attachWebSocketServer(server);
app.locals.broadcastMatchCreated = broadcastMatchCreated;
app.locals.broadcastCommentary = broadcastCommentary;
app.locals.broadcastMatchUpdated = broadcastMatchUpdated;


server.listen(PORT, HOST, () => {

  const baseUrl = HOST === '0.0.0.0' ? `http://localhost:${PORT}` : `http://${HOST}:${PORT}`;

  console.log(`Server is running at ${baseUrl}`);

  console.log(`WebSocket server is available at ${baseUrl.replace('http', 'ws')}/ws`);
});
