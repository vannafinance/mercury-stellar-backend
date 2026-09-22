import type { StructuredAnswer } from "../answer-schema";
import type { ResearchView } from "./view";

/**
 * The investigation stores every read it made so the sizer can reuse them. That bag is
 * not the answer — replaying it as a wallet/APR/liquidity grid is what showed up in
 * history. The card is the headline only; the facts stay on the research view.
 */
export function investigationAnswerDocument(result: ResearchView): StructuredAnswer {
  return {
    headline: result.message,
    facts: [],
  };
}
