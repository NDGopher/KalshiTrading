/**
 * Optional allowlist of Kalshi wallet ids treated as "sharp" in replay (sports-focused tape).
 * Set `KALSHI_SHARP_WALLET_IDS=id1,id2` (comma-separated) to merge with any defaults below.
 */
const DEFAULT_SHARP_WALLET_IDS: string[] = [];

function loadEnvIds(): string[] {
  const raw = process.env.KALSHI_SHARP_WALLET_IDS?.trim();
  if (!raw) return [];
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const SHARP_SET = new Set<string>([...DEFAULT_SHARP_WALLET_IDS, ...loadEnvIds()]);

/** Count of wallet ids in the merged allowlist (defaults + `KALSHI_SHARP_WALLET_IDS`). */
export function sharpWalletAllowlistCount(): number {
  return SHARP_SET.size;
}

export function isKnownSharpWallet(walletId: string | undefined): boolean {
  if (!walletId) return false;
  return SHARP_SET.has(walletId);
}
