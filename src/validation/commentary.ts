import { z } from 'zod';

export const listCommentaryQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
});

export const createCommentarySchema = z.object({
  minute: z.coerce.number().int().nonnegative().optional(),
  sequence: z.coerce.number().int().nonnegative().optional(),
  period: z.string().trim().min(1).optional(),
  eventType: z.string().trim().min(1).optional(),
  actor: z.string().trim().min(1).optional(),
  team: z.string().trim().min(1).optional(),
  message: z.string().trim().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
});

export type ListCommentaryQueryInput = z.infer<typeof listCommentaryQuerySchema>;
export type CreateCommentaryInput = z.infer<typeof createCommentarySchema>;
