import fs from "node:fs/promises";
import path from "node:path";
import { kalshiCacheDir } from "./paths.js";

export const ARCHIVE_HOST = "https://archive.pmxt.dev";

/** Polymarket hourly parquet files are served from Cloudflare R2 (links on archive.pmxt.dev point here). */
export const ORDERBOOK_R2_HOST = "https://r2.pmxt.dev";

/** Hourly Kalshi orderbook dump path (when present on archive). */
export function kalshiOrderbookDumpPath(date: string, hourUtc: number): string {
  const h = hourUtc.toString().padStart(2, "0");
  return `/dumps/kalshi_orderbook_${date}T${h}.parquet`;
}

export function kalshiOrderbookDumpUrl(date: string, hourUtc: number, base = ARCHIVE_HOST): string {
  return `${base.replace(/\/$/, "")}${kalshiOrderbookDumpPath(date, hourUtc)}`;
}

/** Polymarket hourly orderbook dumps (default: R2; archive.pmxt.dev/dumps/*.parquet is HTML, not binary). */
export function polymarketOrderbookDumpUrl(date: string, hourUtc: number, base = ORDERBOOK_R2_HOST): string {
  const h = hourUtc.toString().padStart(2, "0");
  return `${base.replace(/\/$/, "")}/polymarket_orderbook_${date}T${h}.parquet`;
}

function orderbookDumpCandidateUrls(date: string, hourUtc: number, archiveBase: string): string[] {
  const h = hourUtc.toString().padStart(2, "0");
  const b = archiveBase.replace(/\/$/, "");
  const r2 = ORDERBOOK_R2_HOST.replace(/\/$/, "");
  return [
    `${r2}/polymarket_orderbook_${date}T${h}.parquet`,
    `${b}/dumps/polymarket_orderbook_${date}T${h}.parquet`,
    `${b}/dumps/kalshi_orderbook_${date}T${h}.parquet`,
    `${b}/dumps/Kalshi_orderbook_${date}T${h}.parquet`,
  ];
}

function isParquetMagic(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 4) return false;
  const u8 = new Uint8Array(buf, 0, 4);
  return u8[0] === 0x50 && u8[1] === 0x41 && u8[2] === 0x52 && u8[3] === 0x31; // "PAR1"
}

export type DownloadResult =
  | { ok: true; localPath: string; url: string }
  | { ok: false; url: string; reason: string };

/**
 * Download an hourly pmxt orderbook dump into data/kalshi/ if missing.
 * Tries **Polymarket** on r2.pmxt.dev first, then archive.pmxt.dev/dumps/ fallbacks, then Kalshi. Validates Parquet magic.
 */
export async function ensureKalshiHourCached(
  date: string,
  hourUtc: number,
  opts?: { baseUrl?: string; cacheDir?: string },
): Promise<DownloadResult> {
  const base = opts?.baseUrl ?? ARCHIVE_HOST;
  const dir = opts?.cacheDir ?? kalshiCacheDir();
  await fs.mkdir(dir, { recursive: true });

  const urls = orderbookDumpCandidateUrls(date, hourUtc, base);

  for (const url of urls) {
    const filename = path.basename(new URL(url).pathname);
    const localPath = path.join(dir, filename);

    try {
      const existing = await fs.readFile(localPath);
      if (
        isParquetMagic(
          existing.buffer.slice(existing.byteOffset, existing.byteOffset + existing.byteLength),
        )
      ) {
        return { ok: true, localPath, url };
      }
    } catch {
      /* missing */
    }

    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) continue;
    const ab = await res.arrayBuffer();
    if (!isParquetMagic(ab)) continue;
    await fs.writeFile(localPath, Buffer.from(ab));
    return { ok: true, localPath, url };
  }

  return {
    ok: false,
    url: urls[0]!,
    reason:
      "No valid Polymarket/Kalshi parquet at r2.pmxt.dev or archive URLs (missing file or non-parquet response). " +
      "Place a .parquet file under data/kalshi/ or pass --file.",
  };
}

/**
 * Try every hour 0–23 for a calendar day (UTC). Returns only hours that downloaded or were already cached.
 */
export async function ensureKalshiDayCached(
  date: string,
  opts?: { baseUrl?: string; cacheDir?: string },
): Promise<{ paths: string[]; failures: string[] }> {
  const paths: string[] = [];
  const failures: string[] = [];

  for (let h = 0; h < 24; h++) {
    const r = await ensureKalshiHourCached(date, h, opts);
    if (r.ok) paths.push(r.localPath);
    else failures.push(`${date}T${h.toString().padStart(2, "0")}: ${r.reason}`);
  }

  return { paths, failures };
}
