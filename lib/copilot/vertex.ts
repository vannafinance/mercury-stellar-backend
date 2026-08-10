/**
 * Vertex AI (Gemini) client for the in-process copilot.
 *
 * NO END USER EVER AUTHENTICATES WITH GOOGLE HERE. Every call below runs server-side on
 * behalf of the project; the credential is the app's, not the visitor's. So the only
 * question this file answers is which credential the SERVER presents.
 *
 * Auth strategy (in order):
 *   1. Cached Bearer token
 *   2. Workload Identity Federation — keyless, nothing to rotate. Production answer.
 *   3. Service-account key from GOOGLE_SERVICE_ACCOUNT_JSON. One secret, set once.
 *   4. ADC via google-auth-library (if valid)
 *   5. `gcloud auth print-access-token`
 *
 * WHY 4 AND 5 ARE LAST, AND WHY THEY ARE NOT ENOUGH ON THEIR OWN
 *
 * Both resolve to a credential belonging to whoever is sitting at the machine. That made
 * the copilot's understanding a per-developer property: on a checkout whose `gcloud auth
 * login` had lapsed, every routing call threw and the turn fell back to keyword matching,
 * so the same prompt answered on one laptop and returned the capability blurb on another.
 * Neither exists at all on a serverless host — there is no gcloud binary and no ADC file on
 * Vercel — so a deployment could never route with the model. They stay only so an existing
 * local checkout keeps working before someone sets a real credential.
 *
 * WHY 2 IS AHEAD OF 3
 *
 * A service-account key is a private key living in an env var: it works everywhere and
 * never expires, which is exactly what makes it worth stealing, and rotating it means
 * touching every place it was pasted. Federation removes the key entirely — the host mints
 * a short OIDC token proving which deployment is running, Google's STS trades it for an
 * access token, and there is nothing durable to leak. When a deploy has both configured,
 * the one that cannot leak should win.
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
import {
  ANSWER_RESPONSE_SCHEMA,
  ANSWER_SYSTEM,
  normalizeAnswer,
  type AnswerFact,
  type StructuredAnswer,
} from "./answer-schema";
import {
  GUIDE_RESPONSE_SCHEMA,
  GUIDE_SYSTEM,
  normalizeGuideAnswer,
  type GuideAnswer,
} from "./guide-schema";

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

/**
 * The service-account key, if one is configured.
 *
 * Accepts raw JSON or base64 — Vercel's env editor and most CI secret stores handle a
 * single-line base64 blob without mangling it, while a pasted multi-line JSON key often
 * arrives with its newlines escaped or stripped. Supporting both means whichever form the
 * key was pasted in, it works.
 *
 * A malformed value throws rather than falling through silently: an unusable key that
 * degrades to keyword routing is the failure this whole path exists to remove, so it has to
 * be loud.
 */
function serviceAccountCredentials(): { client_email: string; private_key: string } | null {
  const raw = (
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON ||
    ""
  ).trim();
  if (!raw) return null;

  const text = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  let parsed: { client_email?: string; private_key?: string };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new VertexError(
      "GOOGLE_SERVICE_ACCOUNT_JSON is set but is neither JSON nor base64-encoded JSON. " +
        "Paste the whole service-account key file, or its base64.",
    );
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new VertexError(
      "GOOGLE_SERVICE_ACCOUNT_JSON parsed but has no client_email / private_key. " +
        "That is not a service-account key file.",
    );
  }
  return {
    client_email: parsed.client_email,
    // Env vars cannot carry real newlines in most dashboards, so a pasted key usually
    // arrives with literal "\n" two-character sequences. Left as-is the PEM will not parse.
    private_key: parsed.private_key.replace(/\\n/g, "\n"),
  };
}

/**
 * Workload Identity Federation config, if the deploy is set up for it.
 *
 * This is the keyless option, and the one to prefer in production: the host mints a short
 * OIDC token proving which deployment is running, Google's Security Token Service trades it
 * for an access token, and no private key exists anywhere to leak, rotate or accidentally
 * commit. On Vercel the OIDC token arrives per-request as `VERCEL_OIDC_TOKEN`.
 *
 * `subjectToken` is read lazily on every exchange rather than captured once, because the
 * host's OIDC token is short-lived and is refreshed underneath us.
 */
