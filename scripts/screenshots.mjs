// Captures README screenshots from a running `burnrate demo` (http://127.0.0.1:4317).
import { createRequire } from "node:module";
const { chromium, devices } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE_URL || "http://127.0.0.1:4317";
const out = process.argv[2] || "docs/screenshots";
const browser = await chromium.launch();
const errors = [];
for (const [name, opts] of [
  ["dashboard-light", { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, colorScheme: "light" }],
  ["dashboard-dark", { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, colorScheme: "dark" }],
  ["dashboard-mobile", { ...devices["iPhone 14"], colorScheme: "dark" }],
]) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`${name}: ${m.text()}`));
  await page.goto(BASE);
  await page.waitForSelector("#today:not(:empty)");
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: name !== "dashboard-mobile" });
  if (name === "dashboard-light") {
    const col = page.locator("#daily-chart g.col").nth(-3);
    await col.hover();
    await page.waitForTimeout(150);
    await page.locator("#daily-chart").screenshot({ path: `${out}/tooltip.png` });
    await page.click("#settings-btn");
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${out}/settings.png` });
  }
  await ctx.close();
}
await browser.close();
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("screenshots saved to", out);
