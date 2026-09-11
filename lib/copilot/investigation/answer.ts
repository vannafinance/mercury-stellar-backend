import type { ResearchFact, ResearchView } from "./view";
import type { CandidateSet } from "./candidates";
import type { ResearchCapacity } from "./view";

function askedIn(request: string | undefined, pattern: RegExp): boolean {
  return !!request && pattern.test(request);
}

/**
 * Only cite facts the prompt actually asked about. A repay of one asset used to
 * print every wallet balance, health, and total debt because this function
 * always dumped the full research bag.
 */
function relevantFacts(facts: readonly ResearchFact[], request?: string): readonly ResearchFact[] {
  if (!request?.trim()) return facts;
  const named = [...new Set(
    (request.toUpperCase().match(/\b(XLM|BLUSDC|AQUSDC|SOUSDC|AQUA|EURC)\b/g) ?? []),
  )];
  const wantsHealth = askedIn(request, /\b(health(?:\s+factor)?|\bhf\b|liquidat|am i safe|at risk)\b/i);
  const wantsDebt = askedIn(request, /\b(debt|owe|borrowed|liabilit)/i)
    && !askedIn(request, /\b(repay|pay\s+back|pay\s+off)\b/i);
  const wantsWallet = askedIn(request, /\b(wallet|balance|hold|how much .{0,24}(have|holding))\b/i);
  const wantsPrice = askedIn(request, /\b(price|oracle|worth|trading at|value of)\b/i);
  const wantsRates = askedIn(request, /\b(apy|apr|rate|yield|earn|blend)\b/i);
  return facts.filter((fact) => {
    if (fact.sourcePath === "allowed") return true;
    if (fact.venue === "oracle") return wantsPrice || named.some((asset) => fact.label.toUpperCase().includes(asset));
    if (fact.venue === "wallet" && fact.sourcePath.endsWith(".balance")) {
      if (!wantsWallet && named.length === 0) return false;
      if (named.length && !named.some((asset) => fact.unit === asset || fact.label.toUpperCase().includes(asset))) return false;
      return wantsWallet || named.length > 0;
    }
    if (fact.sourcePath === "posted_health_factor" || fact.sourcePath === "health_factor" || fact.sourcePath === "page_debt_mismatch") {
      return wantsHealth;
    }
    if (fact.label === "Total margin debt" || fact.label === "Reported debt value") return wantsDebt;
    if (["earn", "blend"].includes(fact.venue) && fact.unit === "% APR") return wantsRates;
    return true;
  });
}

/** Conversational factual answers use audited fields; model prose cannot invent balances. */
export function factualAnswer(facts: readonly ResearchFact[], request?: string): string | null {
  const amount = (fact: ResearchFact) => {
    const n = Number(fact.value);
    const usd = fact.unit === "USD";
    const value = Number.isFinite(n)
      ? n.toLocaleString("en-US", {
          minimumFractionDigits: usd ? 2 : 0,
          maximumFractionDigits: usd ? 2 : 7,
        })
      : fact.value;
    return usd ? `$${value}` : `${value} ${fact.unit}`.trim();
  };
  const sentences: string[] = [];
  const selected = relevantFacts(facts, request);
  const balances = selected.filter(f => f.venue === "wallet" && f.sourcePath.endsWith(".balance"));
  if (balances.length) sentences.push(`Your wallet holds ${balances.map(amount).join(", ")}.`);
  const posted = selected.find(f => f.sourcePath === "posted_health_factor");
  const pageHealth = selected.find(f => f.sourcePath === "health_factor" && f.venue === "margin");
  const pageMismatch = selected.find(f => f.sourcePath === "page_debt_mismatch");
  if (pageHealth && !posted && !pageMismatch) {
    sentences.push(`Your reported health factor is ${formatHealthFactor(pageHealth.value)}.`);
  } else if (posted) {
    sentences.push(`${formatHealthFactor(posted.value)} on posted collateral, the base the risk engine uses.`);
    if (pageMismatch) {
      const panel = pageMismatch.value && pageMismatch.value !== "yes"
        ? formatHealthFactor(pageMismatch.value)
        : null;
      sentences.push(
        panel
          ? `The account panel shows ${panel}, which does not match this debt, so I'm not using it.`
          : "The account panel is showing a different figure, so I'm not using it.",
      );
    }
  }
  const debt = selected.find(f => f.label === "Total margin debt") ?? selected.find(f => f.label === "Reported debt value");
  if (debt) sentences.push(`Your reported margin debt is ${amount(debt)}.`);
  const prices = selected.filter(f => f.venue === "oracle");
  for (const price of prices) sentences.push(`${price.label}: ${amount(price)}.`);
  const eligibility = selected.filter(f => f.sourcePath === "allowed" && f.venue === "margin");
  for (const fact of eligibility) {
    sentences.push(`${fact.label} is ${fact.value} on the current health check.`);
  }
  const rates = selected.filter(f => ["earn", "blend"].includes(f.venue) && f.unit === "% APR" && f.label.includes("supply"));
  if (rates.length) sentences.push(`The reported supply rates are ${rates.map(f => `${f.label.replace(" supply APR", "")}: ${amount(f)}`).join("; ")}.`);
  return sentences.length ? sentences.join(" ") : null;
}