function workloadIdentityConfig(): {
  audience: string;
  serviceAccount: string | null;
  subjectTokenEnvVar: string;
} | null {
  const audience = (process.env.GOOGLE_WORKLOAD_IDENTITY_AUDIENCE || "").trim();
  if (!audience) return null;
  return {
    audience,
    // Impersonation is optional: a pool can grant roles/aiplatform.user to the federated
    // identity directly. Setting it is the more common shape, because IAM on a service
    // account is easier to audit than IAM on a pool principal.
    serviceAccount: (process.env.GOOGLE_WORKLOAD_IDENTITY_SERVICE_ACCOUNT || "").trim() || null,
    // Overridable so this is not Vercel-only — Cloud Run, GitHub Actions and Netlify all
    // expose an OIDC token under their own name.
    subjectTokenEnvVar: (process.env.GOOGLE_OIDC_TOKEN_ENV || "VERCEL_OIDC_TOKEN").trim(),
  };
}

/**
 * Which credential the copilot will route with, without attempting a token exchange.
 *
 * Reported in the brain-health chip. The point is that "this machine is routing on a
 * developer login" has to be visible BEFORE the login expires — once it does, the Vertex
 * call throws and understanding silently drops to keyword matching, which is the failure
 * that made the same prompt answer on one laptop and not another.
 */
export function vertexAuthMode(): "workload_identity" | "service_account" | "developer_login" {
  const wif = workloadIdentityConfig();
  if (wif && (process.env[wif.subjectTokenEnvVar] || "").trim()) return "workload_identity";
  if (
    (
      process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON ||
      ""
    ).trim()
  ) {
    return "service_account";
  }
  return "developer_login";
}

/** @deprecated Prefer vertexAuthMode() — kept so callers reading a boolean still compile. */
export function hasVertexServiceAccount(): boolean {
  return vertexAuthMode() !== "developer_login";
}

async function getAccessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiryMs) return tokenCache.token;

  // 0) Workload Identity Federation — keyless, and therefore the best production answer:
  //    nothing to rotate and no private key in an env var. Ahead of the service-account key
  //    so a deploy that has both configured uses the credential that cannot leak.
  //
  //    Skipped silently when the host did not supply an OIDC token, because that is the
  //    normal state on a laptop — a local checkout is expected to fall through to the key.
  const wif = workloadIdentityConfig();
  const subjectToken = wif ? (process.env[wif.subjectTokenEnvVar] || "").trim() : "";
  if (wif && subjectToken) {
    const { ExternalAccountClient } = await import("google-auth-library");
    const client = ExternalAccountClient.fromJSON({
      type: "external_account",
      audience: wif.audience,
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      ...(wif.serviceAccount
        ? {
            service_account_impersonation_url:
              `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/` +
              `${wif.serviceAccount}:generateAccessToken`,
          }
        : {}),
      subject_token_supplier: {
        // Re-read the env var per exchange: the host rotates this token, and a value
        // captured at module load would be stale by the second cold start.
        getSubjectToken: async () =>
          (process.env[wif.subjectTokenEnvVar] || "").trim() || subjectToken,
      },
    });
    if (!client) {
      throw new VertexError(
        "GOOGLE_WORKLOAD_IDENTITY_AUDIENCE is set but google-auth-library would not build an " +
          "external-account client from it. Expected the full provider resource name, e.g. " +
          "//iam.googleapis.com/projects/<num>/locations/global/workloadIdentityPools/<pool>/providers/<provider>",
      );
    }
    client.scopes = ["https://www.googleapis.com/auth/cloud-platform"];
    const res = await client.getAccessToken();
    if (!res.token) {
      throw new VertexError(
        `Workload Identity Federation exchange returned no access token for audience ` +
          `${wif.audience}. Check the pool's attribute mapping and condition accept this ` +
          `deployment, and that ${wif.serviceAccount ?? "the federated principal"} has ` +
          `roles/aiplatform.user on ${copilotConfig.googleCloudProject}.`,
      );
    }
    tokenCache = { token: res.token, expiryMs: Date.now() + 45 * 60_000 };
    return res.token;
  }

  // 1) Service account — machine-independent, and the only option that exists on a
  //    serverless host. Deliberately ahead of ADC: when both are present the project's
  //    own credential should win over whatever the developer happens to be logged in as.
  const sa = serviceAccountCredentials();
  if (sa) {
    const { GoogleAuth } = await import("google-auth-library");
    const auth = new GoogleAuth({
      credentials: sa,
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      projectId: copilotConfig.googleCloudProject,
    });
    const client = await auth.getClient();
    const res = await client.getAccessToken();
    if (!res.token) {
      throw new VertexError(
        `Service account ${sa.client_email} produced no access token. Check that it exists ` +
          `and has roles/aiplatform.user on project ${copilotConfig.googleCloudProject}.`,
      );
    }
    tokenCache = { token: res.token, expiryMs: Date.now() + 45 * 60_000 };
    return res.token;
  }

  // 2) google-auth-library ADC (works when application-default login is valid)
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

  // 3) gcloud *user* credentials (gcloud auth login) — a local convenience only.
  // Prefer invoking gcloud.py via python so paths with spaces ("Cloud SDK") don't break.
  const errors: string[] = [];
  const tried = await tryGcloudAccessToken();
  if (tried.token) {
    tokenCache = { token: tried.token, expiryMs: Date.now() + 45 * 60_000 };
    return tried.token;
  }
  if (tried.error) errors.push(tried.error);

  throw new VertexError(
    `Could not get a Google access token. Tried workload identity, service account, ADC ` +
      `and gcloud. ${errors.join(" | ")}. ` +
      `Production fix (keyless, nothing to rotate): set GOOGLE_WORKLOAD_IDENTITY_AUDIENCE ` +
      `to the provider resource name and let the host supply its OIDC token. ` +
      `Simpler fix that also works locally: set GOOGLE_SERVICE_ACCOUNT_JSON to a key with ` +
      `roles/aiplatform.user on project ${copilotConfig.googleCloudProject}. ` +
      `Local stopgap only: run  gcloud auth login  with an account that has Vertex access.`,
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
        `output=${int(meta.candidatesTokenCount)}` +
        (int(meta.thoughtsTokenCount) ? ` thoughts=${int(meta.thoughtsTokenCount)}` : ""),
    );
  }
}

