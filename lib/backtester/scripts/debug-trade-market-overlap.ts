import path from "node:path";
import { readParquetFile } from "../src/parquet-load.js";
import { loadJbeckerResolvedMarkets } from "../src/historical/jbecker-loader.js";

const root = "C:/kalshitrading/data/jbecker-data/data/kalshi";
const tradeFile = path.join(root, "trades/trades_72130000_72140000.parquet");

const map = await loadJbeckerResolvedMarkets(root, { maxFiles: 500, maxRowsPerFile: 400_000 });
console.log("markets map size", map.size);

const rows = await readParquetFile(tradeFile, { rowEnd: 2000 });
let inMap = 0;
let finalizedSample = 0;
for (const row of rows) {
  const t = String(row.ticker ?? "");
  if (map.has(t)) {
    inMap++;
    finalizedSample++;
  }
}
console.log("trade rows checked", rows.length, "in resolved map", inMap);

const t0 = String(rows[0]?.ticker ?? "");
console.log("sample ticker", t0, "in map", map.has(t0));
