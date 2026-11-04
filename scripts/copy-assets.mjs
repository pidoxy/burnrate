import fs from "node:fs";
fs.mkdirSync("dist/dashboard", { recursive: true });
for (const f of fs.readdirSync("src/dashboard")) fs.copyFileSync(`src/dashboard/${f}`, `dist/dashboard/${f}`);
fs.chmodSync("dist/cli.js", 0o755);
