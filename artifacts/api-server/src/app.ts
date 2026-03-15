import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import crypto from "crypto";
import router from "./routes";

const app: Express = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const API_SECRET = process.env.API_SECRET || crypto.randomBytes(32).toString("hex");

app.get("/api/auth/token", (_req: Request, res: Response): void => {
  res.json({ token: API_SECRET });
});

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.path === "/api/healthz" || req.path === "/api/auth/token") {
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

  res.status(401).json({ error: "Unauthorized. Fetch token from GET /api/auth/token first." });
}

app.use(authMiddleware);

app.use("/api", router);

export default app;