/** JSON-mode Vertex call — used by router + LLM strategy planner. */
export async function generateJson(system: string, user: string): Promise<Record<string, unknown>> {
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

/** Models to try: primary first, then fallbacks (handles wrong/retired model ids). */
function modelCandidates(): string[] {
  return [copilotConfig.vertexModel, ...copilotConfig.vertexModelFallbacks];
}

/**
 * Turn thinking down for calls that only FORMAT numbers we already have.
 *
 * Gemini 3.x thinks by default. Measured here: explaining an oracle price cost
 * `output=48 thoughts=515` — eleven times as many tokens deciding how to say "XLM is
 * $0.1642" as saying it, and ~3s of the 4.6s that question took end to end, against ~1s
 * for the MCP read behind it. There is nothing to reason about: the figures are already
 * fetched, verified and rounded, and the schema fixes the shape.
 *
 * Deliberately NOT applied to routing, planning or function-calling. Those choose which
 * tool runs and how a strategy decomposes, and a wrong choice there is a wrong ACTION —
 * latency is the right thing to trade for correctness in that direction and the wrong
 * thing to trade in this one.
 *
 * Field name differs by generation and sending both is rejected, so it is selected by
 * model family; callers retry without it if the API refuses.
 */
function lowThinkingConfig(model: string): Record<string, unknown> | null {
  if (/^gemini-3/.test(model)) return { thinkingLevel: "low" };
  if (/^gemini-2\.5/.test(model)) return { thinkingBudget: 0 };
  return null; // 2.0 and older do not think; sending the field 400s.
}

/** True when a Vertex error is the API rejecting the thinking field itself. */
function isThinkingConfigRejection(msg: string): boolean {
  return /HTTP 400/.test(msg) && /thinking|thinkingLevel|thinkingBudget/i.test(msg);
}

async function generateTextOnce(
  model: string,
  system: string,
  user: string,
  temperature: number,
  opts?: { lowThinking?: boolean },
): Promise<string> {
  const token = await getAccessToken();
  const thinking = opts?.lowThinking ? lowThinkingConfig(model) : null;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: {
      temperature,
      ...(thinking ? { thinkingConfig: thinking } : {}),
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

/** Plain-text generation used by the page assistant and vertexExplain. */
export async function generateText(
  system: string,
  user: string,
  opts?: { temperature?: number; lowThinking?: boolean },
): Promise<string> {
  const temperature = opts?.temperature ?? 0.2;
  const errors: string[] = [];
  for (const model of modelCandidates()) {
    try {
      return await generateTextOnce(model, system, user, temperature, {
        lowThinking: opts?.lowThinking,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Model works, just dislikes the field: retry it rather than dropping to a weaker one.
      if (opts?.lowThinking && isThinkingConfigRejection(msg)) {
        console.warn(`[copilot:vertex] ${model} rejected thinkingConfig — retrying without it`);
        try {
          return await generateTextOnce(model, system, user, temperature);
        } catch (retryErr) {
          errors.push(retryErr instanceof Error ? retryErr.message : String(retryErr));
          continue;
        }
      }
      errors.push(msg);
      // Only fall through on not-found / unavailable / model errors
      if (!/HTTP 404|HTTP 400|not found|NOT_FOUND|unsupported|does not exist|invalid model/i.test(msg)) {
        throw e instanceof VertexError ? e : new VertexError(msg);
      }
      console.warn(`[copilot:vertex] model ${model} failed, trying fallback: ${msg.slice(0, 120)}`);
    }
  }
  throw new VertexError(`All Vertex models failed: ${errors.join(" | ").slice(0, 500)}`);
}

export type ClientToolDecl = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

/**
 * Page-agent generation: AUTO function calling for client tools + free text.
 * Returns prose and zero or more client tool calls for the browser to execute.
 */
export async function generateWithClientTools(
  system: string,
  user: string,
  toolDecls: ClientToolDecl[],
): Promise<{
  text: string;
  client_tools: Array<{ name: string; args: Record<string, unknown> }>;
}> {
  const token = await getAccessToken();
  const model = copilotConfig.vertexModel;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    tools: [{ functionDeclarations: toolDecls }],
    // AUTO: model may answer in text and/or call tools (Gemini side-panel style)
    toolConfig: { functionCallingConfig: { mode: "AUTO" } },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { temperature: 0.35 },
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
  const raw = await res.text();
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) tokenCache = null;
    // Fallback: plain text without tools if schema rejected
    console.warn(`[copilot:vertex] client-tools HTTP ${res.status}, falling back to generateText`);
    const textOnly = await generateText(system, user, { temperature: 0.35 });
    return { text: textOnly, client_tools: [] };
  }

  let parsed: {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string; functionCall?: { name?: string; args?: Record<string, unknown> } }> };
      finishReason?: string;
    }>;
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new VertexError(`Vertex client-tools non-JSON: ${raw.slice(0, 300)}`);
  }
  logUsage("page-agent:fc", parsed);

  const parts = parsed?.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .map((p) => p.text)
    .filter(Boolean)
    .join("")
    .trim();
  const client_tools = parts
    .filter((p) => p.functionCall?.name)
    .map((p) => ({
      name: String(p.functionCall!.name),
      args: (p.functionCall!.args ?? {}) as Record<string, unknown>,
    }));

  if (!text && client_tools.length === 0) {
    throw new VertexError(
      `Vertex page-agent empty (finishReason=${parsed?.candidates?.[0]?.finishReason ?? "?"})`,
    );
  }
  return { text, client_tools };
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

PLAN (complex / multi-step strategy — e.g. park for yield THEN farm, keep HF, rebalance):
{"kind":"plan","template_id":"strategy","summary":"one line","steps":[
  {"kind":"write","op":"lend","asset":"XLM","amount":20},
  {"kind":"write","op":"deploy_to_blend","asset":"BLUSDC","amount":10,"args":{"leverage":2}}
]}

AUTO_SIGN:
{"kind":"auto_sign","action":"start"|"use_defaults"|"custom"|"disable","template_id":"auto_sign","max_per_tx_usd":null,"max_per_day_usd":null}

RESTRICTED:
{"kind":"restricted","reason":"...","template_id":"liquidate"}

CLARIFY (missing amount/asset that cannot be defaulted):
{"kind":"clarify","message":"...","template_id":null}

Rules:
- Questions → read. Imperatives ("deposit", "lend", "borrow", "farm") → write or plan.
- Complex goals (maintain HF, keep earning, rebalance, multi-venue, park THEN farm) → kind=plan with ordered steps.
- Prefer real MCP tool names for reads. Prefer op names for writes.
- Never invent amounts. Amounts ONLY from explicit "N ASSET" (e.g. "20 XLM", "10 BLUSDC").
- NEVER use a health-factor floor as an amount. "keep HF above 1.4" → not amount 1.4; put min_hf in summary only.
- Leverage "2x" / "at 2×" goes in args.leverage on farm/deploy steps — not as amount.
- Park / lend for yield → op=lend. Farm Blend at Nx → op=deploy_to_blend with leverage.
- If amount missing on a write, still emit write with amount:null so the server asks.
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
  ctx: {
    smartAccount?: string | null;
    trader?: string | null;
    pageContext?: {
      route?: string;
      title?: string;
      metrics?: Array<{ label: string }>;
    } | null;
  },
): Promise<RoutedIntent> {
  // Per-turn context goes last, after the stable cached prefix.
  const pageLine = ctx.pageContext
    ? `\nPAGE: ${ctx.pageContext.title ?? "?"} (${ctx.pageContext.route ?? "?"}) — visible metrics: ` +
      (ctx.pageContext.metrics ?? []).map((m) => m.label).join(", ")
    : "";
  const user = [
    `USER MESSAGE: ${message}`,
    `CONTEXT: trader=${ctx.trader ?? "unknown"} smart_account=${ctx.smartAccount ?? "unknown"}${pageLine}`,
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
      steps: (data.steps as any[]).map((s) => {
        const args: Record<string, unknown> =
          s.args && typeof s.args === "object" && !Array.isArray(s.args) ? { ...s.args } : {};
        const levRaw = s.leverage ?? args.leverage;
        if (levRaw != null && Number.isFinite(Number(levRaw))) {
          args.leverage = Number(levRaw);
        }
        const amt = s.amount != null && s.amount !== "" ? Number(s.amount) : null;
        return {
          kind: s.kind === "write" ? ("write" as const) : ("read" as const),
          tool: s.tool != null ? String(s.tool) : undefined,
          op: s.op != null ? String(s.op) : undefined,
          args,
          asset: s.asset != null ? String(s.asset).toUpperCase() : null,
          amount: amt != null && Number.isFinite(amt) && amt > 0 ? amt : null,
          leverage: args.leverage != null ? Number(args.leverage) : null,
        };
      }),
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
  // Same reasoning as vertexExplainStructured: the numbers are already decided.
  return generateText(EXPLAIN_SYSTEM, user, { lowThinking: true });
}

/**
 * Structured version of vertexExplain.
 *
 * Uses responseSchema so the shape is constrained at generation time rather than
 * requested in the prompt. Returns null on any failure — the caller keeps the prose
 * path, so a schema this endpoint dislikes degrades instead of breaking the read path.
 */
export async function vertexExplainStructured(
  question: string,
  tool: string,
  data: Record<string, unknown>,
): Promise<StructuredAnswer | null> {
  const tidy = roundForProse(data) as Record<string, unknown>;
  const clipped = JSON.stringify(tidy).slice(0, 6000);
  const user = `QUESTION: ${question}\nTOOL: ${tool}\nDATA:\n${clipped}`;

  const token = await getAccessToken();
  const model = copilotConfig.vertexModel;
  const thinking = lowThinkingConfig(model);
  const bodyFor = (withThinking: boolean) => ({
    systemInstruction: { parts: [{ text: ANSWER_SYSTEM }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json",
      responseSchema: ANSWER_RESPONSE_SCHEMA,
      ...(withThinking && thinking ? { thinkingConfig: thinking } : {}),
    },
  });

  try {
    const post = (withThinking: boolean) =>
      fetch(modelUrl(model), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(bodyFor(withThinking)),
        signal: AbortSignal.timeout(60_000),
        cache: "no-store",
      });
    let res = await post(true);
    let text = await res.text();
    // A 400 naming the thinking field means this model does not take it — the answer is
    // still reachable without it, so retry rather than dropping to the prose path.
    if (!res.ok && res.status === 400 && /thinking/i.test(text)) {
      console.warn(`[copilot:vertex] ${model} rejected thinkingConfig on answer — retrying`);
      res = await post(false);
      text = await res.text();
    }
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) tokenCache = null;
      console.warn(`[copilot:vertex] structured answer HTTP ${res.status}: ${text.slice(0, 200)}`);
      return null;
    }
    const parsed = JSON.parse(text) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    logUsage("answer", parsed);
    const out = (parsed?.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text)
      .filter(Boolean)
      .join("");
    if (!out.trim()) return null;
    return normalizeAnswer(JSON.parse(out));
  } catch (e) {
    console.warn(
      `[copilot:vertex] structured answer failed, using prose: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`,
    );
    return null;
  }
}

