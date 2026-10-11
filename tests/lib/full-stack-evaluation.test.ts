import { createServer, type Server } from "node:http";
import { request as apiRequest } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertionPasses, compareDecimals, parseResponse, resolve, runScenario } from "../../scripts/evaluation/engine.mjs";

// HTTP fixtures test the runner, not model quality or ledger settlement.
let server: Server;
let baseUrl: string;
let confirmations = 0;
const calls: Array<{ path: string; body: any }> = [];
beforeAll(async () => {
  server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : undefined;
    calls.push({ path: req.url!, body });
    res.setHeader("content-type", "application/json");
    switch (req.url) {
      case "/api/copilot/investigate":
        res.setHeader("content-type", "application/x-ndjson");
        res.end(JSON.stringify({ type: "progress", event: {} }) + "\n" + JSON.stringify({
          type: "result", result: { continuation: "opaque", proposalCandidateId: "candidate", balance: "9007199254740993.000001" },
        }) + "\n"); return;
      case "/api/copilot/workflow/propose": res.end(JSON.stringify({ id: "fixture", revision: 1, digest: "sealed", status: "proposed" })); return;
      case "/api/copilot/workflow/fixture/approve": res.end(JSON.stringify({ status: "approved" })); return;
      case "/api/copilot/workflow/fixture/advance": res.end(JSON.stringify({ unsignedXdr: "fixture-envelope" })); return;
      case "/api/copilot/workflow/fixture/submit": res.end(JSON.stringify({ txHash: "fixture-hash" })); return;
      case "/api/copilot/workflow/fixture/confirm": res.end(JSON.stringify({ status: ++confirmations === 1 ? "pending" : "settled" })); return;
      case "/set-cookie": res.setHeader("set-cookie", "session=fixture; Path=/"); res.end("{}"); return;
      case "/cookies": res.end(JSON.stringify({ cookie: req.headers.cookie ?? null })); return;
      default: res.statusCode = 404; res.end("{}");
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())); });

const check = (path: string, value: unknown) => ({ path, op: "eq", value });
const ref = (value: string) => ({ $ref: value });

