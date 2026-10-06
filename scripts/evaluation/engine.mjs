import { isDeepStrictEqual } from "node:util";

class EvaluationError extends Error {
  constructor(code) { super(code); this.code = code; }
}

/** RFC 6901 pointers address data, never user phrasing. */
export function pointer(value, path) {
  if (path === "") return value;
  if (typeof path !== "string" || !path.startsWith("/")) throw new EvaluationError("invalid_pointer");
  for (const part of path.slice(1).split("/")) {
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

/** Resolve exact data references and environment inputs without interpolating sentences. */
export function resolve(value, context, env) {
  if (Array.isArray(value)) return value.map((item) => resolve(item, context, env));
  if (value === null || typeof value !== "object") return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "$env") {
    if (!Object.hasOwn(env, value.$env) || !env[value.$env]) throw new EvaluationError("missing_environment_input");
    return env[value.$env];
  }
  if (keys.length === 1 && keys[0] === "$ref") {
    const at = value.$ref.indexOf("#");
    if (at < 1) throw new EvaluationError("invalid_reference");
    const result = pointer(context[value.$ref.slice(0, at)], value.$ref.slice(at + 1));
    if (result === undefined) throw new EvaluationError("missing_reference");
    return structuredClone(result);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item, context, env)]));
}

function decimal(value) {
  if (typeof value !== "string" && typeof value !== "number") throw new EvaluationError("invalid_decimal");
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new EvaluationError("use_decimal_string");
  let text = String(value);
  const negative = text.startsWith("-");
  if (negative) text = text.slice(1);
  const parts = text.split(".");
  if (parts.length > 2 || !parts[0] || parts.some((part) => !part || [...part].some((c) => c < "0" || c > "9"))) {
    throw new EvaluationError("invalid_decimal");
  }
  return { value: BigInt(parts.join("")) * (negative ? -1n : 1n), scale: BigInt(parts[1]?.length ?? 0) };
}

export function compareDecimals(left, right) {
  const a = decimal(left), b = decimal(right);
  const x = a.value * 10n ** b.scale, y = b.value * 10n ** a.scale;
  return x < y ? -1 : x > y ? 1 : 0;
}

function compareDelta(actual, before, expected) {
  const a = decimal(actual), b = decimal(before), c = decimal(expected);
  const scale = [a.scale, b.scale, c.scale].reduce((x, y) => x > y ? x : y);
  return a.value * 10n ** (scale - a.scale) - b.value * 10n ** (scale - b.scale)
    === c.value * 10n ** (scale - c.scale);
}

export function assertionPasses(actual, assertion, context, env) {
  const expected = resolve(assertion.value, context, env);
  switch (assertion.op) {
    case "exists": return actual !== undefined && actual !== null;
    case "eq": return isDeepStrictEqual(actual, expected);
    case "in": return Array.isArray(expected) && expected.some((item) => isDeepStrictEqual(actual, item));
    case "gte": return actual !== undefined && actual !== null && compareDecimals(actual, expected) >= 0;
    case "lte": return actual !== undefined && actual !== null && compareDecimals(actual, expected) <= 0;
    case "delta": return actual !== undefined && actual !== null && compareDelta(actual, resolve(assertion.from, context, env), expected);
    default: throw new EvaluationError("unknown_assertion");
  }
}

export function parseResponse(text, contentType) {
  if (!contentType.includes("application/x-ndjson")) return JSON.parse(text);
  const events = text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  const terminal = events.filter((event) => event.type === "result" || event.type === "error");
  if (terminal.length !== 1 || events.at(-1) !== terminal[0]) throw new EvaluationError("invalid_terminal_stream");
  return { ...terminal[0], events };
}

