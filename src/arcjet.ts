import arcjet, { detectBot, shield, slidingWindow } from "@arcjet/node";
import type { NextFunction, Request, Response } from "express";

const arcjetKey = process.env.ARCJET_KEY;
const arcjetMode = process.env.ARCJET_MODE === "DRY_RUN" ? "DRY_RUN" : "LIVE";
const isDevelopment = process.env.ARCJET_ENV === "development";

if (!arcjetKey) throw new Error("ARCJET_KEY is not defined in environment variables");

// Render (and similar PaaS) proxy requests to the app over the loopback
// interface, so the real client IP only arrives via X-Forwarded-For. Trust
// the local proxy so Arcjet reads that header instead of socket.remoteAddress.
const trustedProxies = ['127.0.0.1', '::1'];

export const httpArcjet = arcjetKey ?
    arcjet({
        key: arcjetKey,
        proxies: trustedProxies,
        rules: [
            shield({ mode: arcjetMode }),
            detectBot({
                mode: arcjetMode,
                allow: isDevelopment
                    ? ["CATEGORY:SEARCH_ENGINE", "CATEGORY:PREVIEW", "CATEGORY:TOOL"]
                    : ["CATEGORY:SEARCH_ENGINE", "CATEGORY:PREVIEW"]
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
        proxies: trustedProxies,
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