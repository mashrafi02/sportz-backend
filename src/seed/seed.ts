import "dotenv/config";
import fs from "fs/promises";
import { sql } from "drizzle-orm";
import { db, pool } from "../db/db.js";

const DELAY_MS = Number.parseInt(process.env.DELAY_MS || "250", 10);
const NEW_MATCH_DELAY_MIN_MS = 2000;
const NEW_MATCH_DELAY_MAX_MS = 3000;
const DEFAULT_MATCH_DURATION_MINUTES = Number.parseInt(
  process.env.SEED_MATCH_DURATION_MINUTES || "120",
  10,
);
const FORCE_LIVE =
  process.env.SEED_FORCE_LIVE !== "0" &&
  process.env.SEED_FORCE_LIVE !== "false";
const API_URL = process.env.API_URL;
if (!API_URL) {
  throw new Error("API_URL is required to seed via REST endpoints.");
}

const DEFAULT_DATA_FILE = new URL("../data/data.json", import.meta.url);

interface CommentaryEntry {
  matchId?: number | undefined;
  minute?: number | undefined;
  sequence?: number | undefined;
  period?: string | undefined;
  eventType?: string | undefined;
  actor?: string | undefined;
  team?: string | undefined;
  message?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  tags?: string[] | undefined;
}

interface CommentaryRecord {
  id: number;
  matchId: number;
  minute: number | null;
  sequence: number | null;
  period: string | null;
  eventType: string | null;
  actor: string | null;
  team: string | null;
  message: string;
  metadata: Record<string, unknown> | null;
  tags: string[] | null;
  createdAt: string;
}

interface MatchRecord {
  id: number;
  sport: string;
  homeTeam: string;
  awayTeam: string;
  status?: string | undefined;
  startTime: string;
  endTime?: string | undefined;
  homeScore?: number | undefined;
  awayScore?: number | undefined;
  createdAt?: string | undefined;
}

interface SeedMatch {
  id?: number | undefined;
  sport: string;
  homeTeam: string;
  awayTeam: string;
  startTime?: string | undefined;
  endTime?: string | undefined;
  homeScore?: number | undefined;
  awayScore?: number | undefined;
}

interface SeedData {
  feed: CommentaryEntry[];
  matches: SeedMatch[];
}

interface MatchMapEntry {
  match: MatchRecord;
  score: { home: number; away: number };
  fakeNext: "home" | "away";
}

interface TeamMatch {
  id?: number | undefined;
  homeTeam: string;
  awayTeam: string;
}

async function readJsonFile(fileUrl: URL): Promise<unknown> {
  const raw = await fs.readFile(fileUrl, "utf8");
  return JSON.parse(raw);
}

async function loadSeedData(): Promise<SeedData> {
  const parsed = await readJsonFile(DEFAULT_DATA_FILE);

  if (Array.isArray(parsed)) {
    return { feed: parsed as CommentaryEntry[], matches: [] };
  }

  const data = parsed as { commentary?: unknown; feed?: unknown; matches?: SeedMatch[] };

  if (Array.isArray(data.commentary)) {
    return { feed: data.commentary as CommentaryEntry[], matches: data.matches ?? [] };
  }

  if (Array.isArray(data.feed)) {
    return { feed: data.feed as CommentaryEntry[], matches: data.matches ?? [] };
  }

  throw new Error(
    "Seed data must be an array or contain a commentary/feed array.",
  );
}

async function fetchMatches(limit = 100): Promise<MatchRecord[]> {
  const response = await fetch(`${API_URL}/matches?limit=${limit}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch matches: ${response.status}`);
  }
  const payload = (await response.json()) as { matches?: MatchRecord[] };
  return Array.isArray(payload.matches) ? payload.matches : [];
}

