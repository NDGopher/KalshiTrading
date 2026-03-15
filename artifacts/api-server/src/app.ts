import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import crypto from "crypto";
import router from "./routes";

const app: Express = express();

const DASHBOARD_ORIGIN = process.env.REPLIT_DEV_DOMAIN
  ? `https://${process.env.REPLIT_DEV_DOMAIN}`
  : undefined;

app.use(
  cors({
    origin: DASHBOARD_ORIGIN || true,
    credentials: true,
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const API_SECRET = process.env.API_SECRET || crypto.randomBytes(32).toString("hex");

if (!process.env.API_SECRET) {
  console.log(`[Auth] Auto-generated API_SECRET for this session. Set API_SECRET env var to persist across restarts.`);
}

function isSameOrigin(req: Request): boolean {
  const origin = req.headers.origin;
  const referer = req.headers.referer;

  if (!origin && !referer) return false;

  if (DASHBOARD_ORIGIN) {
    if (origin === DASHBOARD_ORIGIN) return true;
    if (referer?.startsWith(DASHBOARD_ORIGIN)) return true;
  }

  const host = req.headers.host;
  if (origin) {
    try {
      const originHost = new URL(origin).host;
      if (originHost === host) return true;
    } catch { /* invalid origin */ }
  }
  if (referer) {
    try {
      const refererHost = new URL(referer).host;
      if (refererHost === host) return true;
    } catch { /* invalid referer */ }
  }

  return false;
}

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.path === "/api/healthz") {
    next();
    return;
  }

  const isReadOnly = req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS";
  if (isReadOnly) {
    next();
    return;
  }

  const token = req.headers.authorization?.replace("Bearer ", "");
  if (token === API_SECRET) {
    next();
    return;
  }

  if (isSameOrigin(req)) {
    next();
    return;
  }

  res.status(401).json({ error: "Unauthorized. Provide Authorization: Bearer <API_SECRET> header." });
}

app.use(authMiddleware);

app.use("/api", router);

export default app;
