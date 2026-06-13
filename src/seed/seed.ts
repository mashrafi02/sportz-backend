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
const LIVE_MATCH_RATIO = Number.parseFloat(process.env.SEED_LIVE_RATIO || "0.66");
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
  scoreDelta?: { home?: number; away?: number } | undefined;
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
  homeScore?: string | undefined;
  awayScore?: string | undefined;
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

type Side = "home" | "away";

interface MatchScoreState {
  home: number;
  away: number;
  homeWickets: number;
  awayWickets: number;
  /** Cricket: tracks which side is currently batting. */
  cricketBattingSide: Side | null;
  cricketStarted: { home: boolean; away: boolean };
  /** Football: caps the total goals each side can score so totals stay realistic. */
  footballGoalTarget: { home: number; away: number };
  footballGoalsScored: { home: number; away: number };
}

interface MatchMapEntry {
  match: MatchRecord;
  score: MatchScoreState;
  /** Number of feed entries still to be processed for this match. */
  remainingEntries: number;
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

function buildMatchTimes(seedMatch: SeedMatch): { startTime: string; endTime: string } {
  const now = new Date();
  const durationMs = DEFAULT_MATCH_DURATION_MINUTES * 60 * 1000;

  if (!FORCE_LIVE) {
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

    if (!start || !end) {
      throw new Error("Seed match must include valid startTime and endTime.");
    }

    return { startTime: start.toISOString(), endTime: end.toISOString() };
  }

  // Distribute matches between "currently live" and "starting soon" so the
  // demo shows a realistic mix of statuses regardless of when it's seeded.
  if (Math.random() < LIVE_MATCH_RATIO) {
    const elapsedMs = Math.floor(Math.random() * durationMs * 0.8);
    const start = new Date(now.getTime() - elapsedMs);
    const end = new Date(start.getTime() + durationMs);
    return { startTime: start.toISOString(), endTime: end.toISOString() };
  }

  const upcomingDelayMs = (15 + Math.random() * 165) * 60 * 1000; // 15min - 3h from now
  const start = new Date(now.getTime() + upcomingDelayMs);
  const end = new Date(start.getTime() + durationMs);
  return { startTime: start.toISOString(), endTime: end.toISOString() };
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
      homeScore: String(seedMatch.homeScore ?? 0),
      awayScore: String(seedMatch.awayScore ?? 0),
    }),
  });
  if (!response.ok) {
    throw new Error(`Failed to create match: ${response.status}`);
  }
  const responsePayload = (await response.json()) as { match: MatchRecord };
  return responsePayload.match;
}

/** Realistic total-goal counts for a football match, weighted toward low-scoring results. */
const FOOTBALL_GOAL_TOTALS = [0, 1, 1, 2, 2, 2, 3, 3, 4, 5];

function createScoreState(): MatchScoreState {
  const total = FOOTBALL_GOAL_TOTALS[Math.floor(Math.random() * FOOTBALL_GOAL_TOTALS.length)] ?? 2;
  let home = 0;
  for (let i = 0; i < total; i += 1) {
    if (Math.random() < 0.5) home += 1;
  }
  return {
    home: 0,
    away: 0,
    homeWickets: 0,
    awayWickets: 0,
    cricketBattingSide: null,
    cricketStarted: { home: false, away: false },
    footballGoalTarget: { home, away: total - home },
    footballGoalsScored: { home: 0, away: 0 },
  };
}

/** Maps a commentary entry's team name to "home"/"away", or null if it doesn't match either side. */
function teamSide(match: MatchRecord, teamName: string | undefined): Side | null {
  if (!teamName) {
    return null;
  }
  if (teamName === match.homeTeam) {
    return "home";
  }
  if (teamName === match.awayTeam) {
    return "away";
  }
  return null;
}

function scoreDeltaMagnitude(entry: CommentaryEntry): number {
  const delta = entry.scoreDelta;
  if (!delta) {
    return 0;
  }
  return delta.home || delta.away || 0;
}

/**
 * Applies a commentary entry's effect to a match's running score.
 *
 * - Cricket: only the currently-batting side accrues runs/wickets; the other
 *   side stays "yet to bat" until its innings begins (innings rank toggles
 *   the batting side).
 * - Football: goals are capped at a per-match realistic total and randomly
 *   assigned to a side that hasn't reached its cap yet.
 * - Basketball: scoring entries add their points directly to the side named
 *   in the commentary.
 *
 * Returns true if the score changed and should be persisted/broadcast.
 */
function applyScoreFromEntry(target: MatchMapEntry, entry: CommentaryEntry): boolean {
  const sport = target.match.sport.toLowerCase();
  const score = target.score;
  let changed = false;

  if (sport === "cricket") {
    if (score.cricketBattingSide === null) {
      score.cricketBattingSide = teamSide(target.match, entry.team) ?? "home";
    }

    let battingSide: Side | null = score.cricketBattingSide;
    const battingWicketsKey = battingSide === "home" ? "homeWickets" : "awayWickets";

    // The current side is all out — hand the innings over to the other side
    // (or stop scoring if both innings are already complete).
    if (score[battingWicketsKey] >= 10) {
      const otherSide: Side = battingSide === "home" ? "away" : "home";
      const otherWicketsKey = otherSide === "home" ? "homeWickets" : "awayWickets";
      if (score[otherWicketsKey] < 10) {
        score.cricketBattingSide = otherSide;
        battingSide = otherSide;
      } else {
        battingSide = null;
      }
    }

    if (battingSide && !score.cricketStarted[battingSide]) {
      score.cricketStarted[battingSide] = true;
      changed = true;
    }

    const magnitude = scoreDeltaMagnitude(entry);
    if (battingSide && magnitude !== 0) {
      score[battingSide] += magnitude;
      changed = true;
    }

    if (entry.eventType === "wicket" && battingSide) {
      const wicketsKey = battingSide === "home" ? "homeWickets" : "awayWickets";
      if (score[wicketsKey] < 10) {
        score[wicketsKey] += 1;
        changed = true;
      }
    }
  } else if (sport === "football") {
    if (entry.eventType === "goal") {
      const magnitude = scoreDeltaMagnitude(entry) || 1;
      const sides: Side[] = Math.random() < 0.5 ? ["home", "away"] : ["away", "home"];
      for (const side of sides) {
        if (score.footballGoalsScored[side] < score.footballGoalTarget[side]) {
          score[side] += magnitude;
          score.footballGoalsScored[side] += 1;
          changed = true;
          break;
        }
      }
    }
  } else if (sport === "basketball") {
    if (entry.eventType === "basket" || entry.eventType === "three") {
      const side = teamSide(target.match, entry.team);
      const magnitude = scoreDeltaMagnitude(entry);
      if (side && magnitude !== 0) {
        score[side] += magnitude;
        changed = true;
      }
    }
  }

  return changed;
}