function parseDate(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isLiveMatch(match: MatchRecord): boolean {
  const start = parseDate(match.startTime);
  const end = parseDate(match.endTime);
  if (!start || !end) {
    return false;
  }
  const now = new Date();
  return now >= start && now < end;
}

function buildMatchTimes(seedMatch: SeedMatch): { startTime: string; endTime: string } {
  const now = new Date();
  const durationMs = DEFAULT_MATCH_DURATION_MINUTES * 60 * 1000;

  let start = parseDate(seedMatch.startTime);
  let end = parseDate(seedMatch.endTime);

  if (!start && !end) {
    start = new Date(now.getTime() - 5 * 60 * 1000);
    end = new Date(start.getTime() + durationMs);
  } else {
    if (start && !end) {
      end = new Date(start.getTime() + durationMs);
    }
    if (!start && end) {
      start = new Date(end.getTime() - durationMs);
    }
  }

  if (FORCE_LIVE && start && end) {
    if (!(now >= start && now < end)) {
      start = new Date(now.getTime() - 5 * 60 * 1000);
      end = new Date(start.getTime() + durationMs);
    }
  }

  if (!start || !end) {
    throw new Error("Seed match must include valid startTime and endTime.");
  }

  return {
    startTime: start.toISOString(),
    endTime: end.toISOString(),
  };
}

async function createMatch(seedMatch: SeedMatch): Promise<MatchRecord> {
  const { startTime, endTime } = buildMatchTimes(seedMatch);

  const response = await fetch(`${API_URL}/matches`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sport: seedMatch.sport,
      homeTeam: seedMatch.homeTeam,
      awayTeam: seedMatch.awayTeam,
      startTime,
      endTime,
      homeScore: seedMatch.homeScore ?? 0,
      awayScore: seedMatch.awayScore ?? 0,
    }),
  });
  if (!response.ok) {
    throw new Error(`Failed to create match: ${response.status}`);
  }
  const responsePayload = (await response.json()) as { match: MatchRecord };
  return responsePayload.match;
}

