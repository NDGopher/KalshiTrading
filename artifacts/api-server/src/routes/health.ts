import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { pool } from "@workspace/db";

const router: IRouter = Router();

router.get("/healthz", async (req, res) => {
  const q = req.query.db;
  const deep = String(q ?? "") === "1" || String(q ?? "").toLowerCase() === "true";
  if (!deep) {
    res.json(HealthCheckResponse.parse({ status: "ok" }));
    return;
  }
  try {
    await Promise.race([
      pool.query("SELECT 1 AS ok"),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("db ping timeout")), 8_000),
      ),
    ]);
    res.json({ status: "ok", db: "ok" });
  } catch {
    res.status(503).json({ status: "degraded", db: "unreachable" });
  }
});

export default router;
