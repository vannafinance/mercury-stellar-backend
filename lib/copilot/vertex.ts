/**
 * Vertex AI (Gemini) client for the in-process copilot.
 *
 * Auth strategy (in order):
 *   1. Cached Bearer token
 *   2. ADC via google-auth-library (if valid)
 *   3. `gcloud auth print-access-token` (works when ADC is broken but user login is OK)
 *
 * Model default: gemini-3.6-flash on project vanna-mcp, location=global.
 * Uses the REST generateContent endpoint (no dependency on broken ADC alone).
 */

import { execFile } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { promisify } from "util";
import { copilotConfig } from "./config";
import type { RoutedIntent } from "./types";
import {
  FC_ROUTE_SYSTEM,
  ROUTER_TOOL_DECLS,
  guardIntent,
  intentFromFunctionCall,
} from "./vertex-tools";

const execFileAsync = promisify(execFile);

export class VertexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VertexError";
  }
}

let tokenCache: { token: string; expiryMs: number } | null = null;

/** Resolve gcloud on Windows/macOS — Next.js child processes often lack shell PATH. */
function resolveGcloudBin(): string | null {
  if (process.env.GCLOUD_PATH && existsSync(process.env.GCLOUD_PATH)) {
    return process.env.GCLOUD_PATH;
  }
  const local = process.env.LOCALAPPDATA || "";
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const candidates = [
    join(local, "Google", "Cloud SDK", "google-cloud-sdk", "bin", "gcloud.cmd"),
    join(local, "Google", "Cloud SDK", "google-cloud-sdk", "bin", "gcloud"),
    join(home, "AppData", "Local", "Google", "Cloud SDK", "google-cloud-sdk", "bin", "gcloud.cmd"),
    join(home, "google-cloud-sdk", "bin", "gcloud"),
    "/usr/local/bin/gcloud",
    "/opt/homebrew/bin/gcloud",
    "gcloud.cmd",
    "gcloud",
  ];
  for (const c of candidates) {
    if (c === "gcloud" || c === "gcloud.cmd") continue; // try bare last via PATH
    if (existsSync(c)) return c;
  }
  return process.platform === "win32" ? "gcloud.cmd" : "gcloud";
}

async function getAccessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiryMs) return tokenCache.token;

  // 1) google-auth-library ADC (works when application-default login is valid)
  try {
    const { GoogleAuth } = await import("google-auth-library");
    const auth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      projectId: copilotConfig.googleCloudProject,
    });
    const client = await auth.getClient();
    const res = await client.getAccessToken();
    if (res.token) {
      tokenCache = { token: res.token, expiryMs: Date.now() + 45 * 60_000 };
      return res.token;
    }
  } catch {
    /* fall through — ADC is often broken with invalid_rapt */
  }

  // 2) gcloud *user* credentials (gcloud auth login) — already works for aditya@vanna.finance
  // Prefer invoking gcloud.py via python so paths with spaces ("Cloud SDK") don't break.
  const errors: string[] = [];
  const tried = await tryGcloudAccessToken();
  if (tried.token) {
    tokenCache = { token: tried.token, expiryMs: Date.now() + 45 * 60_000 };
    return tried.token;
  }
  if (tried.error) errors.push(tried.error);

  throw new VertexError(
    `Could not get a Google access token. Tried ADC + gcloud. ` +
      `${errors.join(" | ")}. ` +
      `Fix: run  gcloud auth login  (account with Vertex on project vanna-mcp). ` +
      `You do NOT need application-default login if user login works.`,
  );
}

