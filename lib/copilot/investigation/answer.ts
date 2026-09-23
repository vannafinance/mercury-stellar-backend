import type { ResearchFact, ResearchView } from "./view";
import type { CandidateSet } from "./candidates";
import type { ResearchCapacity } from "./view";
import { ASSET_IDS } from "../registry/assets";
import { blendSupplyApyFromApr } from "../../rate-display";
import { deploysIntoPosition } from "../workflow/types";

const NAMED_ASSET = new RegExp(`\\b(${ASSET_IDS.join("|")})\\b`, "g");

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
    (request.toUpperCase().match(NAMED_ASSET) ?? []),
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
    if (isDebtTotal(fact)) return wantsDebt;
    if (["earn", "blend"].includes(fact.venue) && fact.unit === "% APR") return wantsRates;
    return true;
  });
}

/** The account-level debt figure, whichever read carried it. Facts are matched by source field, never by display copy. */
function isDebtTotal(fact: ResearchFact): boolean {
  return fact.venue === "margin" && fact.unit === "USD" && (fact.sourcePath === "total_debt_usd" || fact.sourcePath === "debt_usd");
}

/**
 * One sentence per read that returned rows: "Debt: XLM 14,113.4967 ($2,540.43),
 * BLUSDC 772 ($772); total $3,312.25." Rows are recognised by their source path
 * (`<list>[<index>].<field>`), the asset by the label the fact carries (the registry's
 * spelling, not the wire's), the money by the unit. Nothing is named here by capability.
 */