const RECEIPT_SYSTEM = `You write the closing summary for a multi-step DeFi strategy that has just finished running on Stellar.

The user approved a plan and it executed. Tell them what actually happened, in the past tense, as a short report.

You return DATA, not prose layout. Never write markdown or bullet characters.

headline
- One sentence stating what was accomplished overall, in plain past tense.
- WHAT RAN is the full list of strategy legs. Only say a step did not run if that step appears in WHAT RAN with a failed/skipped/blocked status.
- Never invent that a step from the user's ask was skipped just because you are focusing on the last leg. If lend/deposit/borrow appear in WHAT RAN as ok/done, they ran.

facts
- ALWAYS an empty list. Return facts: [].
- The interface already shows every leg with its own status and transaction link. Repeating
  them here produced a wall of raw 64-character hashes with the action labels wrapping one
  word per line — unreadable, and duplicating what is directly above it.

note
- One or two sentences on what the user now holds, or what still needs doing. Omit if the headline covers it.
- Never put a transaction hash, a contract address or an XDR reference in any field. Say
  "submitted" or "confirmed on-chain"; the interface links the transaction itself.

venue
- The product the strategy mainly touched.

Never claim a leg succeeded unless DATA says so. A partial run reported as a success is the worst possible output here.`;

/**
 * Closing summary for a finished strategy.
 *
 * Reuses the structured-answer contract so it renders through the same component. Data
 * is the executed legs and their outcomes only — nothing derived — because a receipt that
 * overstates what landed on-chain is worse than no receipt.
 */
