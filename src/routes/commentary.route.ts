import express from "express";
import type { Request, Response } from "express";
import type { z } from "zod";
import { matchIdParamSchema } from "../validation/matches.js";
import { createCommentarySchema, listCommentaryQuerySchema } from "../validation/commentary.js";
import { db } from "../db/db.js";
import { commentary } from "../db/schema.js";
import { desc, eq } from "drizzle-orm";

const commentaryRouter = express.Router({ mergeParams: true });

const MAX_LIMIT = 100;

type MatchIdParamInput = z.infer<typeof matchIdParamSchema>;
type CreateCommentaryInput = z.infer<typeof createCommentarySchema>;
type ListCommentaryQueryInput = z.infer<typeof listCommentaryQuerySchema>;

commentaryRouter.get('/', async (req: Request<MatchIdParamInput, object, object, ListCommentaryQueryInput>, res: Response) => {
    const parsedParams = matchIdParamSchema.safeParse(req.params);

    if (!parsedParams.success) {
        return res.status(400).json({ errors: parsedParams.error.issues });
    }

    const parsedQuery = listCommentaryQuerySchema.safeParse(req.query);

    if (!parsedQuery.success) {
        return res.status(400).json({ errors: parsedQuery.error.issues });
    }

    const limit = Math.min(parsedQuery.data.limit ?? MAX_LIMIT, MAX_LIMIT);

    try {
        const data = await db
            .select()
            .from(commentary)
            .where(eq(commentary.matchId, parsedParams.data.id))
            .orderBy(desc(commentary.createdAt))
            .limit(limit);

        return res.json({ commentary: data });
    } catch (error) {
        console.error('Failed to fetch commentary:', error);
        return res.status(500).json({ error: 'Failed to fetch commentary' });
    }
});

commentaryRouter.post('/', async (req: Request<MatchIdParamInput, object, CreateCommentaryInput>, res: Response) => {
    const parsedParams = matchIdParamSchema.safeParse(req.params);

    if (!parsedParams.success) {
        return res.status(400).json({ errors: parsedParams.error.issues });
    }

    const parsedBody = createCommentarySchema.safeParse(req.body);

    if (!parsedBody.success) {
        return res.status(400).json({ errors: parsedBody.error.issues });
    }

    try {
        const [entry] = await db.insert(commentary).values({
            ...parsedBody.data,
            matchId: parsedParams.data.id,
        }).returning();

        if (res.app.locals.broadcastCommentary) {
            res.app.locals.broadcastCommentary(entry?.matchId, entry);
        }

        return res.status(201).json({ message: 'Commentary created successfully', commentary: entry });
    } catch (error) {
        console.error('Failed to create commentary:', error);
        return res.status(500).json({ error: 'Failed to create commentary' });
    }
});

export default commentaryRouter;