async function insertCommentary(matchId: number, entry: CommentaryEntry): Promise<CommentaryRecord> {
  const payload: CommentaryEntry = {
    message: entry.message ?? "Update",
  };
  if (entry.minute !== undefined && entry.minute !== null) {
    payload.minute = entry.minute;
  }
  if (entry.sequence !== undefined && entry.sequence !== null) {
    payload.sequence = entry.sequence;
  }
  if (entry.period !== undefined && entry.period !== null) {
    payload.period = entry.period;
  }
  if (entry.eventType !== undefined && entry.eventType !== null) {
    payload.eventType = entry.eventType;
  }
  if (entry.actor !== undefined && entry.actor !== null) {
    payload.actor = entry.actor;
  }
  if (entry.team !== undefined && entry.team !== null) {
    payload.team = entry.team;
  }
  if (entry.metadata !== undefined && entry.metadata !== null) {
    payload.metadata = entry.metadata;
  }
  if (entry.tags !== undefined && entry.tags !== null) {
    payload.tags = entry.tags;
  }

  const response = await fetch(`${API_URL}/matches/${matchId}/commentary`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Failed to create commentary: ${response.status}`);
  }
  const responsePayload = (await response.json()) as { commentary: CommentaryRecord };
  return responsePayload.commentary;
}

function inningsRank(period: string | undefined): number {
  if (!period) {
    return 0;
  }
  const lower = String(period).toLowerCase();
  const match = lower.match(/(\d+)(st|nd|rd|th)/);
  if (match) {
    return Number(match[1]) || 0;
  }
  if (lower.includes("first")) {
    return 1;
  }
  if (lower.includes("second")) {
    return 2;
  }
  if (lower.includes("third")) {
    return 3;
  }
  if (lower.includes("fourth")) {
    return 4;
  }
  return 0;
}

function normalizeCricketFeed(entries: CommentaryEntry[], match: MatchRecord): CommentaryEntry[] {
  const sorted = [...entries].sort((a, b) => {
    const inningsDiff = inningsRank(a.period) - inningsRank(b.period);
    if (inningsDiff !== 0) {
      return inningsDiff;
    }
    const seqA = typeof a.sequence === "number" && Number.isFinite(a.sequence)
      ? a.sequence
      : Number.MAX_SAFE_INTEGER;
    const seqB = typeof b.sequence === "number" && Number.isFinite(b.sequence)
      ? b.sequence
      : Number.MAX_SAFE_INTEGER;
    if (seqA !== seqB) {
      return seqA - seqB;
    }
    const minA = typeof a.minute === "number" && Number.isFinite(a.minute) ? a.minute : Number.MAX_SAFE_INTEGER;
    const minB = typeof b.minute === "number" && Number.isFinite(b.minute) ? b.minute : Number.MAX_SAFE_INTEGER;
    return minA - minB;
  });

  const grouped = new Map<number, CommentaryEntry[]>();
  for (const entry of sorted) {
    const key = inningsRank(entry.period);
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key)?.push(entry);
  }

  const ordered: CommentaryEntry[] = [];
  const inningsKeys = Array.from(grouped.keys()).sort((a, b) => a - b);

  for (const key of inningsKeys) {
    const inningsEntries = grouped.get(key) ?? [];
    const primaryTeam = inningsEntries.find(
      (entry) => entry.team === match.homeTeam || entry.team === match.awayTeam,
    )?.team;
    const secondaryTeam =
      primaryTeam === match.homeTeam ? match.awayTeam : match.homeTeam;

    const neutral = inningsEntries.filter(
      (entry) => !entry.team || entry.team === "neutral",
    );
    const primary = inningsEntries.filter(
      (entry) => entry.team === primaryTeam,
    );
    const secondary = inningsEntries.filter(
      (entry) => entry.team === secondaryTeam,
    );
    const other = inningsEntries.filter(
      (entry) =>
        entry.team &&
        entry.team !== "neutral" &&
        entry.team !== primaryTeam &&
        entry.team !== secondaryTeam,
    );

    ordered.push(...neutral, ...primary, ...secondary, ...other);
  }

  return ordered;
}

function replaceTrailingTeam(message: string | undefined, replacements: Map<string, string>): string | undefined {
  if (typeof message !== "string") {
    return message;
  }
  const match = message.match(/\(([^)]+)\)\s*$/);
  if (!match) {
    return message;
  }
  const captured = match[1];
  const nextTeam = captured ? replacements.get(captured) : undefined;
  if (!nextTeam) {
    return message;
  }
  return message.replace(/\([^)]+\)\s*$/, `(${nextTeam})`);
}

function cloneCommentaryEntries(entries: CommentaryEntry[], templateMatch: TeamMatch, targetMatch: TeamMatch): CommentaryEntry[] {
  const replacements = new Map<string, string>([
    [templateMatch.homeTeam, targetMatch.homeTeam],
    [templateMatch.awayTeam, targetMatch.awayTeam],
  ]);

  return entries.map((entry) => {
    const next: CommentaryEntry = { ...entry, matchId: targetMatch.id };
    if (entry.team === templateMatch.homeTeam) {
      next.team = targetMatch.homeTeam;
    } else if (entry.team === templateMatch.awayTeam) {
      next.team = targetMatch.awayTeam;
    }
    next.message = replaceTrailingTeam(entry.message, replacements);
    return next;
  });
}

function expandFeedForMatches(feed: CommentaryEntry[], seedMatches: SeedMatch[]): CommentaryEntry[] {
  if (seedMatches.length === 0) {
    return feed;
  }

  const byMatchId = new Map<number, CommentaryEntry[]>();
  for (const entry of feed) {
    const matchId = entry.matchId;
    if (typeof matchId !== "number" || !Number.isInteger(matchId)) {
      continue;
    }
    if (!byMatchId.has(matchId)) {
      byMatchId.set(matchId, []);
    }
    byMatchId.get(matchId)?.push(entry);
  }

  const templateBySport = new Map<string, SeedMatch>();
  for (const match of seedMatches) {
    const matchId = match.id;
    if (typeof matchId === "number" && !templateBySport.has(match.sport) && byMatchId.has(matchId)) {
      templateBySport.set(match.sport, match);
    }
  }

  const expanded = [...feed];
  for (const match of seedMatches) {
    const matchId = match.id;
    if (typeof matchId === "number" && byMatchId.has(matchId)) {
      continue;
    }
    const templateMatch = templateBySport.get(match.sport);
    const templateId = templateMatch?.id;
    if (!templateMatch || typeof templateId !== "number") {
      continue;
    }
    const templateEntries = byMatchId.get(templateId) ?? [];
    expanded.push(
      ...cloneCommentaryEntries(templateEntries, templateMatch, match),
    );
  }

  return expanded;
}

function buildRandomizedFeed(feed: CommentaryEntry[], matchMap: Map<number, MatchMapEntry>): CommentaryEntry[] {
  const buckets = new Map<number | null, CommentaryEntry[]>();
  for (const entry of feed) {
    const matchId = entry.matchId;
    const key = typeof matchId === "number" && Number.isInteger(matchId) ? matchId : null;
    if (!buckets.has(key)) {
      buckets.set(key, []);
    }
    buckets.get(key)?.push(entry);
  }

  for (const [matchId, entries] of buckets) {
    if (matchId === null) {
      continue;
    }
    const target = matchMap.get(matchId);
    const sport = target?.match.sport.toLowerCase();
    if (sport === "cricket" && target) {
      buckets.set(matchId, normalizeCricketFeed(entries, target.match));
    }
  }

  const matchIds = Array.from(buckets.keys());
  const randomized: CommentaryEntry[] = [];
  let lastMatchId: number | null = null;

  while (randomized.length < feed.length) {
    const candidates = matchIds.filter(
      (id) => (buckets.get(id) ?? []).length > 0,
    );
    if (candidates.length === 0) {
      break;
    }

    let selectable = candidates;
    if (lastMatchId !== null && candidates.length > 1) {
      const withoutLast = candidates.filter((id) => id !== lastMatchId);
      if (withoutLast.length > 0) {
        selectable = withoutLast;
      }
    }

    const choice = selectable[Math.floor(Math.random() * selectable.length)];
    if (choice === undefined) {
      break;
    }

    const nextEntry = buckets.get(choice)?.shift();
    if (!nextEntry) {
      break;
    }

    randomized.push(nextEntry);
    lastMatchId = choice;
  }

  return randomized;
}

function getMatchEntry(entry: CommentaryEntry, matchMap: Map<number, MatchMapEntry>): MatchMapEntry | null {
  const matchId = entry.matchId;
  if (typeof matchId !== "number" || !Number.isInteger(matchId)) {
    return null;
  }
  return matchMap.get(matchId) ?? null;
}

function randomMatchDelay(): number {
  const range = NEW_MATCH_DELAY_MAX_MS - NEW_MATCH_DELAY_MIN_MS;
  return NEW_MATCH_DELAY_MIN_MS + Math.floor(Math.random() * (range + 1));
}

async function cleanupDatabase(): Promise<void> {
  await db.execute(sql`TRUNCATE TABLE commentary, matches RESTART IDENTITY CASCADE`);
  console.log("🧹 Cleared existing matches and commentary");
}

async function seed(): Promise<void> {
  console.log(`📡 Seeding via API: ${API_URL}`);

  await cleanupDatabase();

  const { feed, matches: seedMatches } = await loadSeedData();
  const matchesList = await fetchMatches();

  const matchMap = new Map<number, MatchMapEntry>();
  const matchKeyMap = new Map<string, MatchRecord>();
  for (const match of matchesList) {
    if (FORCE_LIVE && !isLiveMatch(match)) {
      continue;
    }
    const key = `${match.sport}|${match.homeTeam}|${match.awayTeam}`;
    if (!matchKeyMap.has(key)) {
      matchKeyMap.set(key, match);
    }
    matchMap.set(match.id, {
      match,
      score: { home: match.homeScore ?? 0, away: match.awayScore ?? 0 },
      fakeNext: Math.random() < 0.5 ? "home" : "away",
    });
  }

  if (seedMatches.length > 0) {
    for (const seedMatch of seedMatches) {
      const key = `${seedMatch.sport}|${seedMatch.homeTeam}|${seedMatch.awayTeam}`;
      let match = matchKeyMap.get(key);
      if (!match || (FORCE_LIVE && !isLiveMatch(match))) {
        match = await createMatch(seedMatch);
        matchKeyMap.set(key, match);
        const delayMs = randomMatchDelay();
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      const mapEntry: MatchMapEntry = {
        match,
        score: { home: match.homeScore ?? 0, away: match.awayScore ?? 0 },
        fakeNext: Math.random() < 0.5 ? "home" : "away",
      };

      if (typeof seedMatch.id === "number" && Number.isInteger(seedMatch.id)) {
        matchMap.set(seedMatch.id, mapEntry);
      }
      matchMap.set(match.id, mapEntry);
    }
  }

  if (matchMap.size === 0) {
    throw new Error("No matches found or created in the database.");
  }

  const expandedFeed = expandFeedForMatches(feed, seedMatches);
  const randomizedFeed = buildRandomizedFeed(expandedFeed, matchMap);

  for (let i = 0; i < randomizedFeed.length; i += 1) {
    const entry = randomizedFeed[i];
    if (!entry) {
      continue;
    }

    const target = getMatchEntry(entry, matchMap);
    if (!target) {
      console.warn(
        "⚠️  Skipping entry: matchId missing or not found:",
        entry.message,
      );
      continue;
    }
    const match = target.match;

    const row = await insertCommentary(match.id, entry);
    console.log(`📣 [Match ${match.id}] ${row.message}`);

    if (DELAY_MS > 0) {
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    }
  }
}

seed()
  .catch((err) => {
    console.error("❌ Seed error:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void pool.end();
  });
