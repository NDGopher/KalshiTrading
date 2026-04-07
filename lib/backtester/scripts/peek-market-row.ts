import { readParquetFile } from "../src/parquet-load.js";

const f =
  process.argv[2] ??
  "C:/kalshitrading/data/jbecker-data/data/kalshi/markets/markets_4470000_4480000.parquet";
const rows = await readParquetFile(f, { rowEnd: 8 });
console.log("keys", Object.keys(rows[0] ?? {}));
for (let i = 0; i < Math.min(5, rows.length); i++) {
  console.log("---", i, rows[i]?.ticker, rows[i]?.status, rows[i]?.result);
}
