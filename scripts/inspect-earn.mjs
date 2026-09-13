// scripts/inspect-earn.mjs
const BASE = "http://localhost:3000";
const WALLET = "GD4BQRQPYLVM7YS57V4USR265UFZFEXIVDJJBIK3BAFQJ3F6SCA5NPDH";

async function run() {
  const res = await fetch(`${BASE}/api/copilot/investigate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'invest into earn pool where i can get good returns?',
      wallet: WALLET
    })
  });
  const text = await res.text();
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === "result") {
        console.log("=== Result Object ===");
        console.log("Status:", obj.result.status);
        console.log("Message:", obj.result.message);
        console.log("Question:", obj.result.question);
        console.log("ProposalCandidateId:", obj.result.proposalCandidateId);
        console.log("Understanding:", JSON.stringify(obj.result.understanding, null, 2));
        console.log("Facts count:", obj.result.facts?.length);
        console.log("Warnings:", obj.result.warnings);
        console.log("RankedOptions:", JSON.stringify(obj.result.rankedOptions, null, 2));
        console.log("Candidates:", JSON.stringify(obj.result.candidates, null, 2));
      }
    } catch (e) {
      // not json
    }
  }
}

run().catch(console.error);
