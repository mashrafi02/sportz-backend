import arcjet, { detectBot, shield, slidingWindow } from "@arcjet/node";
import type { NextFunction, Request, Response } from "express";

const arcjetKey = process.env.ARCJET_KEY;
const arcjetMode = process.env.ARCJET_MODE === "DRY_RUN" ? "DRY_RUN" : "LIVE";

if (!arcjetKey) throw new Error("ARCJET_KEY is not defined in environment variables");

export const httpArcjet = arcjetKey ? 
    arcjet({
        key: arcjetKey,
        rules: [
            shield({ mode: arcjetMode }),
            detectBot({
                mode: arcjetMode,
                allow: ["CATEGORY:SEARCH_ENGINE", "CATEGORY:PREVIEW"]
            }),
            slidingWindow({
                mode: arcjetMode,
                interval: '10s',
                max: 50
            })
        ]
    }) : null;

export const wsArcjet = arcjetKey ? 
    arcjet({
        key: arcjetKey,
        rules: [
            shield({ mode: arcjetMode }),
            detectBot({
                mode: arcjetMode,
                allow: ["CATEGORY:SEARCH_ENGINE", "CATEGORY:PREVIEW"]
            }),
            slidingWindow({
                mode: arcjetMode,
                interval: '2s',
                max: 5
            })
        ]
    }) : null;

export function securityMiddleware() {

    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {

        if (!httpArcjet) return next();

        try {
            const descision = await httpArcjet.protect(req);

            if (descision.isDenied()) {
                if (descision.reason.isRateLimit()) {
                    res.status(429).json({ error: "Too Many Requests" });
                    return;
                }
                res.status(403).json({ error: "Forbidden" });
                return;
            }
        } catch (error) {
            console.error("Error in Arcjet middleware:", error);
            res.status(503).json({ error: "Service Unavailable" });
            return;
        }

        return next();
    }
}