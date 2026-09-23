/**
 * Fire the Test Prompt Catalogue at a LOCAL copilot and record what each row returns.
 *
 * Research only. This calls /api/copilot/investigate, which the route itself refuses to let
 * carry execution instructions or approval payloads, and never calls /workflow/propose,
 * /approve or /advance. Nothing here can sign or submit a transaction.
 *
 *   node scripts/catalogue/run.mjs [section|all] [--wallet G...]
 */
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

const ROWS = JSON.parse(readFileSync(new URL("./prompts.json", import.meta.url), "utf8"));
const args = process.argv.slice(2);
const section = (args[0] && !args[0].startsWith("--")) ? args[0] : "all";
const wIdx = args.indexOf("--wallet");
const wallet = wIdx >= 0 ? args[wIdx + 1] : null;
const BASE = process.env.COPILOT_BASE || "http://localhost:3000";
const OUT = new URL("./results.md", import.meta.url);

const picked = section === "all" ? ROWS : ROWS.filter(([, s]) => s === section);
if (!picked.length) { console.error("no rows for section", section); process.exit(1); }

function parseStream(text) {
  let result = null; const progress = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line.replace(/^data:\s*/, ""));
      if (o.type === "result") result = o.result;
      if (o.type === "progress") progress.push(o.event?.kind + (o.event?.label ? `:${o.event.label}` : ""));
    } catch { /* partial frame */ }
  }
  return { result, progress };
}

const header = `| id | prompt | status | understood as | borrowing | opts | ms | note |\n|---|---|---|---|---|---|---|---|\n`;
writeFileSync(OUT, `# Catalogue run — ${new Date().toISOString()}\n\nsection: ${section} · wallet: ${wallet ? wallet.slice(0,6)+"…"+wallet.slice(-4) : "none"}\n\n${header}`);

for (const [id, sec, prompt] of picked) {
  const started = Date.now();
  let row;
  try {
    const res = await fetch(`${BASE}/api/copilot/investigate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(wallet ? { message: prompt, wallet } : { message: prompt }),
      signal: AbortSignal.timeout(150_000),
    });
    const text = await res.text();
    const { result } = parseStream(text);
    if (!result) {
      let msg = text.slice(0, 160).replace(/\|/g, "/").replace(/\n/g, " ");
      row = { status: `HTTP ${res.status}`, obj: "—", bor: "—", opts: "—", note: msg };
    } else {
      const u = result.understanding || {};
      row = {
        status: result.status ?? "?",
        obj: (u.objective || "—").slice(0, 90),
        bor: u.borrowing ?? "—",
        opts: Array.isArray(result.options) ? result.options.length
             : Array.isArray(result.candidates) ? result.candidates.length : "—",
        note: (result.question ? `Q: ${result.question}` : (result.message || "")).slice(0, 140),
      };
    }
  } catch (e) {
    row = { status: "THREW", obj: "—", bor: "—", opts: "—", note: String(e.message || e).slice(0, 140) };
  }
  const ms = Date.now() - started;
  const cells = [id, prompt.slice(0, 64), row.status, row.obj, row.bor, row.opts, ms, row.note]
    .map((c) => String(c).replace(/\|/g, "/").replace(/\n/g, " "));
  appendFileSync(OUT, `| ${cells.join(" | ")} |\n`);
  console.log(`${id.padEnd(5)} ${String(row.status).padEnd(12)} ${String(ms).padStart(6)}ms  ${row.obj.slice(0,60)}`);
}
console.log("\nwrote", OUT.pathname);