/**
 * The outcome of a run, counted from what actually happened.
 *
 * Deliberately aggregate-only. Per-leg detail is already on screen in the run card, with
 * each transaction linked, so repeating it here would be noise — and a 64-character hash in
 * a label/value grid wraps to one word per line. What is NOT on screen anywhere is the
 * total: how many legs settled, how many transactions that took, and where the position
 * ended up.
 */
function receiptFacts(execution: Record<string, unknown>): AnswerFact[] {
  const legs = Array.isArray(execution.legs)
    ? (execution.legs as Array<Record<string, unknown>>)
    : [];
  if (!legs.length) return [];

  const settled = legs.filter((l) => ["ok", "done"].includes(String(l.status ?? ""))).length;
  const onChain = legs.filter((l) => l.tx_hash != null && String(l.tx_hash).length > 0).length;
  const failed = legs.filter((l) =>
    ["error", "blocked", "stopped", "stopped_hf", "preflight_blocked"].includes(
      String(l.status ?? ""),
    ),
  ).length;

  const facts: AnswerFact[] = [
    {
      label: "steps settled",
      value: `${settled} of ${legs.length}`,
      // Amber rather than green on a partial run: "3 of 4" beside a green tick reads as
      // success at a glance, and a half-built position is not a success.
      tone: settled === legs.length ? "good" : failed > 0 ? "bad" : "warn",
    },
  ];
  if (onChain > 0) {
    facts.push({
      label: "transactions",
      value: String(onChain),
      tone: "neutral",
    });
  }

  const hf = Number(execution.final_health_factor);
  if (Number.isFinite(hf) && hf > 0) {
    const floor = Number(execution.health_factor_floor);
    facts.push({
      label: "health factor",
      value: hf >= 999 ? "∞" : hf.toFixed(2),
      tone: hf < 1.1 ? "bad" : Number.isFinite(floor) && hf < floor ? "warn" : "good",
    });
  }

  return facts;
}