/** Formats a match's running score for display: plain numbers, or "runs/wickets"/"Yet to bat" for cricket. */
function formatScores(target: MatchMapEntry): { home: string; away: string } {
  const sport = target.match.sport.toLowerCase();
  const score = target.score;

  if (sport === "cricket") {
    const home = score.cricketStarted.home ? `${score.home}/${Math.min(score.homeWickets, 10)}` : "Yet to bat";
    const away = score.cricketStarted.away ? `${score.away}/${Math.min(score.awayWickets, 10)}` : "Yet to bat";
    return { home, away };
  }

  return { home: String(score.home), away: String(score.away) };
}

/** Parses a formatted score back into a comparable number (cricket runs, or the raw integer). */
function parseScoreValue(sport: string, score: string): number {
  if (sport.toLowerCase() === "cricket") {
    if (score.toLowerCase() === "yet to bat") {
      return 0;
    }
    return Number.parseInt(score.split("/")[0] ?? "0", 10) || 0;
  }
  return Number.parseInt(score, 10) || 0;
}

/** Describes a finished match's final score and winner for logging. */
function describeResult(match: MatchRecord, scores: { home: string; away: string }): string {
  const home = parseScoreValue(match.sport, scores.home);
  const away = parseScoreValue(match.sport, scores.away);
  const scoreline = `${match.homeTeam} ${scores.home} - ${scores.away} ${match.awayTeam}`;
  if (home === away) {
    return `${scoreline} (Draw)`;
  }
  const winner = home > away ? match.homeTeam : match.awayTeam;
  return `${scoreline} (${winner} won)`;
}

interface MatchUpdatePayload {
  homeScore?: string;
  awayScore?: string;
  status?: string;
}

async function updateMatch(matchId: number, payload: MatchUpdatePayload): Promise<void> {
  const response = await fetch(`${API_URL}/matches/${matchId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Failed to update match: ${response.status}`);
  }
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
    if (FORCE_LIVE && match.status !== "live") {
      continue;
    }
    const key = `${match.sport}|${match.homeTeam}|${match.awayTeam}`;
    if (!matchKeyMap.has(key)) {
      matchKeyMap.set(key, match);
    }
    matchMap.set(match.id, {
      match,
      score: createScoreState(),
      remainingEntries: 0,
    });
  }

  if (seedMatches.length > 0) {
    for (const seedMatch of seedMatches) {
      const key = `${seedMatch.sport}|${seedMatch.homeTeam}|${seedMatch.awayTeam}`;
      let match = matchKeyMap.get(key);
      if (!match || (FORCE_LIVE && match.status !== "live")) {
        match = await createMatch(seedMatch);
        matchKeyMap.set(key, match);
        const delayMs = randomMatchDelay();
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      const mapEntry: MatchMapEntry = {
        match,
        score: createScoreState(),
        remainingEntries: 0,
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

  // Pre-count how many feed entries each live match will receive, so we know
  // when a match's story is "complete" and can be marked finished.
  for (const entry of randomizedFeed) {
    const target = getMatchEntry(entry, matchMap);
    if (target && target.match.status === "live") {
      target.remainingEntries += 1;
    }
  }

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

    if (match.status !== "live") {
      // Don't seed commentary for matches that haven't started yet.
      continue;
    }

    const row = await insertCommentary(match.id, entry);
    console.log(`📣 [Match ${match.id}] ${row.message}`);

    let scoreChanged = applyScoreFromEntry(target, entry);
    target.remainingEntries -= 1;
    const isLastEntry = target.remainingEntries <= 0;

    // Basketball games don't end in a tie - settle a draw with a late buzzer-beater.
    if (isLastEntry && match.sport.toLowerCase() === "basketball" && target.score.home === target.score.away) {
      const winner: Side = Math.random() < 0.5 ? "home" : "away";
      target.score[winner] += Math.random() < 0.5 ? 2 : 3;
      scoreChanged = true;
    }

    if (scoreChanged || isLastEntry) {
      const scores = formatScores(target);
      const payload: MatchUpdatePayload = { homeScore: scores.home, awayScore: scores.away };
      if (isLastEntry) {
        payload.status = "finished";
      }
      await updateMatch(match.id, payload);

      if (scoreChanged) {
        console.log(`🔢 [Match ${match.id}] ${match.homeTeam} ${scores.home} - ${scores.away} ${match.awayTeam}`);
      }
      if (isLastEntry) {
        console.log(`🏁 [Match ${match.id}] Finished: ${describeResult(match, scores)}`);
      }
    }

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