async function tryGcloudAccessToken(): Promise<{ token?: string; error?: string }> {
  const local = process.env.LOCALAPPDATA || "";
  const sdkRoot = join(local, "Google", "Cloud SDK", "google-cloud-sdk");
  const gcloudPy = join(sdkRoot, "lib", "gcloud.py");
  const bundledPy = join(sdkRoot, "platform", "bundledpython", "python.exe");
  const gcloudCmd = resolveGcloudBin();

  // Path A: python gcloud.py (no shell, handles spaces)
  if (existsSync(gcloudPy)) {
    const pyCandidates = [
      process.env.CLOUDSDK_PYTHON,
      existsSync(bundledPy) ? bundledPy : "",
      "python",
      "python3",
    ].filter(Boolean) as string[];

    for (const py of pyCandidates) {
      try {
        const { stdout, stderr } = await execFileAsync(
          py,
          [gcloudPy, "auth", "print-access-token"],
          {
            timeout: 25_000,
            windowsHide: true,
            env: {
              ...process.env,
              CLOUDSDK_ROOT_DIR: sdkRoot,
            },
            maxBuffer: 2 * 1024 * 1024,
          },
        );
        const token = (stdout || "").trim();
        if (token && token.length > 20 && !/ERROR/i.test(token.split("\n")[0] || "")) {
          return { token: token.split(/\r?\n/)[0]!.trim() };
        }
        if (stderr) return { error: `gcloud.py: ${stderr.slice(0, 200)}` };
      } catch (e) {
        // try next python
        if (py === pyCandidates[pyCandidates.length - 1]) {
          /* fall through to cmd */
        }
      }
    }
  }

  // Path B: quoted gcloud.cmd via cmd.exe /c (Windows spaces-safe)
  if (gcloudCmd && process.platform === "win32") {
    try {
      const { stdout, stderr } = await execFileAsync(
        "cmd.exe",
        ["/d", "/s", "/c", `"${gcloudCmd}" auth print-access-token`],
        {
          timeout: 25_000,
          windowsHide: true,
          env: process.env,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      const token = (stdout || "").trim().split(/\r?\n/)[0]?.trim() || "";
      if (token && token.length > 20 && !/ERROR/i.test(token)) return { token };
      return { error: `gcloud.cmd: ${(stderr || stdout || "empty").toString().slice(0, 200)}` };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  // Path C: bare gcloud on PATH (unix / fixed PATH)
  try {
    const { stdout } = await execFileAsync("gcloud", ["auth", "print-access-token"], {
      timeout: 25_000,
      windowsHide: true,
      env: process.env,
      maxBuffer: 2 * 1024 * 1024,
    });
    const token = (stdout || "").trim().split(/\r?\n/)[0]?.trim() || "";
    if (token && token.length > 20) return { token };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  return { error: "no gcloud token produced" };
}

function modelUrl(model: string): string {
  const project = copilotConfig.googleCloudProject;
  // Global endpoint (not {location}-aiplatform.googleapis.com)
  return (
    `https://aiplatform.googleapis.com/v1/projects/${project}` +
    `/locations/global/publishers/google/models/${model}:generateContent`
  );
}

// ── prompt-cache instrumentation ───────────────────────────────────────────
//
// Implicit caching is on by default for Gemini 2.5 and newer, so there is nothing to
// switch on — the only thing that matters is that the reused prefix comes FIRST and is
// byte-identical every call. That is why systemInstruction and the tool declarations
// hold every stable byte, and the per-turn wallet/account context lives in the user
// turn. One changed byte in the prefix silently drops the hit rate to zero with no
// error, so the counters below make it observable instead of a matter of faith.
//
// Minimums are per-model: below them a prefix is never cached at all.
const IMPLICIT_CACHE_MIN: Record<string, number> = {
  "gemini-2.5-flash": 2048,
  "gemini-2.5-pro": 2048,
  "gemini-3.5-flash": 4096,
  "gemini-3.1-pro": 4096,
};

/** Google documents 2048 for 2.5 and 4096 for 3.x; assume the stricter one when unlisted. */
function implicitCacheMin(model: string): number {
  for (const [prefix, min] of Object.entries(IMPLICIT_CACHE_MIN)) {
    if (model.startsWith(prefix)) return min;
  }
  return model.startsWith("gemini-2.5") ? 2048 : 4096;
}

let cacheFloorWarned = false;

/**
 * Log prompt/cached token counts for one call.
 *
 * The field name for cached tokens has moved between API revisions, so every spelling
 * we have seen is checked rather than assuming one and reporting a silent zero.
 */
function logUsage(tag: string, parsed: unknown): void {
  const meta = (parsed as { usageMetadata?: Record<string, unknown> } | null)?.usageMetadata;
  if (!meta) return;

  const int = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const promptTokens = int(meta.promptTokenCount);
  const cached =
    int(meta.cachedContentTokenCount) ||
    int(meta.cachedTokenCount) ||
    int(meta.totalCachedTokens) ||
    int((meta.promptTokensDetails as Record<string, unknown> | undefined)?.cachedTokenCount);

  const model = copilotConfig.vertexModel;
  const floor = implicitCacheMin(model);

  // Once per process: a prefix under the model's floor can never be cached, and the
  // shortfall is the actionable number — it says how much more stable prefix is needed.
  if (!cacheFloorWarned && promptTokens > 0 && promptTokens < floor) {
    cacheFloorWarned = true;
    console.warn(
      `[copilot:vertex] prompt is ${promptTokens} tokens but ${model} only caches prefixes ` +
        `from ${floor} — ${floor - promptTokens} short, so no cache discount applies yet.`,
    );
  }

  if (process.env.COPILOT_LOG) {
    const pct = promptTokens > 0 ? Math.round((cached / promptTokens) * 100) : 0;
    console.log(
      `[copilot:vertex] ${tag} prompt=${promptTokens} cached=${cached} (${pct}%) ` +
        `output=${int(meta.candidatesTokenCount)}`,
    );
  }
}

async function generateJson(system: string, user: string): Promise<Record<string, unknown>> {
  const token = await getAccessToken();
  const model = copilotConfig.vertexModel;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
    },
  };

  const res = await fetch(modelUrl(model), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
    cache: "no-store",
  });

  const text = await res.text();
  if (!res.ok) {
    // token might be stale
    if (res.status === 401 || res.status === 403) tokenCache = null;
    throw new VertexError(`Vertex ${model} HTTP ${res.status}: ${text.slice(0, 400)}`);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new VertexError(`Vertex returned non-JSON envelope: ${text.slice(0, 300)}`);
  }
  logUsage("route:json", parsed);

  const out =
    parsed?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).filter(Boolean).join("") ??
    "";
  if (!out.trim()) {
    throw new VertexError(
      `Vertex returned empty content (finishReason=${parsed?.candidates?.[0]?.finishReason ?? "?"})`,
    );
  }

  try {
    const data = JSON.parse(out);
    if (!data || typeof data !== "object") {
      throw new Error("not an object");
    }
    return data as Record<string, unknown>;
  } catch {
    throw new VertexError(`Vertex JSON parse failed: ${out.slice(0, 400)}`);
  }
}

async function generateText(system: string, user: string): Promise<string> {
  const token = await getAccessToken();
  const model = copilotConfig.vertexModel;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { temperature: 0.2 },
  };

  const res = await fetch(modelUrl(model), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) tokenCache = null;
    throw new VertexError(`Vertex ${model} HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  const parsed = JSON.parse(text);
  logUsage("explain", parsed);
  const out =
    parsed?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).filter(Boolean).join("") ??
    "";
  if (!out.trim()) throw new VertexError("Vertex returned empty explanation");
  return out.trim();
}

/**
 * One routing call using native function calling.
 *
 * The request is ordered stable-prefix-first so implicit caching can engage:
 * systemInstruction and the tool declarations never vary, and everything per-turn
 * (the message, the wallet, the smart account) sits in the user content.
 *
 * `responseMimeType` is deliberately absent — JSON response mode and function calling
 * are mutually exclusive, and setting both makes the model return neither.
 */
async function generateFunctionCall(
  system: string,
  user: string,
): Promise<{ name: string; args: Record<string, unknown> }> {
  const token = await getAccessToken();
  const model = copilotConfig.vertexModel;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    tools: [{ functionDeclarations: ROUTER_TOOL_DECLS }],
    // ANY forces a tool call, so there is no free-text branch to parse or to fail on.
    toolConfig: { functionCallingConfig: { mode: "ANY" } },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { temperature: 0 },
  };

  const res = await fetch(modelUrl(model), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
    cache: "no-store",
  });

  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) tokenCache = null;
    throw new VertexError(`Vertex ${model} function-call HTTP ${res.status}: ${text.slice(0, 400)}`);
  }

  interface FcPart {
    functionCall?: { name?: string; args?: Record<string, unknown> };
  }
  interface FcEnvelope {
    candidates?: Array<{ content?: { parts?: FcPart[] }; finishReason?: string }>;
  }

  let parsed: FcEnvelope;
  try {
    parsed = JSON.parse(text) as FcEnvelope;
  } catch {
    throw new VertexError(`Vertex returned non-JSON envelope: ${text.slice(0, 300)}`);
  }
  logUsage("route:fc", parsed);

  const parts = parsed?.candidates?.[0]?.content?.parts ?? [];
  const call = parts.find((p) => p?.functionCall)?.functionCall;
  if (!call?.name) {
    const finish = parsed?.candidates?.[0]?.finishReason ?? "?";
    throw new VertexError(
      `Vertex returned no functionCall (finishReason=${finish}): ${text.slice(0, 300)}`,
    );
  }
  return {
    name: String(call.name),
    args: (call.args ?? {}) as Record<string, unknown>,
  };
}

// ── tool catalog for routing ────────────────────────────────────────────────

const TOOL_CATALOG = `
READ tools (MCP):
- vanna_get_price {symbol}
- vanna_get_prices_batch {symbols[]}
- vanna_get_pool_stats {symbol}  (Vanna Earn)
- vanna_list_protocol_addresses {}
- vanna_get_collateral_config {}
- vanna_get_vtoken_exchange_rate {symbol}
- vanna_list_blend_reserves {} / vanna_get_blend_reserve_stats {symbol}
- vanna_get_account_health {smart_account}
- vanna_get_collateral / vanna_get_debt {smart_account}
- vanna_get_vtoken_balance {holder, symbol}
- vanna_can_borrow / vanna_can_withdraw {smart_account, symbol, amount}
- vanna_get_max_borrow {smart_account, symbol}
- vanna_resolve_account {trader}
- vanna_list_smart_accounts {wallet_address}
- vanna_get_wallet_balance {g_address}
- vanna_list_aquarius_pools {} / vanna_get_aquarius_pool_stats
- vanna_get_farm_overview / vanna_get_blend_position / vanna_get_lp_balance {smart_account}

WRITE ops (MCP executes; Sign Service auto-signs when enabled):
- create_account | lend | redeem | deposit_collateral | withdraw_collateral
- borrow | repay | deposit_and_borrow | settle_account | close_account
- deploy_to_blend (Farm: "supply X to Blend" / leverage farm — NOT deposit_collateral)
- add_liquidity | remove_liquidity (Aquarius/Soroswap LP — AQUSDC ≠ BLUSDC)
- swap (DEX via margin account free balance)
- enable_auto_sign | disable_auto_sign

AGENT-LEVEL UNDERSTANDING (intent, not word-match):
- “earn me yield / invest for max profit / put my bag where it pays most” → lend or
  farm with prefer highest APY; server ranks live Earn (+ Blend if farm named).
- “keep HF above 1.5 / avoid liquidation at all costs” → set risk floor; block writes
  that project below that HF; on health reads warn if already low.
- “swap 10 XLM to AQUSDC” → write op=swap.
- BLUSDC, AQUSDC, SOUSDC are DIFFERENT tokens — never treat as interchangeable.
- Do NOT invent numbers; do NOT invent C-addresses.

RESTRICTED: liquidate (keeper-only unless user is liquidator)

VENUE RULES — never cross these. Earn and Farm are different products:
- EARN = Vanna's own lending pools (XLM, BLUSDC, AQUSDC, SOUSDC), tool vanna_get_pool_stats.
- FARM = external venues: Blend (vanna_*_blend_*) and Aquarius/Soroswap LP (vanna_*_aquarius_* / lp).
- The words "pool", "lending pool", "earn pool", "the USDC pool", "the XLM pool" with NO
  venue named ALWAYS mean the Vanna EARN pool → vanna_get_pool_stats. Never answer these
  from Blend or Aquarius.
- Use a Blend tool ONLY when the user says "Blend" or "bToken". Use an Aquarius/LP tool
  ONLY when the user says "Aquarius", "Soroswap", "LP" or a pair like "XLM/USDC".
- "how much liquidity is available to borrow from the XLM pool" → vanna_get_pool_stats
  {symbol:"XLM"} (Earn). It is NOT a Blend reserve question.
- "compare the XLM and USDC pools" → Earn pools. Emit read with symbol "__ALL_EARN__".
- "borrow APY on AQUSDC" → Earn pool AQUSDC via vanna_get_pool_stats. AQUSDC is a real
  Earn pool even though Blend only lists XLM and USDC.
- Questions ABOUT Blend are still READS: "which Blend reserve pays more, XLM or USDC?" →
  read vanna_list_blend_reserves. Never turn a comparison question into deploy_to_blend
  or any write.
- Comparing TWO OR MORE Blend reserves needs both sides, so use vanna_list_blend_reserves
  (returns every reserve), NOT vanna_get_blend_reserve_stats (one symbol only) — the
  single-symbol tool cannot answer "which pays more".
- If the user asks for an APY/APR with NO pool AND no venue ("what's the APY?"), emit
  kind=clarify asking which pool and which venue — do not guess one.

Assets: XLM, BLUSDC, AQUSDC, SOUSDC, AQUA (and legacy alias USDC = ambiguous).
Earn uses G-wallet. Collateral/borrow/farm use C smart account.
There are THREE distinct USDC tokens (not interchangeable): BLUSDC, AQUSDC, SOUSDC.
If the user says only "USDC" without a variant, still emit write with asset "USDC"
  so the server can ask which variant — do NOT invent BLUSDC/AQUSDC/SOUSDC.
"supply 10 XLM to Blend" → write op=deploy_to_blend (never deposit_collateral).
"supply 10 USDC to the highest-yielding pool" → write op=lend amount 10 asset USDC;
  server ranks earn pools then may still ask USDC variant if needed.
"list aquarius pools I can farm" → read vanna_list_aquarius_pools (server filters to
  Vanna's farmable pairs: XLM/USDC and XLM/USDT — there is no XLM/AQUA pool).
`;

const ROUTE_SYSTEM = `You are Vanna Copilot — the NL interface for the Vanna Finance MCP on Stellar/Soroban.
Gemini's job is INTENT ONLY — understand freely (Hinglish, slang, long multi-goal prompts).
Do NOT require canned phrases. Map meaning to tools/ops even when the user is vague or verbose.
Execution is always MCP (+ Sign Service auto-sign). Never invent APYs, balances, or C-addresses.
Risk / health-factor / spend caps are enforced by MCP and Sign Service — never invent blocks.

Respond ONLY with JSON, one of:

READ (single market/account question):
{"kind":"read","tool":"<mcp_tool>","args":{...},"requires_account":boolean,"template_id":"<id>"}

WRITE (single action the user wants done now):
{"kind":"write","op":"<op>","asset":"XLM"|null,"amount":number|null,"multi_leg":boolean,"requires_account":boolean,"requires_amount":boolean,"template_id":"<op>","leverage":number|null,"deposit_amount":number|null,"borrow_amount":number|null}

PLAN (complex / multi-step strategy — e.g. deposit, keep HF, farm yield, rebalance):
{"kind":"plan","template_id":"strategy","summary":"one line","steps":[
  {"kind":"read","tool":"vanna_get_pool_stats","args":{"symbol":"USDC"}},
  {"kind":"write","op":"deposit_collateral","asset":"XLM","amount":10},
  {"kind":"write","op":"borrow","asset":"USDC","amount":5}
]}

AUTO_SIGN:
{"kind":"auto_sign","action":"start"|"use_defaults"|"custom"|"disable","template_id":"auto_sign","max_per_tx_usd":null,"max_per_day_usd":null}

RESTRICTED:
{"kind":"restricted","reason":"...","template_id":"liquidate"}

CLARIFY (missing amount/asset that cannot be defaulted):
{"kind":"clarify","message":"...","template_id":null}

Rules:
- Questions → read. Imperatives ("deposit", "lend", "borrow", "farm") → write or plan.
- Complex goals (maintain HF, keep earning, rebalance, multi-venue) → kind=plan with ordered steps.
- Prefer real MCP tool names for reads. Prefer op names for writes.
- Never invent amounts. If amount missing on a write, still emit write with amount:null so the server asks.
- "enable auto-sign" / "turn on auto approve" → auto_sign start (MCP default $1000/tx · $1000/day).
- "set auto-sign cap to 500 per tx and 2000 per day" → auto_sign custom.
- "use default auto-sign caps" → auto_sign use_defaults.
- "swap 20 XLM to USDC via aquarius" → write op=swap (server quotes expected_out via oracle).
- liquidate others → restricted.
- Hinglish and casual wording are fine.
- Do not claim you will ask for Freighter approval — execution uses MCP auto-sign.

CATALOG:
${TOOL_CATALOG}`;

/**
 * Ask Vertex to route a user message to a tool / write / clarify.
 *
 * Two paths:
 *   - "fc" (default) — native function calling. Tool names and argument values are
 *     constrained by schema, so an invalid tool or a non-existent pool cannot come back.
 *   - "json" — the original prose-catalogue path, kept as a fallback.
 *
 * The fc path falls back to json automatically on a transport/shape failure and logs
 * why, so a schema the endpoint rejects degrades to the previous behaviour instead of
 * taking the copilot down. Set COPILOT_ROUTER=json to pin the old path.
 *
 * guardIntent() runs on BOTH paths: the venue and read-vs-write rules are plain code and
 * are worth having regardless of which model produced the choice.
 */
export async function vertexSelectTool(
  message: string,
  ctx: { smartAccount?: string | null; trader?: string | null },
): Promise<RoutedIntent> {
  // Per-turn context goes last, after the stable cached prefix.
  const user = [
    `USER MESSAGE: ${message}`,
    `CONTEXT: trader=${ctx.trader ?? "unknown"} smart_account=${ctx.smartAccount ?? "unknown"}`,
  ].join("\n");

  if (copilotConfig.router === "fc") {
    try {
      const call = await generateFunctionCall(FC_ROUTE_SYSTEM, user);
      const routed = intentFromFunctionCall(call.name, call.args);
      if (routed) return applyGuards(routed, message, `fc:${call.name}`);
      // A name outside our table means the schema and the table have drifted. Fall
      // through rather than mis-route on a guess.
      console.warn(`[copilot:vertex] unknown function "${call.name}" — falling back to JSON router`);
    } catch (e) {
      console.warn(
        `[copilot:vertex] function-call routing failed, falling back to JSON router: ` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  const data = await generateJson(ROUTE_SYSTEM, user);
  return applyGuards(normalizeRoute(data), message, "json");
}

function applyGuards(intent: RoutedIntent, message: string, source: string): RoutedIntent {
  const { intent: guarded, corrections } = guardIntent(intent, message);
  if (corrections.length) {
    console.warn(`[copilot:vertex] ${source} corrected — ${corrections.join("; ")}`);
  }
  return guarded;
}

function normalizeRoute(data: Record<string, unknown>): RoutedIntent {
  const kind = String(data.kind ?? "");

  if (kind === "read") {
    const tool = String(data.tool ?? "");
    if (!tool.startsWith("vanna_")) {
      return { kind: "clarify", message: "I couldn't map that to a Vanna tool. Try rephrasing." };
    }
    const args =
      data.args && typeof data.args === "object" && !Array.isArray(data.args)
        ? (data.args as Record<string, unknown>)
        : {};
    return {
      kind: "read",
      tool,
      args,
      requires_account: !!data.requires_account,
      template_id: String(data.template_id ?? tool),
    };
  }

  if (kind === "plan" && Array.isArray(data.steps)) {
    return {
      kind: "plan",
      template_id: String(data.template_id ?? "strategy"),
      summary: data.summary != null ? String(data.summary) : undefined,
      steps: (data.steps as any[]).map((s) => ({
        kind: s.kind === "write" ? "write" : "read",
        tool: s.tool != null ? String(s.tool) : undefined,
        op: s.op != null ? String(s.op) : undefined,
        args: s.args && typeof s.args === "object" ? s.args : {},
        asset: s.asset != null ? String(s.asset).toUpperCase() : null,
        amount: s.amount != null && s.amount !== "" ? Number(s.amount) : null,
      })),
    };
  }

  if (kind === "auto_sign") {
    const action = String(data.action || "start") as "start" | "use_defaults" | "custom" | "disable";
    return {
      kind: "auto_sign",
      action: ["start", "use_defaults", "custom", "disable"].includes(action) ? action : "start",
      template_id: "auto_sign",
      max_per_tx_usd: (data.max_per_tx_usd as any) ?? undefined,
      max_per_day_usd: (data.max_per_day_usd as any) ?? undefined,
    };
  }

  if (kind === "write") {
    const op = String(data.op ?? "");
    const allowed = new Set([
      "create_account",
      "lend",
      "redeem",
      "deposit_collateral",
      "withdraw_collateral",
      "borrow",
      "repay",
      "deposit_and_borrow",
      "deploy_to_blend",
      "supply_to_blend",
      "settle_account",
      "close_account",
      "enable_auto_sign",
      "disable_auto_sign",
    ]);
    if (!allowed.has(op)) {
      return {
        kind: "clarify",
        message: `I don't support the action “${op}” yet. Try lend, deposit collateral, borrow, repay, supply to Blend, or enable auto-sign.`,
      };
    }
    const amount = data.amount == null || data.amount === "" ? null : Number(data.amount);
    const requiresAccount = !["create_account", "lend", "redeem", "enable_auto_sign", "disable_auto_sign"].includes(op);
    return {
      kind: "write",
      op,
      asset: data.asset != null ? String(data.asset).toUpperCase() : null,
      amount: Number.isFinite(amount as number) && (amount as number) > 0 ? (amount as number) : null,
      multi_leg: !!data.multi_leg || op === "deposit_and_borrow" || op === "deploy_to_blend" || op === "supply_to_blend",
      requires_account: requiresAccount,
      requires_amount: !["create_account", "enable_auto_sign", "disable_auto_sign", "settle_account", "close_account"].includes(op),
      template_id: String(data.template_id ?? op),
      leverage: data.leverage != null ? Number(data.leverage) : null,
      deposit_amount: data.deposit_amount != null ? Number(data.deposit_amount) : null,
      borrow_amount: data.borrow_amount != null ? Number(data.borrow_amount) : null,
    };
  }

  if (kind === "restricted") {
    return {
      kind: "restricted",
      reason: String(data.reason ?? "That action is restricted."),
      template_id: String(data.template_id ?? "restricted"),
    };
  }

  return {
    kind: "clarify",
    message: String(
      data.message ??
        "I can read markets/accounts and execute via MCP + auto-sign (lend, deposit, borrow, repay, farm plans). What do you want?",
    ),
    template_id: (data.template_id as string) ?? null,
  };
}