export async function vertexSummarizeExecution(
  intent: string,
  execution: Record<string, unknown>,
): Promise<StructuredAnswer | null> {
  const clipped = JSON.stringify(roundForProse(execution)).slice(0, 5000);
  const user = `WHAT THE USER ASKED FOR: ${intent}\nWHAT RAN:\n${clipped}`;

  const token = await getAccessToken();
  const model = copilotConfig.vertexModel;
  try {
    const res = await fetch(modelUrl(model), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: RECEIPT_SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
          responseSchema: ANSWER_RESPONSE_SCHEMA,
        },
      }),
      signal: AbortSignal.timeout(45_000),
      cache: "no-store",
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) tokenCache = null;
      return null;
    }
    const parsed = JSON.parse(await res.text()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    logUsage("receipt", parsed);
    const out = (parsed?.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text)
      .filter(Boolean)
      .join("");
    if (!out.trim()) return null;
    const answer = normalizeAnswer(JSON.parse(out));
    if (!answer) return null;
    /**
     * The model writes the sentence; the figures are counted here.
     *
     * This used to force `facts: []`, on the reasoning that the step list above already
     * shows each leg so any fact is a duplicate. Half right: a PER-LEG fact is a duplicate,
     * but the aggregate outcome is not — how many transactions actually landed and where the
     * health factor ended up appear nowhere else, and stripping them left the Response
     * section as one lonely sentence under a heading.
     *
     * Computing them instead of letting the model report them also means the count cannot
     * be wrong. A model summarising four legs has been observed claiming all four settled
     * when two had; a length check cannot.
     */
    const noHashes = (s: string) =>
      s.replace(/\b[0-9a-f]{16,}\b/gi, "").replace(/\s{2,}/g, " ").trim();
    return {
      ...answer,
      headline: noHashes(answer.headline),
      facts: receiptFacts(execution),
      ...(answer.note ? { note: noHashes(answer.note) } : {}),
    };
  } catch (e) {
    console.warn(
      `[copilot:vertex] receipt summary failed: ${e instanceof Error ? e.message.slice(0, 140) : String(e)}`,
    );
    return null;
  }
}