/** Display rounding only. Sizing and stored facts keep the full-precision string. */
export function formatHealthFactor(value: string): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : value;
}

function money(usd: string): string {
  const n = Number(usd);
  return Number.isFinite(n)
    ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `$${usd}`;
}

/**
 * Grounded reply from computed options. Model findings stay unpublished; this is
 * the analyst voice built only from ranked candidates and stated constraints.
 */
export function strategyReply(input: {
  status: ResearchView["status"];
  facts: readonly ResearchFact[];
  candidates: CandidateSet | null | undefined;
  capacity: ResearchCapacity | null | undefined;
  question: string | null;
  intent?: "answer" | "strategy";
  findings?: ReadonlyArray<{ summary: string }>;
  originalRequest?: string;
  statedSteps?: ReadonlyArray<{ label: string }>;
}): string {
  const top = input.candidates?.feasible[0];
  if (top) {
    const rates = top.venue === "earn" ? "Earn and Blend supply rates" : "live farm rates";
    const carry = top.netAprPct
      ? `Blend’s supply rate minus borrow cost is about ${Number(top.netAprPct).toFixed(2)}% APR before fees.`
      : "That uses idle funds only, so health factor does not move.";
    const floor = input.capacity
      ? ` Sized so health stays at or above ${Number(input.capacity.floor).toFixed(2)}.`
      : "";
    const hf = top.finalHealthFactor
      ? ` Health factor after this would be ${Number(top.finalHealthFactor).toFixed(2)}.`
      : "";
    const alt = input.candidates && input.candidates.feasible.length > 1
      ? " A no-borrow alternative is listed if you want to stay out of new debt."
      : "";
    return `I compared ${rates} against your position. Best path: ${top.label} for ${money(top.amountUsd)}. ${carry}${floor}${hf}${alt} Approve to run those steps.`;
  }
  if (input.candidates?.rejected.length) {
    return `I compared the live rates against your constraints. No borrowing path makes money after borrow cost. ${input.candidates.rejected[0].reason} Nothing was executed.`;
  }
  if (input.status === "needs_input") {
    return input.question
      ? `I’ve checked the available information. One choice still changes the plan: ${input.question}`
      : "I’ve checked the available information. One choice needs your input.";
  }
  if (input.status === "blocked") {
    return "I couldn’t complete this investigation with the available capabilities and information.";
  }
  if (input.status === "incomplete") {
    return "The investigation stopped before it could finish. The completed reads are shown below; no strategy was executed.";
  }
  if (input.statedSteps?.length) {
    const list = input.statedSteps.map((step) => step.label).join(", then ");
    const body = list.charAt(0).toUpperCase() + list.slice(1);
    return input.statedSteps.length === 1
      ? `${body}. Approve to run this step.`
      : `${body}. Approve to run these steps.`;
  }
  if (input.intent === "strategy") {
    if (input.findings?.length) return input.findings.map((finding) => finding.summary).join(" ");
    return "The plan below uses the amounts in your request. Approve to run it.";
  }
  const facts = factualAnswer(input.facts, input.originalRequest);
  if (facts) return facts;
  // Conceptual answers are language, not sized amounts. Publishing findings here is
  // the only way "what is a health factor?" gets a definition instead of silence.
  if (input.intent === "answer" && input.findings?.length) {
    return input.findings.map((finding) => finding.summary).join(" ");
  }
  return "The completed checks are shown below.";
}
