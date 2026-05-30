import express from 'express';
import type { Request, Response } from 'express';
import matchesRouter from './routes/matches.route.js';

const app = express();
const PORT = 8000;

// Middleware to parse JSON
app.use(express.json());

// Root route
app.get('/', (req: Request, res: Response) => {
  res.send('Welcome to the Sportz API!');
});

app.use('/matches', matchesRouter);

app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