const EXPLAIN_SYSTEM = `You explain Vanna Finance MCP read results in plain English for a DeFi user
who may be new to lending and margin.

ANSWER SHAPE — follow exactly:
- Sentence 1 answers the question directly, leading with the number asked for.
- Then, only if there are 3 or more further figures worth showing, add a short labelled
  list, one per line, each starting "• " as "• Label: value". Otherwise stay in prose.
- Finish after at most 2 sentences of context. Never pad.

NUMBER FORMATTING — the single most important rule for readability:
- Percentages: 2 decimals with the sign, e.g. "6.41%". Never more.
- Token amounts: at most 4 decimals, and drop trailing zeros — "6,800.572" not
  "6800.572050800000000000".
- USD: 2 decimals with a $ and thousands separators, e.g. "$1,146.03".
- Thousands separators on anything 1,000 or larger.
- A health factor is a bare ratio to 2 decimals, e.g. "2.14", or "∞" when there is no debt.
- NEVER print more than 4 decimal places for any value, under any circumstances.

STYLE:
- Plain text only. No markdown: no **bold**, no ##, no tables, no code fences.
  Asterisks are shown literally to the user, so they look like a bug.
- Name the venue when it matters ("the Vanna earn pool", "the Blend reserve") so the user
  is never unsure which product a number came from.
- Use ONLY numbers present in the DATA JSON. Never invent prices, APYs, balances or
  health factors, and never restate a number at higher precision than DATA gives.
- Prefer human-readable fields (*_pct, *_usd, *_human, price_usd, exchange_rate) over raw
  wad integers. If a field is only available as a wad integer, omit it rather than guess.
- If DATA carries an error or an unavailable venue, say plainly what failed and that no
  figure is available. Do not substitute a number from elsewhere.`;

