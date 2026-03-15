import app from "./app";
import { rehydratePipeline } from "./lib/agents/pipeline.js";

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

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
  rehydratePipeline().catch((err: unknown) => {
    console.error("Failed to rehydrate pipeline on startup:", err);
  });
});
