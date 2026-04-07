import path from "node:path";
import { readParquetFile } from "../src/parquet-load.js";

const file =
  process.argv[2] ??
  "C:/kalshitrading/data/jbecker-data/data/kalshi/trades/trades_72130000_72140000.parquet";

const rows = await readParquetFile(path.resolve(file), { rowEnd: 5 });
console.log("keys:", Object.keys(rows[0] ?? {}));
console.log("row0:", rows[0]);