describe("HTTP evaluation harness", () => {
  it("carries actual responses across the full manual flow and polls only confirmation", async () => {
    calls.length = 0; confirmations = 0;
    const context = await apiRequest.newContext();
    try {
      const result = await runScenario({ id: "roundtrip-fixture", timeoutMs: 3000, steps: [
        { id: "research", method: "POST", path: "/api/copilot/investigate", body: { message: { $env: "PROMPT" } }, assert: [check("/body/type", "result")] },
        { id: "proposal", method: "POST", path: "/api/copilot/workflow/propose", body: { continuation: ref("research#/body/result/continuation"), candidateId: ref("research#/body/result/proposalCandidateId") }, assert: [check("/body/status", "proposed")] },
        { id: "approve", method: "POST", path: ["/api/copilot/workflow/", ref("proposal#/body/id"), "/approve"], body: { digest: ref("proposal#/body/digest"), revision: ref("proposal#/body/revision") }, assert: [check("/body/status", "approved")] },
        { id: "advance", method: "POST", path: "/api/copilot/workflow/fixture/advance", assert: [{ path: "/body/unsignedXdr", op: "exists" }] },
        { id: "sign", sign: ref("advance#/body/unsignedXdr"), assert: [check("/signedXdr", "signed-fixture-envelope")] },
        { id: "submit", method: "POST", path: "/api/copilot/workflow/fixture/submit", body: { signedXdr: ref("sign#/signedXdr") }, assert: [check("/body/txHash", "fixture-hash")] },
        { id: "confirm", method: "POST", path: "/api/copilot/workflow/fixture/confirm", body: { txHash: ref("submit#/body/txHash") }, poll: { attempts: 2, intervalMs: 1, until: check("/body/status", "settled") }, assert: [check("/body/status", "settled")] },
      ] }, { baseUrl, env: { PROMPT: "arbitrary input" }, executionVerified: true, sign: async (xdr: string) => `signed-${xdr}`,
        request: async (url: string, input: any) => {
          const response = await context.fetch(url, { method: input.method, data: input.body, maxRedirects: 0, timeout: input.timeoutMs });
          return { status: response.status(), contentType: response.headers()["content-type"], text: await response.text() };
        },
      });
      expect(result.status).toBe("pass");
      expect(calls).toHaveLength(7);
      expect(calls[1].body).toEqual({ continuation: "opaque", candidateId: "candidate" });
      expect(calls[2].body).toEqual({ digest: "sealed", revision: 1 });
      expect(calls[4].body).toEqual({ signedXdr: "signed-fixture-envelope" });
      expect(calls.slice(5).every((c) => c.body.txHash === "fixture-hash")).toBe(true);
      expect(JSON.stringify(result)).not.toContain("sealed");
      expect(JSON.stringify(result)).not.toContain("arbitrary input");
    } finally { await context.dispose(); }
  });

  it("keeps cookie sessions separate between scenario contexts", async () => {
    const a = await apiRequest.newContext(), b = await apiRequest.newContext();
    try {
      await a.get(`${baseUrl}/set-cookie`);
      expect(await (await a.get(`${baseUrl}/cookies`)).json()).toEqual({ cookie: "session=fixture" });
      expect(await (await b.get(`${baseUrl}/cookies`)).json()).toEqual({ cookie: null });
    } finally { await a.dispose(); await b.dispose(); }
  });

  it.each([
    { method: "POST", path: "/api/copilot/workflow/x/submit", error: "execution_not_verified" },
    { method: "POST", path: "/api/copilot", error: "unsupported_mutation_route" },
    { method: "GET", path: "https://other.invalid/path", error: "foreign_request_target" },
  ])("rejects unsafe target $path before HTTP", async ({ method, path, error }) => {
    let requested = false;
    const result = await runScenario({ id: "gate", steps: [{ id: "blocked", method, path, assert: [check("/status", 200)] }] },
      { baseUrl, request: async () => { requested = true; throw new Error("should not send"); } });
    expect(requested).toBe(false);
    expect(result.steps[0].error).toBe(error);
  });

  it.each(["approve", "advance", "submit"])("refuses configured retries of %s", async (operation) => {
    const result = await runScenario({ id: "retry", steps: [{ id: "write", method: "POST", path: `/api/copilot/workflow/x/${operation}`,
      poll: { attempts: 2, intervalMs: 1, until: check("/status", 200) }, assert: [check("/status", 200)] }] },
      { baseUrl, executionVerified: true, request: async () => { throw new Error("should not send"); } });
    expect(result.steps[0].error).toBe("mutation_retry_refused");
  });

  it("stops after a failed assertion and redacts provider errors", async () => {
    let count = 0;
    const steps = ["first", "second"].map((id) => ({ id, path: "/api/copilot", assert: [check("/status", 200)] }));
    const failure = await runScenario({ id: "failure", steps }, { baseUrl, request: async () => { count++; return { status: 503, text: "{}", contentType: "application/json" }; } });
    expect(count).toBe(1); expect(failure.status).toBe("fail");
    const error = await runScenario({ id: "error", steps }, { baseUrl, request: async () => { throw new Error("secret=private"); } });
    expect(error.steps[0].error).toBe("step_unavailable"); expect(JSON.stringify(error)).not.toContain("private");
  });

  it("fails exhausted confirmation rather than claiming settlement", async () => {
    let count = 0;
    const result = await runScenario({ id: "pending", steps: [{ id: "confirm", method: "POST", path: "/api/copilot/workflow/x/confirm",
      poll: { attempts: 2, intervalMs: 1, until: check("/body/status", "settled") }, assert: [check("/body/status", "settled")] }] },
      { baseUrl, executionVerified: true, request: async () => { count++; return { status: 200, text: '{"status":"pending"}', contentType: "application/json" }; } });
    expect(count).toBe(2); expect(result.steps[0].error).toBe("poll_exhausted");
  });

  it("requires a single final stream event and preserves terminal errors", () => {
    expect(() => parseResponse('{"type":"progress"}\n', "application/x-ndjson")).toThrow("invalid_terminal_stream");
    expect(() => parseResponse('{"type":"result"}\n{"type":"progress"}\n', "application/x-ndjson")).toThrow();
    expect(() => parseResponse('{"type":"result"}\n{"type":"result"}\n', "application/x-ndjson")).toThrow();
    expect(parseResponse('{"type":"error","code":"unavailable"}\n', "application/x-ndjson").type).toBe("error");
  });

  it("compares large fractional amounts and deltas without float rounding", () => {
    expect(compareDecimals("9007199254740993.000002", "9007199254740993.000001")).toBe(1);
    expect(assertionPasses("9007199254740993.000002", { op: "delta", from: "9007199254740993.000001", value: "0.000001" }, {}, {})).toBe(true);
    expect(assertionPasses("0.90", { op: "delta", from: "1.000", value: "-0.1" }, {}, {})).toBe(true);
    expect(() => compareDecimals(0.1, "0.1")).toThrow("use_decimal_string");
  });

  it("requires exact references and environment inputs", () => {
    expect(() => resolve({ $env: "ABSENT" }, {}, {})).toThrow("missing_environment_input");
    expect(() => resolve({ $ref: "missing#/body" }, {}, {})).toThrow("missing_reference");
    expect(resolve({ $ref: "a#/body/a~1b/~0key" }, { a: { body: { "a/b": { "~key": "value" } } } }, {})).toBe("value");
  });

  it("counts an absent numeric postcondition as a failed check", () => {
    expect(assertionPasses(undefined, { op: "gte", value: 1 }, {}, {})).toBe(false);
    expect(assertionPasses(null, { op: "lte", value: 1 }, {}, {})).toBe(false);
    expect(assertionPasses(undefined, { op: "delta", from: "1", value: "1" }, {}, {})).toBe(false);
  });
});
