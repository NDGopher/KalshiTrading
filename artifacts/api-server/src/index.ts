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

// Global crash guards: prevent a single bad API response or promise rejection
// from killing the entire server process and stopping the trading pipeline.
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
