"use client";

/**
 * Live semantic pageContext hook (plan Step 1).
 * - Rescans DOM on route change
 * - Tracks selectedText via selectionchange
 */

import { useCallback, useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  captureSemanticPageContext,
  type SemanticPageContext,
} from "@/lib/assistant/semantic-page-context";

export function useSemanticPageContext(): {
  pageContext: SemanticPageContext | null;
  refresh: () => SemanticPageContext;
  selectedText: string | null;
} {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pageContext, setPageContext] = useState<SemanticPageContext | null>(null);
  const [selectedText, setSelectedText] = useState<string | null>(null);

  const refresh = useCallback(() => {
    const ctx = captureSemanticPageContext();
    setPageContext(ctx);
    setSelectedText(ctx.selectedText);
    return ctx;
  }, []);

  // Route change → re-scan
  useEffect(() => {
    // Defer one frame so the new route has painted
    const t = window.setTimeout(() => refresh(), 50);
    return () => window.clearTimeout(t);
  }, [pathname, searchParams, refresh]);

  // Real-time selection
  useEffect(() => {
    const onSel = () => {
      try {
        const t = window.getSelection()?.toString()?.trim() || null;
        setSelectedText(t ? t.slice(0, 2_000) : null);
        setPageContext((prev) =>
          prev
            ? { ...prev, selectedText: t ? t.slice(0, 2_000) : null }
            : prev,
        );
      } catch {
        /* ignore */
      }
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, []);

  // Initial
  useEffect(() => {
    refresh();
  }, [refresh]);

  return { pageContext, refresh, selectedText };
}
