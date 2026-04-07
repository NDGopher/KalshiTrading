#!/usr/bin/env node
import path from "node:path";
import {
  jbeckerDownloadInstructions,
  runJBeckerDownloadPipeline,
} from "../jbecker-downloader.js";
import { getRepoRoot } from "../paths.js";

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function main(): Promise<void> {
  const dataDir = path.join(getRepoRoot(), "data");

  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(`
Jon-Becker dataset downloader (~36 GiB compressed)

Usage:
  pnpm --filter @workspace/backtester run download-jbecker [options]

Options:
  --download-only   Only download ${path.join("data", "jbecker-data.tar.zst")} (resumable)
  --extract-only    Only extract existing archive (no download, no checksum)
  --skip-download   Use existing archive; verify (if .sha256 exists) + extract
  --skip-verify     Skip SHA-256 check even if .sha256 is published
  --help            This message

Output layout after extract:
  data/historical-kalshi/jbecker/kalshi/markets/
  data/historical-kalshi/jbecker/kalshi/trades/

${jbeckerDownloadInstructions(dataDir)}
`);
    process.exit(0);
  }

  console.log("── Jon-Becker dataset ──");
  console.log("Data dir:", dataDir);
  console.log("");

  const { archivePath, kalshiDir } = await runJBeckerDownloadPipeline({
    dataDir,
    downloadOnly: hasFlag("--download-only"),
    extractOnly: hasFlag("--extract-only"),
    skipDownload: hasFlag("--skip-download"),
    skipVerify: hasFlag("--skip-verify"),
    onProgress(p) {
      const msg = p.message ?? "";
      if (p.phase === "downloading" && p.totalBytes != null && p.totalBytes > 0) {
        const pct = ((p.downloadedBytes / p.totalBytes) * 100).toFixed(1);
        process.stdout.write(`\r[download] ${pct}%  ${msg}    `);
      } else {
        console.log(`[${p.phase}] ${msg}`);
      }
    },
  });

  process.stdout.write("\n");
  console.log("Archive:", archivePath);
  if (kalshiDir) {
    console.log("Kalshi parquet:", kalshiDir);
    console.log("");
    console.log("Next: small multi-strategy test (partial data is OK):");
    console.log(
      `  pnpm --filter @workspace/backtester run historical-multi -- --from YYYY-MM-DD --to YYYY-MM-DD --market-files 8 --trade-files 10 --max-trade-rows 50000`,
    );
  } else {
    console.log("(Extract skipped — use without --download-only to unpack.)");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
