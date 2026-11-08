/**
 * Small, approved product pack for the page Guide. Retrieved into the prompt —
 * not the whole architecture doc.
 */

import glossaryJson from "@/data/glossary.json";

type GlossaryEntry = {
  term: string;
  aliases: string[];
  short: string;
  detailed: string;
  common_mistake?: string;
};

const GLOSSARY = glossaryJson as Record<string, GlossaryEntry>;

export const COPILOT_WORKFLOW_PACK = `COPILOT WORKFLOW (explain only — never execute from this surface):
- The floating Assistant (this chat) explains the page, products, and failures. It does not sign or submit. Direct the user to the Copilot page (/copilot) to run a transaction.
- Copilot path: investigate → show a plan → user approves → execute leg by leg → receipt with real hashes. A typed action sentence here is redirected, not run.
- Auto-sign is a Copilot Autonomy session with USD caps. close_account, settle_account, and liquidate cannot be auto-signed.
- Cancelling a multi-leg plan mid-way leaves already-submitted legs on chain; remaining legs do not run. Say that plainly.
- Earn = Vanna's own lending pools (vTokens, G-wallet). Farm = Blend reserves / Aquarius LP on the margin C-address. Margin = collateral, debt, health factor on the C-address.
- G-address is the Freighter/Privy wallet. C-address is the margin smart account. Farm positions live on the C-address.
- Health factor = gross collateral / debt. Liquidation at or below 1.1. BLUSDC, AQUSDC, SOUSDC are different tokens.
- Failure stages: wallet_rejected (user closed the wallet — not a chain failure), simulation_failed (pre-flight, nothing submitted), unsigned_xdr (built, waiting for a signature), submitted_unconfirmed (hash exists, ledger not closed), horizon_failed (on-chain failed). Never call a wallet cancel a failed transaction.
- If they want to retry, tell them how and send them to Copilot. Do not offer to sign it here.`;

export function glossaryHintsFor(message: string, path?: string | null): string {
  const lower = message.toLowerCase();
  const hits: GlossaryEntry[] = [];
  for (const e of Object.values(GLOSSARY)) {
    const terms = [e.term, ...e.aliases].map((a) => a.toLowerCase());
    if (terms.some((t) => t.length > 2 && lower.includes(t))) hits.push(e);
  }
  if (hits.length < 3 && path) {
    const routeKey = path.includes("farm")
      ? "farm"
      : path.includes("earn")
        ? "earn"
        : path.includes("margin") || path === "/"
          ? "margin"
          : path.includes("portfolio")
            ? "portfolio"
            : path.includes("trade")
              ? "trade-spot"
              : null;
    if (routeKey) {
      for (const e of Object.values(GLOSSARY)) {
        if ((e as GlossaryEntry & { pages?: string[] }).pages?.includes(routeKey) && hits.length < 6) {
          hits.push(e);
        }
      }
    }
  }
  const uniq = new Map(hits.map((e) => [e.term, e]));
  const pack = [...uniq.values()].slice(0, 8).map((e) => ({
    term: e.term,
    note: e.detailed,
    caveat: e.common_mistake,
  }));
  if (!pack.length) return "";
  return `PRODUCT GLOSSARY (background — never override PAGE or SESSION numbers):\n${JSON.stringify(pack)}`;
}
