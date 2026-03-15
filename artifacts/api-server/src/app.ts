import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import crypto from "crypto";
import router from "./routes";

const app: Express = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const API_SECRET = process.env.API_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.API_SECRET) {
  console.log(`[AUTH] No API_SECRET set. Generated ephemeral secret for this session: ${API_SECRET}`);
  console.log(`[AUTH] Set the API_SECRET environment variable to persist across restarts.`);
}

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.path === "/api/healthz") {
    next();
    return;
  }

  const token = req.headers.authorization?.replace("Bearer ", "");
  if (token === API_SECRET) {
    next();
    return;
  }

  const isReadOnly = req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS";
  if (isReadOnly) {
    next();
    return;
  }

  res.status(401).json({ error: "Unauthorized" });
}

app.use(authMiddleware);

app.use("/api", router);

export default app;
