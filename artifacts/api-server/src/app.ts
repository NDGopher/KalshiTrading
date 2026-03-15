import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import router from "./routes";

const app: Express = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const API_SECRET = process.env.API_SECRET;

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.path === "/api/healthz") {
    next();
    return;
  }

  if (!API_SECRET) {
    next();
    return;
  }

  const token = req.headers.authorization?.replace("Bearer ", "");
  if (token !== API_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

app.use(authMiddleware);

app.use("/api", router);

export default app;
