/**
 * Resumable download + extract for Jon-Becker prediction-market-analysis dataset.
 * @see https://github.com/Jon-Becker/prediction-market-analysis
 */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { getRepoRoot } from "./paths.js";

const require = createRequire(import.meta.url);
const path7za: string = require("7zip-bin").path7za;

export const JBECKER_DATA_TAR_ZST_URL = "https://s3.jbecker.dev/data.tar.zst";

export const JBECKER_ARCHIVE_BASENAME = "jbecker-data.tar.zst";

export type DownloadPhase = "downloading" | "verifying" | "extracting" | "relocating" | "done" | "error";

export interface JBeckerDownloadProgress {
  phase: DownloadPhase;
  downloadedBytes: number;
  totalBytes: number | null;
  message?: string;
}

function defaultDataDir(): string {
  return path.join(getRepoRoot(), "data");
}

function archivePath(dataDir = defaultDataDir()): string {
  return path.join(dataDir, JBECKER_ARCHIVE_BASENAME);
}

function targetKalshiDir(dataDir = defaultDataDir()): string {
  return path.join(dataDir, "jbecker-data", "data", "kalshi");
}

export function jbeckerArchiveFilePath(dataRoot?: string): string {
  const root = dataRoot ?? defaultDataDir();
  return archivePath(root);
}

export function jbeckerKalshiTargetPath(dataRoot?: string): string {
  const root = dataRoot ?? defaultDataDir();
  return targetKalshiDir(root);
}

export function jbeckerDownloadInstructions(dataDir: string): string {
  return [
    "Jon-Becker Kalshi + Polymarket dataset (~36 GiB compressed):",
    "",
    "One-click (resume + extract):",
    `  pnpm --filter @workspace/backtester run download-jbecker`,
    "",
    "Manual URL:",
    `  ${JBECKER_DATA_TAR_ZST_URL}`,
    "",
    `Archive saved as: ${path.join(dataDir, JBECKER_ARCHIVE_BASENAME)}`,
    `Kalshi parquet expected at: ${path.join(dataDir, "jbecker-data", "data", "kalshi", "{markets,trades}")}`,
    "",
    "Fallback: pmxt orderbook replay (synthetic outcomes):",
    "  pnpm --filter @workspace/backtester run backtest -- --date YYYY-MM-DD --hour H",
  ].join("\n");
}

async function headContentLength(url: string): Promise<number | null> {
  const res = await fetch(url, { method: "HEAD", redirect: "follow" });
  if (!res.ok) return null;
  const cl = res.headers.get("content-length");
  if (!cl) return null;
  const n = parseInt(cl, 10);
  return Number.isFinite(n) ? n : null;
}

function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)} KB`;
  return `${n} B`;
}

/**
 * HTTP(S) download with Range resume into `destPath`.
 */
export async function downloadJbeckerArchive(
  destPath: string,
  url = JBECKER_DATA_TAR_ZST_URL,
  onProgress?: (p: JBeckerDownloadProgress) => void,
): Promise<{ totalBytes: number | null }> {
  let start = 0;
  try {
    const st = await fs.stat(destPath);
    start = st.size;
  } catch {
    /* missing */
  }

  const totalKnown = await headContentLength(url);
  if (totalKnown != null && start >= totalKnown) {
    onProgress?.({
      phase: "downloading",
      downloadedBytes: start,
      totalBytes: totalKnown,
      message: "Archive already complete on disk.",
    });
    return { totalBytes: totalKnown };
  }

  const headers: Record<string, string> = {};
  if (start > 0) headers.Range = `bytes=${start}-`;

  const res = await fetch(url, { headers, redirect: "follow" });

  if (res.status === 416) {
    if (totalKnown != null && start === totalKnown) {
      return { totalBytes: totalKnown };
    }
    await fs.unlink(destPath).catch(() => {});
    return downloadJbeckerArchive(destPath, url, onProgress);
  }

  if (start > 0 && res.status === 200) {
    await fs.unlink(destPath);
    start = 0;
  }

  if (start > 0 && res.status !== 206) {
    throw new Error(`Resume failed: expected 206, got ${res.status}. Delete partial file and retry.`);
  }

  if (!res.ok) {
    throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`);
  }

  const chunkLen = res.headers.get("content-length");
  const remaining = chunkLen ? parseInt(chunkLen, 10) : null;
  const totalBytes =
    res.status === 206 && remaining != null && totalKnown != null
      ? totalKnown
      : res.status === 206 && remaining != null
        ? start + remaining
        : totalKnown ?? remaining;

  await fs.mkdir(path.dirname(destPath), { recursive: true });

  const body = res.body;
  if (!body) throw new Error("No response body");

  const out = createWriteStream(destPath, { flags: start > 0 ? "a" : "w" });
  const reader = body.getReader();
  let downloaded = start;
  let lastLog = Date.now();
  const LOG_MS = 2000;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      await new Promise<void>((resolve, reject) => {
        out.write(Buffer.from(value), (err) => (err ? reject(err) : resolve()));
      });
      downloaded += value.byteLength;
      const now = Date.now();
      if (now - lastLog >= LOG_MS) {
        lastLog = now;
        const pct =
          totalBytes != null && totalBytes > 0
            ? ((downloaded / totalBytes) * 100).toFixed(1)
            : "?";
        onProgress?.({
          phase: "downloading",
          downloadedBytes: downloaded,
          totalBytes: totalBytes,
          message: `${formatBytes(downloaded)} / ${totalBytes != null ? formatBytes(totalBytes) : "?"} (${pct}%)`,
        });
      }
    }
  } finally {
    reader.releaseLock();
  }

  await new Promise<void>((resolve, reject) => {
    out.end(() => resolve());
    out.on("error", reject);
  });

  onProgress?.({
    phase: "downloading",
    downloadedBytes: downloaded,
    totalBytes: totalBytes,
    message: `Finished download (${formatBytes(downloaded)})`,
  });

  return { totalBytes };
}

