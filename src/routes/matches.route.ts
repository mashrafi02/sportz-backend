import express from 'express';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import {
  computeMatchStatus,
  createMatchSchema,
  listMatchesQuerySchema,
  matchIdParamSchema,
  updateMatchSchema,
} from '../validation/matches.js';
import { db } from '../db/db.js';
import { matches } from '../db/schema.js';
import { desc, eq } from 'drizzle-orm';

const router = express.Router();
type CreateMatchInput = z.infer<typeof createMatchSchema>;
type ListMatchesQueryInput = z.infer<typeof listMatchesQuerySchema>;
type MatchIdParamInput = z.infer<typeof matchIdParamSchema>;
type UpdateMatchInput = z.infer<typeof updateMatchSchema>;

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
    console.error('Failed to fetch matches:', error);
    return res.status(500).json({ error: 'Failed to fetch matches' });
  }
});


router.post('/', async (req: Request<object, object, CreateMatchInput>, res: Response) => {
    const parsed = createMatchSchema.safeParse(req.body);

    if (!parsed.success) {
        return res.status(400).json({ errors: parsed.error.issues });
    }

    const { data: { startTime, endTime, homeScore, awayScore } } = parsed;

    try {
        const start = new Date(startTime);
        const end = new Date(endTime);

        const [ event ] = await db.insert(matches).values({
            ...parsed.data,
            status: computeMatchStatus(start, end),
            startTime: start,
            endTime: end,
            homeScore: homeScore ?? '0',
            awayScore: awayScore ?? '0',
        }).returning();

        if(res.app.locals.broadcastMatchCreated) {
            res.app.locals.broadcastMatchCreated(event);
        }

        return res.status(201).json({ message: 'Match created successfully', match: event });
    } catch (error) {
        console.error('Failed to create match:', error);
        return res.status(500).json({ error: 'Failed to create match' });
    }
});

router.patch('/:id', async (req: Request<MatchIdParamInput, object, UpdateMatchInput>, res: Response) => {
    const parsedParams = matchIdParamSchema.safeParse(req.params);

    if (!parsedParams.success) {
        return res.status(400).json({ errors: parsedParams.error.issues });
    }

    const parsedBody = updateMatchSchema.safeParse(req.body);

    if (!parsedBody.success) {
        return res.status(400).json({ errors: parsedBody.error.issues });
    }

    try {
        const [ updated ] = await db.update(matches)
            .set(parsedBody.data)
            .where(eq(matches.id, parsedParams.data.id))
            .returning();

        if (!updated) {
            return res.status(404).json({ error: 'Match not found' });
        }

        if (res.app.locals.broadcastMatchUpdated) {
            res.app.locals.broadcastMatchUpdated(updated);
        }

        return res.json({ message: 'Match updated successfully', match: updated });
    } catch (error) {
        console.error('Failed to update match:', error);
        return res.status(500).json({ error: 'Failed to update match' });
    }
});

export default router;