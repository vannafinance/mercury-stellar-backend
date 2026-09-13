// scripts/run-battery-and-measure.mjs
const BASE = "http://localhost:3000";
const WALLET = "GD4BQRQPYLVM7YS57V4USR265UFZFEXIVDJJBIK3BAFQJ3F6SCA5NPDH";

const BATTERY_PROMPTS = [
  "what's my health factor",
  "put 10 xlm in and lever 3x into sousdc",
  "invest into earn pool where i can get good returns?",
  "lend 2 AQUSDC",
];

async function getBrains() {
  const res = await fetch(`${BASE}/api/copilot`);
  const data = await res.json();
  return data.health?.brains_served;
}

async function sendInvestigate(prompt, wallet) {
  const t0 = Date.now();
  console.log(`[Battery] POST /api/copilot/investigate prompt="${prompt}" wallet=${wallet ? wallet.slice(0, 8) + '...' : 'none'}`);
  try {
    const res = await fetch(`${BASE}/api/copilot/investigate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: prompt, wallet }),
    });
    const text = await res.text();
    const ms = Date.now() - t0;
    console.log(`  -> status=${res.status} in ${ms}ms (response length: ${text.length})`);
    return { prompt, status: res.status, ms, len: text.length };
  } catch (err) {
    console.error(`  -> ERROR in ${Date.now() - t0}ms:`, err.message);
    return { prompt, error: err.message };
  }
}

async function sendCopilotPost(message, surface) {
  const t0 = Date.now();
  console.log(`[Battery] POST /api/copilot surface="${surface}" message="${message}"`);
  try {
    const res = await fetch(`${BASE}/api/copilot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, surface }),
    });
    const data = await res.json();
    const ms = Date.now() - t0;
    console.log(`  -> status=${res.status} in ${ms}ms: kind=${data.kind} template=${data.intent?.template_id}`);
    return { message, surface, status: res.status, ms, data };
  } catch (err) {
    console.error(`  -> ERROR in ${Date.now() - t0}ms:`, err.message);
    return { message, surface, error: err.message };
  }
}

async function main() {
  console.log("=== Initial Brains Served ===");
  const initial = await getBrains();
  console.log(JSON.stringify(initial, null, 2));

  console.log("\n=== Running Battery Prompts through /api/copilot/investigate ===");
  for (const p of BATTERY_PROMPTS) {
    await sendInvestigate(p, WALLET);
  }

  console.log("\n=== Checking /api/copilot with surface=copilot (Shim path) ===");
  await sendCopilotPost("put 10 xlm in and lever 3x into sousdc", "copilot");

  console.log("\n=== Checking /api/copilot with surface=assistant (Widget path) ===");
  await sendCopilotPost("what is the pool stats", "assistant");

  console.log("\n=== Final Brains Served ===");
  const final = await getBrains();
  console.log(JSON.stringify(final, null, 2));
}

main().catch(console.error);
