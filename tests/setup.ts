import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { seed } from "../src/lib/seed";

process.env.AEC_FAST = "1";
export function freshDb(name: string, customers = 1500, events = 15000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aec-test-"));
  const file = path.join(dir, `${name}.db`);
  seed({ file, customers, events, quiet: true, seed: 42 });
  return file;
}