/**
 * Structured Guide answer. Returns null on any failure so the caller keeps its prose
 * path — an explanation surface degrading to plain text is fine; going blank is not.
 */
export async function vertexGuideAnswer(
  question: string,
  pageContextJson: string | null,
  history?: Array<{ role: "user" | "assistant"; text: string }>,
): Promise<GuideAnswer | null> {
  // Follow-ups are the Guide's own suggestion chips ("how is that different from Earn?"),
  // so without the preceding turns the pronoun in every one of them dangles.
  const priorTurns = (history ?? [])
    .slice(-6)
    .map((t) => `${t.role}: ${t.text.slice(0, 800)}`)
    .join("\n");

  const user = [
    priorTurns ? `EARLIER IN THIS CONVERSATION:\n${priorTurns}` : "",
    `QUESTION: ${question}`,
    pageContextJson ? `PAGE CONTEXT:\n${pageContextJson.slice(0, 6000)}` : "PAGE CONTEXT: none",
  ]
    .filter(Boolean)
    .join("\n\n");

  const token = await getAccessToken();
  const model = copilotConfig.vertexModel;
  try {
    const res = await fetch(modelUrl(model), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: GUIDE_SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          temperature: 0.3,
          responseMimeType: "application/json",
          responseSchema: GUIDE_RESPONSE_SCHEMA,
        },
      }),
      signal: AbortSignal.timeout(60_000),
      cache: "no-store",
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) tokenCache = null;
      console.warn(`[copilot:vertex] guide HTTP ${res.status}`);
      return null;
    }
    const parsed = JSON.parse(await res.text()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    logUsage("guide", parsed);
    const out = (parsed?.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text)
      .filter(Boolean)
      .join("");
    return out.trim() ? normalizeGuideAnswer(JSON.parse(out), question) : null;
  } catch (e) {
    console.warn(
      `[copilot:vertex] guide failed, using prose: ${e instanceof Error ? e.message.slice(0, 140) : String(e)}`,
    );
    return null;
  }
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
