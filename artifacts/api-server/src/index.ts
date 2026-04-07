import "./load-env";
import app from "./app";
import { rehydratePipeline, startWatchdog } from "./lib/agents/pipeline.js";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Global crash guards — root cause of the March 30 → April 7 outage:
//
// The pipeline ran every 5 min via setInterval. Each cycle called analyst.ts
// which in turn called the Claude API. If a Claude response came back malformed
// or the promise chain rejected after the per-cycle try/catch scope closed
// (e.g., during the final logAgentRun DB write on a degraded connection),
// the rejection would propagate to the top-level Node.js event loop with no
// handler. Node.js default behavior: print the error and EXIT THE PROCESS.
// Replit's workflow runner will restart a crashed process, but after repeated
// rapid crashes it stops retrying — leaving the server permanently dead.
//
// Fix: register process-level handlers so any escaping rejection/exception is
// logged but does NOT terminate the process. The trading pipeline and HTTP
// server stay alive even if one cycle produces a bad API response.
process.on("uncaughtException", (err: Error) => {
  console.error("[Process] Uncaught exception (non-fatal, server continues):", err?.message || err);
});

process.on("unhandledRejection", (reason: unknown) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error("[Process] Unhandled promise rejection (non-fatal, server continues):", msg);
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
  rehydratePipeline().catch((err: unknown) => {
    console.error("Failed to rehydrate pipeline on startup:", err);
  });
  // Start dead-man's switch: if no cycle in 15 min, auto-restart pipeline
  startWatchdog();
});
