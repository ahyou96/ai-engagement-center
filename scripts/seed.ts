import path from "node:path";
import { seed } from "../src/lib/seed";

const file = process.env.AEC_DB_PATH ?? path.join(process.cwd(), "data", "aec.db");
const t0 = Date.now();
const r = seed({ file });
console.log(`[seed] ${JSON.stringify(r)} → ${file} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
