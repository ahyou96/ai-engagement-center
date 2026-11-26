import fs from "node:fs";
import { ROUTES } from "../src/lib/router";
const rows = ROUTES().map((r) => `| \`${r.method}\` | \`${r.path}\` | ${r.permission} |`).join("\n");
const doc = fs.readFileSync("docs/API.md", "utf8").replace(/<!-- ROUTES:START -->[\s\S]*<!-- ROUTES:END -->/, `<!-- ROUTES:START -->\n| Method | Path | Permission |\n|---|---|---|\n${rows}\n<!-- ROUTES:END -->`);
fs.writeFileSync("docs/API.md", doc);
console.log(`${ROUTES().length} routes documented`);
