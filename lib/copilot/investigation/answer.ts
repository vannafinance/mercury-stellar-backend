import type { ResearchFact, ResearchView } from "./view";
import type { CandidateSet } from "./candidates";
import type { ResearchCapacity } from "./view";

/** Conversational factual answers use audited fields; model prose cannot invent balances. */
export function factualAnswer(facts: readonly ResearchFact[]): string | null {
  const amount = (fact: ResearchFact) => {
    const n = Number(fact.value);
    const value = Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 7 }) : fact.value;
    return fact.unit === "USD" ? `$${value}` : `${value} ${fact.unit}`.trim();
  };
  const sentences: string[] = [];
  const balances = facts.filter(f => f.venue === "wallet" && f.sourcePath.endsWith(".balance"));
  if (balances.length) sentences.push(`Your wallet holds ${balances.map(amount).join(", ")}.`);
  const health = facts.find(f => f.venue === "margin" && f.unit === "HF");
  if (health) sentences.push(`Your reported health factor is ${health.value}.`);
  const debt = facts.find(f => f.label === "Total margin debt") ?? facts.find(f => f.label === "Reported debt value");
  if (debt) sentences.push(`Your reported margin debt is ${amount(debt)}.`);
  const prices = facts.filter(f => f.venue === "oracle");
  for (const price of prices) sentences.push(`${price.label}: ${amount(price)}.`);
  const rates = facts.filter(f => ["earn", "blend"].includes(f.venue) && f.unit === "% APR" && f.label.includes("supply"));
  if (rates.length) sentences.push(`The reported supply rates are ${rates.map(f => `${f.label.replace(" supply APR", "")}: ${amount(f)}`).join("; ")}.`);
  return sentences.length ? sentences.join(" ") : null;
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
  return factualAnswer(input.facts) ?? "The completed checks are shown below.";
}
