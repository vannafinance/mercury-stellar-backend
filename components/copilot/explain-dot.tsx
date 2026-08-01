"use client";

import { askAssistant } from "./assistant-launcher";

/** Small “?” next to a metric label that opens the assistant with “what is X?”. */
export function ExplainDot({ label }: { label: string }) {
  return (
    <button
      type="button"
      aria-label={`What is ${label}?`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        askAssistant(`what is ${label}?`);
      }}
      className="ml-1 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full
                 text-[9px] font-semibold text-[#A0A0A0] ring-1 ring-[#D0D0D0]
                 hover:text-[#703AE6] hover:ring-[#703AE6] transition-colors align-middle"
    >
      ?
    </button>
  );
}