/**
 * Optional SHA-256 verify if `url.sha256` exists and returns a hex line.
 */
export async function verifySha256IfPublished(
  filePath: string,
  url = JBECKER_DATA_TAR_ZST_URL,
  onProgress?: (p: JBeckerDownloadProgress) => void,
): Promise<boolean> {
  const shaUrl = `${url}.sha256`;
  let expected: string | undefined;
  try {
    const r = await fetch(shaUrl);
    if (!r.ok) return true;
    const line = (await r.text()).trim();
    expected = line.split(/\s+/)[0] ?? "";
    if (!/^[a-f0-9]{64}$/i.test(expected)) return true;
  } catch {
    return true;
  }

  onProgress?.({
    phase: "verifying",
    downloadedBytes: 0,
    totalBytes: null,
    message: "Verifying SHA-256 (streaming, may take several minutes)…",
  });

  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  const actual = hash.digest("hex");
  if (actual.toLowerCase() !== expected!.toLowerCase()) {
    throw new Error(
      `SHA-256 mismatch: expected ${expected!.slice(0, 16)}… got ${actual.slice(0, 16)}… — delete archive and re-download.`,
    );
  }
  onProgress?.({
    phase: "verifying",
    downloadedBytes: 0,
    totalBytes: null,
    message: "SHA-256 OK",
  });
  return true;
}

function run7za(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(path7za, args, {
      stdio: "inherit",
      windowsHide: false,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`7za exited with code ${code}`));
    });
  });
}

/**
 * Extract `tar.zst` with bundled 7za, then move archive `data/kalshi` → `data/jbecker-data/data/kalshi`.
 */
export async function extractJbeckerArchiveToLayout(
  archiveFile: string,
  dataDir: string,
  onProgress?: (p: JBeckerDownloadProgress) => void,
): Promise<{ kalshiDir: string }> {
  const tmpRoot = path.join(dataDir, ".jbecker-extract-tmp");
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.mkdir(tmpRoot, { recursive: true });

  onProgress?.({
    phase: "extracting",
    downloadedBytes: 0,
    totalBytes: null,
    message: `Extracting with 7-Zip → ${tmpRoot} (this is CPU/disk heavy)…`,
  });

  await run7za(["x", archiveFile, `-o${tmpRoot}`, "-y"]);

  const kalshiSrc = await findKalshiUnderExtract(tmpRoot);
  if (!kalshiSrc) {
    throw new Error(
      `Could not find kalshi/markets under ${tmpRoot}. Inspect archive layout; expected data/kalshi/…`,
    );
  }

  const kalshiDest = targetKalshiDir(dataDir);
  onProgress?.({
    phase: "relocating",
    downloadedBytes: 0,
    totalBytes: null,
    message: `Moving ${kalshiSrc} → ${kalshiDest}`,
  });

  await fs.mkdir(path.dirname(kalshiDest), { recursive: true });
  await fs.rm(kalshiDest, { recursive: true, force: true });
  await fs.rename(kalshiSrc, kalshiDest);

  await fs.rm(tmpRoot, { recursive: true, force: true });

  onProgress?.({
    phase: "done",
    downloadedBytes: 0,
    totalBytes: null,
    message: `Kalshi data ready at ${kalshiDest}`,
  });

  return { kalshiDir: kalshiDest };
}

async function findKalshiUnderExtract(root: string): Promise<string | null> {
  const candidates = [
    path.join(root, "data", "kalshi"),
    path.join(root, "kalshi"),
  ];
  for (const c of candidates) {
    try {
      await fs.access(path.join(c, "markets"));
      return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

export interface RunJBeckerDownloadOptions {
  /** Repo `data/` directory (default: `<repo>/data`) */
  dataDir?: string;
  /** Skip download if archive exists and looks complete */
  skipDownload?: boolean;
  /** Skip extraction (only download) */
  downloadOnly?: boolean;
  /** Only extract existing archive */
  extractOnly?: boolean;
  /** Skip SHA-256 even if .sha256 exists */
  skipVerify?: boolean;
  onProgress?: (p: JBeckerDownloadProgress) => void;
}

/**
 * Full pipeline: download (resumable) → optional checksum → extract → relocate kalshi/.
 */
export async function runJBeckerDownloadPipeline(opts: RunJBeckerDownloadOptions = {}): Promise<{
  archivePath: string;
  kalshiDir: string | null;
}> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const dest = archivePath(dataDir);

  if (opts.extractOnly || opts.skipDownload) {
    await fs.access(dest).catch(() => {
      throw new Error(`Archive not found: ${dest}`);
    });
  } else {
    await downloadJbeckerArchive(dest, JBECKER_DATA_TAR_ZST_URL, opts.onProgress);
  }

  if (!opts.skipVerify && !opts.extractOnly) {
    await verifySha256IfPublished(dest, JBECKER_DATA_TAR_ZST_URL, opts.onProgress);
  }

  if (opts.downloadOnly) {
    return { archivePath: dest, kalshiDir: null };
  }

  const { kalshiDir } = await extractJbeckerArchiveToLayout(dest, dataDir, opts.onProgress);
  return { archivePath: dest, kalshiDir };
}