function rowSentences(facts: readonly ResearchFact[]): Array<{ evidenceId: string; sentence: string }> {
  interface Row { asset: string; amounts: string[]; usd: string | null }
  const groups = new Map<string, { evidenceId: string; name: string; rows: Map<string, Row>; total: string | null }>();
  const money = (value: string) => `$${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const tokens = (value: string) => Number(value).toLocaleString("en-US", { maximumFractionDigits: 7 });
  for (const fact of facts) {
    const row = /^([a-z_]+)\[(\d+)\]\.([a-z_]+)$/i.exec(fact.sourcePath);
    if (!row || !Number.isFinite(Number(fact.value))) continue;
    const [, list, index, field] = row;
    const words = fact.label.split(" ");
    const asset = /^[A-Z0-9]{2,12}$/.test(words[0]) ? words[0] : null;
    if (!asset) continue;
    // The group's name is the label with the asset and the field's words removed: "margin debt".
    const fieldWords = field.split("_").map((w) => w.toLowerCase());
    const name = words.slice(1).filter((w) => !fieldWords.includes(w.toLowerCase())).join(" ").trim();
    const key = `${fact.evidenceId}:${list}`;
    const group = groups.get(key) ?? { evidenceId: fact.evidenceId, name: name || list.replaceAll("_", " "), rows: new Map<string, Row>(), total: null };
    const entry = group.rows.get(`${index}:${asset}`) ?? { asset, amounts: [], usd: null };
    /**
     * Only an amount of the row's own token may become the row's number.
     *
     * This used to push EVERY non-USD number into `amounts` and then print `amounts[0]`,
     * so which figure the user saw was decided by the order of keys in the payload rather
     * than by what the figure meant. A Blend position row carries `b_rate` beside the
     * balance, and on 20 Sep that rate was printed as the user's holding — "Blend: XLM
     * 2.0749225" for an account whose actual supply was something else entirely. The read
     * was correct, the routing was correct, MCP returned the balance: the renderer picked
     * the wrong field. `quantity` is set where the unit is derived, so a rate, ratio,
     * health factor or percentage can never be mistaken for a balance again — including
     * ones nobody has enumerated, because it is decided by how the unit was built.
     */
    if (fact.unit === "USD") entry.usd = entry.usd ?? money(fact.value);
    else if (fact.quantity) entry.amounts.push(tokens(fact.value));
    group.rows.set(`${index}:${asset}`, entry);
    groups.set(key, group);
  }
  for (const fact of facts) {
    if (!/^total_.*usd$/i.test(fact.sourcePath) || !Number.isFinite(Number(fact.value))) continue;
    for (const group of groups.values()) if (group.evidenceId === fact.evidenceId && group.total === null) group.total = money(fact.value);
  }
  for (const group of groups.values()) {
    // A row left with neither a token amount nor a USD value has nothing to report. It
    // used to render as a bare symbol, or worse, borrow whatever number happened to be
    // in the row. Saying nothing is the honest outcome; the caller's other sentences
    // still cover what was read.
    for (const [key, row] of group.rows) if (!row.amounts.length && !row.usd) group.rows.delete(key);
  }
  return [...groups.values()].filter((group) => group.rows.size).map((group) => {
    const rows = [...group.rows.values()].map((row) => `${row.asset} ${row.amounts[0] ?? ""}${row.usd ? ` (${row.usd})` : ""}`.trim());
    const name = group.name.charAt(0).toUpperCase() + group.name.slice(1);
    return { evidenceId: group.evidenceId, sentence: `${name}: ${rows.join(", ")}${group.total ? `; total ${group.total}` : ""}.` };
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
  /**
   * Every read that came back as ROWS — a debt per asset, a collateral line, an Earn or
   * Blend position — is printed row by row, from the facts themselves. 14 Sep: "what are
   * the debt tokens I am holding" was answered with the USD total alone, because only the
   * total had a sentence here while the two debt rows the read returned had none.
   */
  const rowLines = rowSentences(selected.filter((f) => f.venue !== "wallet"));
  sentences.push(...rowLines.map((line) => line.sentence));
  const debt = selected.find(f => f.sourcePath === "total_debt_usd") ?? selected.find(isDebtTotal);
  if (debt && !rowLines.some((line) => line.evidenceId === debt.evidenceId)) sentences.push(`Your reported margin debt is ${amount(debt)}.`);
  const prices = selected.filter(f => f.venue === "oracle");
  for (const price of prices) sentences.push(`${price.label}: ${amount(price)}.`);
  const eligibility = selected.filter(f => f.sourcePath === "allowed" && f.venue === "margin");
  for (const fact of eligibility) {
    sentences.push(`${fact.label} is ${fact.value} on the current health check.`);
  }
  // One line per market: the same reserve can arrive from two reads (list + stats) and must not print twice.
  const rates = [...new Map(selected.filter(f => ["earn", "blend"].includes(f.venue) && f.unit === "% APR" && f.label.includes("supply")).map(f => [f.label, f])).values()];
  /**
   * Quote each venue the way its own page does, as APY.
   *
   * The facts stay APR — carry maths compares a supply rate with a borrow rate and must compare
   * like with like. Only what the user READS changes, and it has to match the product, which
   * uses two conventions: the Earn page shows its supply rate as-is (`pool-stats.ts`, verified
   * 23 Sep: 2.759984% here, 2.76% on /earn), while Blend compounds weekly (`rate-display.ts`,
   * the same function the Farm page now calls). Quoting Blend as 173% APR beside a Farm page
   * showing 450% APY read as one of the two surfaces lying.
   */
  const shownApy = (f: ResearchFact) => {
    const apr = Number(f.value);
    if (!Number.isFinite(apr)) return amount(f);
    const pct = f.venue === "blend" ? blendSupplyApyFromApr(apr / 100) * 100 : apr;
    return `${pct.toFixed(2)}% APY`;
  };
  if (rates.length) sentences.push(`Supply APY: ${rates.map(f => `${f.label.replace(" supply APR", "")} ${shownApy(f)}`).join("; ")}.`);
  return sentences.length ? sentences.join(" ") : null;
}

/** What the wallet holds that a plan could use, from the wallet read's own rows — spendable where the read states it. */
function idleSummary(facts: readonly ResearchFact[]): string | null {
  const bySymbol = new Map<string, { balance?: string; spendable?: string }>();
  for (const fact of facts) {
    if (fact.venue !== "wallet") continue;
    const kind = fact.label.endsWith(" wallet spendable") ? "spendable" : fact.label.endsWith(" wallet balance") ? "balance" : null;
    if (!kind) continue;
    const symbol = fact.label.slice(0, fact.label.indexOf(" wallet "));
    bySymbol.set(symbol, { ...bySymbol.get(symbol), [kind]: fact.value });
  }
  if (!bySymbol.size) return null;
  const usable = (entry: { balance?: string; spendable?: string }) => entry.spendable ?? entry.balance ?? "0";
  const parts = [...bySymbol].map(([symbol, entry]) => {
    const held = entry.spendable !== undefined && entry.balance !== undefined && entry.spendable !== entry.balance
      ? `${trimNumber(entry.spendable)} spendable of ${trimNumber(entry.balance)}` : trimNumber(usable(entry));
    return `${symbol} ${held}`;
  });
  const anything = [...bySymbol.values()].some((entry) => Number(usable(entry)) > 0);
  return anything
    ? `Idle in the wallet: ${parts.join(", ")}.`
    : `Nothing idle to deploy — wallet: ${parts.join(", ")} (XLM within the minimum balance plus fee reserve does not count).`;
}

function trimNumber(value: string): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 4 }) : value;
}

/** Display rounding only. Sizing and stored facts keep the full-precision string. */
export function formatHealthFactor(value: string): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : value;
}

/**
 * A plan's rate as the venue pages show it: the APY when the sizer computed one (apy.ts),
 * otherwise the APR, labelled as the APR it is. Never an APR figure with an APY label.
 */
function shownRate(apyPct: string | null | undefined, aprPct: string, prefix = ""): string {
  return apyPct != null ? `${Number(apyPct).toFixed(2)}% ${prefix}APY` : `${Number(aprPct).toFixed(2)}% ${prefix}APR`;
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
  /** Why the loop stopped, when it did — an `incomplete` turn reads differently for each. */
  stopReason?: string | null;
}): string {
  const top = input.candidates?.feasible[0];
  if (top) {
    if (top.decision?.runnerUpId && top.decision.reason) {
      const alt = input.candidates && input.candidates.feasible.length > 1
        ? " Switch → to use the next option instead."
        : "";
      const floor = input.capacity
        ? ` Sized so health stays at or above ${Number(input.capacity.floor).toFixed(2)}.`
        : "";
      const hf = top.finalHealthFactor
        ? ` Health factor after this would be ${Number(top.finalHealthFactor).toFixed(2)}.`
        : "";
      return `${top.decision.reason}${floor}${hf} Approve to run those steps.${alt}`;
    }
    /**
     * A composed plan's headline is its own title and rationale, with the numbers the
     * sizer produced — one source for the options and the prose, so they cannot disagree.
     */
    if (top.steps?.length) {
      const legs = top.steps.map((step) => step.label.charAt(0).toLowerCase() + step.label.slice(1)).join(", then ");
      // A plan that only repays earns nothing; say what it repays, not an APR on it.
      const repays = top.steps.filter((step) => step.op === "repay");
      // The step list is the structured source of truth for funding. A composed plan can
      // borrow and then supply, so its supply leg must not be described as idle-wallet cash.
      const includesBorrow = top.steps.some((step) => step.op === "borrow");
      /**
       * Whether the plan puts money INTO a position at all, read off OP_FLOW, never a verb.
       * 23 Sep, X12: four Earn redeems were captioned "using idle funds only; the supply rate
       * could not be read". A plan that only takes money out has no supply rate and spends
       * no idle funds, so it gets no rate sentence; its amount is on the card.
       */
      const deploys = top.steps.some((step) => deploysIntoPosition(step.op));
      const rate = repays.length && repays.length === top.steps.filter((step) => step.op !== "deposit_collateral").length
        ? ` Repays ${repays.map((step) => `${step.amount} ${step.asset}`).join(" and ")} of margin debt from the wallet.`
        : !deploys ? ""
        : top.netAprPct !== null
          ? ` About ${shownRate(top.netApyPct, top.netAprPct, "net ")} after borrow cost, before fees.`
          : top.supplyAprPct === null
            ? includesBorrow
              ? ` ${money(top.amountUsd)}; this plan includes borrowing, and the supply rate could not be read this time.`
              : ` ${money(top.amountUsd)} using idle funds only; the supply rate could not be read this time.`
            : includesBorrow
              ? ` About ${shownRate(top.supplyApyPct, top.supplyAprPct)} on ${money(top.amountUsd)}; this plan includes borrowing.`
              : ` About ${shownRate(top.supplyApyPct, top.supplyAprPct)} on ${money(top.amountUsd)}, using idle funds only.`;
      const hf = top.finalHealthFactor
        ? ` Health factor after this would be ${Number(top.finalHealthFactor).toFixed(2)}.`
        : top.repaysAllDebt ? " No debt would remain." : "";
      const others = input.candidates && input.candidates.feasible.length > 1
        ? ` ${input.candidates.feasible.length - 1} other option${input.candidates.feasible.length > 2 ? "s" : ""} below.`
        : "";
      return `${top.label}: ${legs}.${rate}${hf}${others} Approve to run those steps.`;
    }
    const rates = top.venue === "earn" ? "Earn and Blend supply rates" : "live farm rates";
    const carry = top.netAprPct
      ? `Blend’s supply rate minus borrow cost is about ${shownRate(top.netApyPct, top.netAprPct)} before fees.`
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
    // Say why each shape was ruled out — the reasons are the analysis; there is no stock verdict.
    const reasons = input.candidates.rejected.slice(0, 3).map((entry) => `${entry.label} — ${entry.reason.replace(/\.$/, "")}`).join("; ");
    return `I checked ${input.candidates.rejected.length === 1 ? "the shape" : `${input.candidates.rejected.length} shapes`} against your position and the live rates, and none could be prepared: ${reasons}. Nothing was executed.`;
  }
  if (input.status === "needs_input") {
    /**
     * An open question is a choice the user must make OR a gap the reads left ("no pool
     * is available") — the model uses the same field for both, and only the first is
     * something to answer. Say "unresolved" and let the text speak; "one choice" was a
     * lie half the time (13 Sep: a false "no Aquarius pool" read was shown as a choice).
     */
    return input.question
      ? `I’ve checked the available information. Before a plan can be prepared, this is unresolved: ${input.question}`
      : "I’ve checked the available information. One point needs your input before a plan can be prepared.";
  }
  if (input.status === "blocked") {
    return "I couldn’t complete this investigation with the available capabilities and information.";
  }
  if (input.status === "incomplete") {
    /**
     * Why it stopped changes what the user should do, so it changes the sentence. A
     * cancelled run is not a failure and must not invite a blind retry — it is what a page
     * reload or a second prompt does to the first one, and telling the user it "ran out of
     * time, please try again" sent them to retry something that was never slow (15 Sep).
     */
    if (input.stopReason === "cancelled") {
      return "This run was cancelled before it finished — a reload or a new prompt replaces the one in flight. Nothing was executed.";
    }
    if (input.stopReason === "deadline") {
      return "The investigation ran out of time before it could finish. The completed reads are shown below; no strategy was executed.";
    }
    if (input.stopReason === "invalid_evidence" || input.stopReason === "invalid_decision") {
      return "The investigation could not be completed from the reads it made. Nothing was executed — please try again.";
    }
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
    /**
     * A strategy turn with nothing to offer and nothing ruled out is usually a wallet with
     * nothing idle — and the card must say so, from the wallet read, or the user is left
     * with a rate list and no reason (13 Sep: 3.97 XLM, all of it minimum balance).
     */
    const idle = !input.candidates?.feasible.length && !input.candidates?.rejected.length ? idleSummary(input.facts) : null;
    const findings = input.findings?.length ? input.findings.map((finding) => finding.summary).join(" ") : null;
    // The answer to what was asked comes first, then what is idle (owner, 23 Sep: "lend AQUA"
    // opened with a wallet list before saying Earn has no AQUA pool).
    if (idle || findings) return [findings, idle].filter(Boolean).join(" ");
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
