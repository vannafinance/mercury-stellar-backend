import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { request as playwrightRequest } from "playwright-core";
import { runScenario, resolve } from "./engine.mjs";
import { verifyTestnet, makeTestnetSigner } from "./stellar-sandbox.mjs";

const args = process.argv.slice(2);
const suitePath = args.find((arg) => !arg.startsWith("--"));
if (!suitePath) throw new Error("Provide a suite JSON path.");
const suite = JSON.parse(await readFile(suitePath, "utf8"));
if (suite.version !== 1 || !suite.scenarios?.length) throw new Error("Invalid evaluation suite.");
const baseUrl = resolve(suite.baseUrl, {}, process.env);
const timeout = suite.timeoutMs;
if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error("Provide a positive suite timeoutMs.");
let executionVerified = false;
if (args.includes("--execute")) {
  if (suite.network !== "testnet") throw new Error("Execution requires a testnet suite.");
  const rpcUrl = resolve(suite.rpcUrl, {}, process.env);
  await verifyTestnet(rpcUrl, timeout);
  executionVerified = true;
}
// Validate supplied credentials before research/approval, not halfway through a workflow.
const sign = executionVerified && suite.signer ? makeTestnetSigner(
  resolve(suite.signer.secret, {}, process.env), resolve(suite.signer.wallet, {}, process.env),
) : undefined;
const extraHTTPHeaders = resolve(suite.headers ?? {}, {}, process.env);
const reports = [];
for (const scenario of suite.scenarios) {
  if (!scenario.id || !scenario.steps?.length) throw new Error("Invalid scenario.");
  // Each wallet/scenario has an independent cookie jar. Login/storage state is never reported.
  const context = await playwrightRequest.newContext({ baseURL: baseUrl, extraHTTPHeaders,
    ...(suite.storageState ? { storageState: resolve(suite.storageState, {}, process.env) } : {}) });
  try {
    const report = await runScenario({ ...scenario, timeoutMs: timeout }, {
      baseUrl, env: process.env, executionVerified,
      request: async (url, input) => {
        const response = await context.fetch(url, { method: input.method, data: input.body,
          timeout: input.timeoutMs, maxRedirects: 0, failOnStatusCode: false });
        return { status: response.status(), contentType: response.headers()["content-type"] ?? "", text: await response.text() };
      },
      sign,
    });
    reports.push(report);
  } finally { await context.dispose(); }
}
const outputDir = resolvePath(".local/evaluation");
await mkdir(outputDir, { recursive: true });
const report = { at: new Date().toISOString(), suite: pathToFileURL(resolvePath(suitePath)).pathname.split("/").at(-1),
  executionVerified, scenarios: reports };
const output = resolvePath(outputDir, `${Date.now()}.json`);
await writeFile(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ report: output, executionVerified, pass: reports.filter((r) => r.status === "pass").length,
  fail: reports.filter((r) => r.status === "fail").length, error: reports.filter((r) => r.status === "error").length }));
if (reports.some((r) => r.status !== "pass")) process.exitCode = 1;
