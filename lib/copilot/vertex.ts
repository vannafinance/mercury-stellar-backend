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
  const out =
    parsed?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).filter(Boolean).join("") ??
    "";
  if (!out.trim()) throw new VertexError("Vertex returned empty explanation");
  return out.trim();
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
- enable_auto_sign | disable_auto_sign

RESTRICTED: liquidate (keeper-only unless user is liquidator)

Assets: XLM, USDC, BLUSDC, AQUSDC, SOUSDC, AQUA. Amounts = human decimals.
Earn uses G-wallet. Collateral/borrow/farm use C smart account.
"supply 10 XLM to Blend" → write op=deploy_to_blend (never deposit_collateral).
"supply 10 USDC to the highest-yielding pool" → write op=lend with amount 10;
  server ranks earn pools by APY then lends to the winner.
"list aquarius pools I can farm" → read vanna_list_aquarius_pools (server filters to 3).
`;

const ROUTE_SYSTEM = `You are Vanna Copilot — the NL interface for the Vanna Finance MCP on Stellar/Soroban.
Gemini's job is INTENT ONLY. Execution is always MCP (+ Sign Service auto-sign).
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
- "enable auto-sign" / "turn on auto sign" → auto_sign start.
- liquidate others → restricted.
- Hinglish and casual wording are fine.
- Do not claim you will ask for Freighter approval — execution uses MCP auto-sign.

CATALOG:
${TOOL_CATALOG}`;

/**
 * Ask Vertex to route a user message to a tool / write / clarify.
 */
export async function vertexSelectTool(
  message: string,
  ctx: { smartAccount?: string | null; trader?: string | null },
): Promise<RoutedIntent> {
  const user = [
    `USER MESSAGE: ${message}`,
    `CONTEXT: trader=${ctx.trader ?? "unknown"} smart_account=${ctx.smartAccount ?? "unknown"}`,
  ].join("\n");

  const data = await generateJson(ROUTE_SYSTEM, user);
  return normalizeRoute(data);
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

const EXPLAIN_SYSTEM = `You explain Vanna Finance MCP read results in plain English for a DeFi user.
Rules:
- Use ONLY numbers present in the DATA JSON. Never invent prices, APYs, balances, or health factors.
- Prefer human-readable fields (*_pct, *_usd, *_human, price_usd, exchange_rate) over raw wad integers.
- 2–4 short sentences max. No markdown headings. No code fences.
- If DATA has error/message, explain the failure clearly.`;

export async function vertexExplain(
  question: string,
  tool: string,
  data: Record<string, unknown>,
): Promise<string> {
  // Cap payload so we don't blow context with huge address dumps.
  const clipped = JSON.stringify(data).slice(0, 6000);
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
