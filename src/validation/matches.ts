import { z } from 'zod';

const isoDateTimeSchema = z.iso.datetime({ offset: true });

export const listMatchesQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
});

export const MATCH_STATUS = {
  SCHEDULED: 'scheduled',
  LIVE: 'live',
  FINISHED: 'finished',
} as const;

export type MatchStatusValue = (typeof MATCH_STATUS)[keyof typeof MATCH_STATUS];

/** Derives a match's status from its start/end times relative to now. */
export function computeMatchStatus(startTime: Date, endTime: Date | null, now: Date = new Date()): MatchStatusValue {
  if (endTime && now >= endTime) {
    return MATCH_STATUS.FINISHED;
  }
  if (now >= startTime) {
    return MATCH_STATUS.LIVE;
  }
  return MATCH_STATUS.SCHEDULED;
}

export const matchIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const scoreSchema = z.string().trim().min(1).max(20);

export const createMatchSchema = z
  .object({
    sport: z.string().trim().min(1),
    homeTeam: z.string().trim().min(1),
    awayTeam: z.string().trim().min(1),
    startTime: z
      .string()
      .refine((value) => isoDateTimeSchema.safeParse(value).success, {
        message: 'startTime must be a valid ISO date string',
      }),
    endTime: z
      .string()
      .refine((value) => isoDateTimeSchema.safeParse(value).success, {
        message: 'endTime must be a valid ISO date string',
      }),
    homeScore: scoreSchema.optional(),
    awayScore: scoreSchema.optional(),
  })
  .superRefine(({ startTime, endTime }, ctx) => {
    const start = new Date(startTime).getTime();
    const end = new Date(endTime).getTime();

    if (end <= start) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'endTime must be after startTime',
        path: ['endTime'],
      });
    }
  });

export const updateMatchSchema = z
  .object({
    homeScore: scoreSchema.optional(),
    awayScore: scoreSchema.optional(),
    status: z.enum([MATCH_STATUS.SCHEDULED, MATCH_STATUS.LIVE, MATCH_STATUS.FINISHED]).optional(),
  })
  .refine(
    (data) => data.homeScore !== undefined || data.awayScore !== undefined || data.status !== undefined,
    {
      message: 'At least one of homeScore, awayScore or status must be provided',
    },
  );
