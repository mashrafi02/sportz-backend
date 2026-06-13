ALTER TABLE "matches" ALTER COLUMN "home_score" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "matches" ALTER COLUMN "home_score" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "matches" ALTER COLUMN "away_score" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "matches" ALTER COLUMN "away_score" SET DEFAULT '0';