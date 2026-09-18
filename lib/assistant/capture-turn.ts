/**
 * One capture for one Assistant send: semantic JSON + legacy snapshot
 * (metrics, tables, region text, selection).
 */

import {
  capturePageSnapshot,
  type CaptureRect,
  type PageSnapshot,
} from "@/lib/assistant/capture-page";
import {
  captureSemanticPageContext,
  type SemanticPageContext,
} from "@/lib/assistant/semantic-page-context";

export type AssistantTurnCapture = {
  semantic: SemanticPageContext;
  snapshot: PageSnapshot;
};

export function captureAssistantTurn(opts?: {
  region?: CaptureRect | null;
}): AssistantTurnCapture {
  const snapshot = capturePageSnapshot({
    maxChars: 14_000,
    region: opts?.region ?? null,
  });
  const semantic = captureSemanticPageContext();
  if (snapshot.selection && !semantic.selectedText) {
    semantic.selectedText = snapshot.selection;
  }
  if (snapshot.region_text && !semantic.selectedText) {
    semantic.selectedText = snapshot.region_text.slice(0, 2_000);
  }
  return { semantic, snapshot };
}
