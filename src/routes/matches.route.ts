import express from 'express';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { createMatchSchema, listMatchesQuerySchema } from '../validation/matches.js';
import { db } from '../db/db.js';
import { matches } from '../db/schema.js';
import { desc } from 'drizzle-orm';

const router = express.Router();
type CreateMatchInput = z.infer<typeof createMatchSchema>;
type ListMatchesQueryInput = z.infer<typeof listMatchesQuerySchema>;

const MAX_LIMIT = 100;

// Sample route for matches
router.get('/', async (req: Request<object, object, object, ListMatchesQueryInput>, res: Response) => {
  const parsed = listMatchesQuerySchema.safeParse(req.query);

  if (!parsed.success) {
    return res.status(400).json({ errors: parsed.error.issues });
  }

  const limit = Math.min(parsed.data.limit ?? 50, MAX_LIMIT);

  try {
    const data = await db
        .select()
        .from(matches)
        .orderBy(desc(matches.createdAt)) 
        .limit(limit);

    return res.json({ matches: data });
    
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch matches', details: JSON.stringify(error) });
  }
});


router.post('/', async (req: Request<object, object, CreateMatchInput>, res: Response) => {
    const parsed = createMatchSchema.safeParse(req.body);

    if (!parsed.success) {
        return res.status(400).json({ errors: parsed.error.issues });
    }

    const { data: { startTime, endTime, homeScore, awayScore } } = parsed;

    try {
        const [ event ] = await db.insert(matches).values({
            ...parsed.data,
            startTime: new Date(startTime),
            endTime: new Date(endTime),
            homeScore: homeScore ?? 0,
            awayScore: awayScore ?? 0,
        }).returning();

        return res.status(201).json({ message: 'Match created successfully', match: event });
    } catch (error) {
        return res.status(500).json({ error: 'Failed to create match', details: JSON.stringify(error) });
    }
});

export default router;