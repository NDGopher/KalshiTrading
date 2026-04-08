import "./load-env";
import app from "./app";
import { rehydratePipeline, startWatchdog } from "./lib/agents/pipeline.js";
import { waitForDatabase } from "@workspace/db";

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

process.on("uncaughtException", (err: Error) => {
  console.error("[Process] Uncaught exception (non-fatal, server continues):", err?.message || err);
});

process.on("unhandledRejection", (reason: unknown) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error("[Process] Unhandled promise rejection (non-fatal, server continues):", msg);
});

async function main(): Promise<void> {
  console.info("[DB] Waiting for a responsive database before accepting traffic…");
  await waitForDatabase();
  console.info("[DB] OK — starting HTTP server");

  app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
    rehydratePipeline().catch((err: unknown) => {
      console.error("Failed to rehydrate pipeline on startup:", err);
    });
    startWatchdog();
  });
}

main().catch((err: unknown) => {
  console.error("[Startup] Fatal:", err);
  process.exit(1);
});
