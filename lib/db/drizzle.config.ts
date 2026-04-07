import { config as loadEnv } from "dotenv";
import { defineConfig } from "drizzle-kit";
import path from "path";

const pkgDir = process.cwd();

loadEnv({ path: path.resolve(pkgDir, "../../.env") });
loadEnv({ path: path.resolve(pkgDir, ".env"), override: true });

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. Add it to .env at the repo root or in lib/db/.env.",
  );
}

export default defineConfig({
  // Forward slashes: drizzle-kit uses glob.sync(), which breaks on Windows backslashes.
  schema: "./src/schema/index.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