/** Percent-ish fields read best at 2dp; everything else at 4dp. */
function decimalsFor(key: string): number {
  return /(_pct|pct|apy|apr|rate|utilization|ratio)$|apy|apr|utilization/i.test(key) ? 2 : 4;
}

/**
 * Round long decimals out of an MCP payload before the model sees it.
 *
 * MCP returns contract-precision strings like "14.977890082244174400" and
 * "6800.572050800000000000". Gemini faithfully echoes whatever it is given, so asking
 * it to round in the prompt is unreliable — the fix has to be deterministic. Rounding
 * here also shortens the payload, which keeps more of a large response inside the clip
 * limit below. Non-numeric values (symbols, addresses, notes) pass through untouched.
 */
function roundForProse(value: unknown, key = ""): unknown {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number(value.toFixed(decimalsFor(key)));
  }
  if (typeof value === "string") {
    // Only touch strings that are purely a number — never symbols or C…/G… addresses.
    if (!/^-?\d+(\.\d+)?$/.test(value.trim())) return value;
    const n = Number(value);
    if (!Number.isFinite(n)) return value;
    return Number(n.toFixed(decimalsFor(key)));
  }
  if (Array.isArray(value)) return value.map((v) => roundForProse(v, key));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = roundForProse(v, k);
    }
    return out;
  }
  return value;
}

export async function vertexExplain(
  question: string,
  tool: string,
  data: Record<string, unknown>,
): Promise<string> {
  // Round first, then cap: the payload shrinks a lot once 18-decimal strings are gone.
  const tidy = roundForProse(data) as Record<string, unknown>;
  const clipped = JSON.stringify(tidy).slice(0, 6000);
  const user = `QUESTION: ${question}\nTOOL: ${tool}\nDATA:\n${clipped}`;
  return generateText(EXPLAIN_SYSTEM, user);
}

/** Cheap health probe used by /api/copilot GET */
export async function vertexPing(): Promise<{ ok: boolean; model: string; error?: string }> {
  try {
    const token = await getAccessToken();
    const model = copilotConfig.vertexModel;
    const res = await fetch(modelUrl(model), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: 'Reply JSON: {"ok":true}' }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json", maxOutputTokens: 32 },
      }),
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    });
    if (!res.ok) {
      const t = await res.text();
      return { ok: false, model, error: `HTTP ${res.status}: ${t.slice(0, 200)}` };
    }
    return { ok: true, model };
  } catch (e) {
    return {
      ok: false,
      model: copilotConfig.vertexModel,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