/** Unknown POST routes are never classified by prompt contents. */
export function requiresExecution(method, pathname) {
  if (method === "GET") return false;
  if (method !== "POST") throw new EvaluationError("unsupported_method");
  if (pathname === "/api/copilot/investigate" || pathname === "/api/copilot/workflow/propose") return false;
  const parts = pathname.split("/");
  if (parts.length !== 6 || parts[1] !== "api" || parts[2] !== "copilot" || parts[3] !== "workflow") {
    throw new EvaluationError("unsupported_mutation_route");
  }
  return true;
}

function safeUrl(path, baseUrl) {
  const url = new URL(path, baseUrl);
  if (url.origin !== new URL(baseUrl).origin || url.username || url.password || url.hash) throw new EvaluationError("foreign_request_target");
  return url;
}

/** Run ordered HTTP steps; only explicitly declared observation polling is repeated. */
export async function runScenario(scenario, options) {
  if (!scenario.steps?.length) throw new EvaluationError("empty_scenario");
  const { request, baseUrl, env = {}, executionVerified = false, sign } = options;
  const context = Object.create(null), rows = [];
  const ids = new Set();
  const started = performance.now();
  for (const step of scenario.steps) {
    if (!step.id || ids.has(step.id)) throw new EvaluationError("duplicate_step_id");
    ids.add(step.id);
    const begin = performance.now();
    /** @type {{ id: string, status: string, ms: number, assertions: Array<{path: string, op: string, passed: boolean}>, error?: string }} */
    const row = { id: step.id, status: "pass", ms: 0, assertions: [] };
    try {
      if (step.sign !== undefined) {
        if (!executionVerified || !sign) throw new EvaluationError("signer_not_configured");
        const unsignedXdr = resolve(step.sign, context, env);
        if (typeof unsignedXdr !== "string") throw new EvaluationError("invalid_unsigned_envelope");
        context[step.id] = { signedXdr: await sign(unsignedXdr) };
      } else {
        const method = step.method ?? "GET";
        const resolvedPath = resolve(step.path, context, env);
        const path = Array.isArray(resolvedPath) ? resolvedPath.join("") : resolvedPath;
        const url = safeUrl(path, baseUrl);
        if (requiresExecution(method, url.pathname) && !executionVerified) throw new EvaluationError("execution_not_verified");
        if (step.poll && !(method === "GET" || ["confirm", "recheck"].includes(url.pathname.split("/").at(-1)))) {
          throw new EvaluationError("mutation_retry_refused");
        }
        const attempts = step.poll?.attempts ?? 1;
        if (!Number.isSafeInteger(attempts) || attempts < 1 || (step.poll && !(step.poll.intervalMs > 0))) throw new EvaluationError("invalid_poll_budget");
        for (let attempt = 0; attempt < attempts; attempt++) {
          const response = await request(url.href, {
            method, body: resolve(step.body, context, env), timeoutMs: scenario.timeoutMs,
          });
          const body = parseResponse(response.text, response.contentType);
          context[step.id] = { status: response.status, body };
          if (!step.poll || assertionPasses(pointer(context[step.id], step.poll.until.path), step.poll.until, context, env)) break;
          if (attempt + 1 === attempts) throw new EvaluationError("poll_exhausted");
          await new Promise((done) => setTimeout(done, step.poll.intervalMs));
        }
      }
      if (!Array.isArray(step.assert) || !step.assert.length) throw new EvaluationError("missing_assertions");
      for (const check of step.assert) {
        const passed = assertionPasses(pointer(context[step.id], check.path), check, context, env);
        row.assertions.push({ path: check.path, op: check.op, passed });
        if (!passed) row.status = "fail";
      }
    } catch (error) {
      row.status = "error";
      // Provider exceptions and assertion values may carry secrets. Reports expose neither.
      row.error = error instanceof EvaluationError ? error.code : "step_unavailable";
    }
    row.ms = Math.round(performance.now() - begin);
    rows.push(row);
    if (row.status !== "pass") break;
  }
  return { id: scenario.id, status: rows.some((row) => row.status === "fail") ? "fail"
    : rows.some((row) => row.status === "error") ? "error" : "pass", ms: Math.round(performance.now() - started), steps: rows };
}
