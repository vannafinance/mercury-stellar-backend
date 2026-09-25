"use client";

import React, { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { Check, X, ArrowLeft, ArrowRight, CornerDownLeft } from "lucide-react";
import { useTheme } from "@/contexts/theme-context";
import type {
  Questionnaire,
  QuestionnaireOption,
  QuestionnaireStep,
  QuestionnaireAnswers,
  QuestionnaireSection,
  QuestionnaireSectionAnswer,
} from "@/lib/copilot/investigation/view";

export interface ClarifyQuestionnaireProps {
  questionnaire: Questionnaire;
  onSubmit(answers: QuestionnaireAnswers): void;
  onCancel(): void;
  onSomethingElse(text: string): void;
  busy?: boolean;
}

const BTN_PRIMARY =
  "rounded-lg bg-gradient px-4 py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 disabled:cursor-not-allowed disabled:opacity-45";
const BTN_QUIET =
  "rounded-lg border border-vgray-200 dark:border-[#2A2A2A] px-3.5 py-2 text-[13px] font-semibold text-vgray-800 dark:text-vgray-200 transition-colors hover:border-violet-400 hover:text-violet-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 disabled:cursor-not-allowed disabled:text-vgray-300 dark:disabled:text-vgray-600";

const PRESET_COLORS: Record<string, string> = {
  "25": "bg-[#703AE6] text-white",
  "50": "bg-[#FC5457] text-white",
  "75": "bg-[#E63ABB] text-white",
  "100": "bg-[#FF007A] text-white",
};

const DEFAULT_PRESETS = [
  { id: "25", label: "25%", percent: "25" },
  { id: "50", label: "50%", percent: "50" },
  { id: "75", label: "75%", percent: "75" },
  { id: "100", label: "Max", percent: "100" },
];

export function buildQuestionnaireSummary(
  questionnaire: { title?: string },
  assetOption?: QuestionnaireOption,
  venueOption?: QuestionnaireOption | null,
  amount?: { kind: "fraction"; percent: string } | { kind: "literal"; amount: string } | { kind: "previous_leg" }
): string {
  const verb = questionnaire.title ? questionnaire.title.split(" ")[0] : "Supply";
  const assetLabel = assetOption?.label || "asset";

  let amountStr = "";
  if (amount) {
    if (amount.kind === "fraction") {
      amountStr = `${amount.percent}% of my ${assetLabel}`;
    } else if (amount.kind === "previous_leg") {
      amountStr = `all of the ${assetLabel}`;
    } else {
      amountStr = `${amount.amount} ${assetLabel}`;
    }
  } else {
    amountStr = assetLabel;
  }

  let venueStr = "";
  if (venueOption) {
    venueStr = `to ${venueOption.label}`;
  }

  return [verb, amountStr, venueStr].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

interface SectionInternalState {
  assetId: string | null;
  venueId: string | null;
  amountRaw: string;
  activeStepIdx: number;
  linkedOptionId?: string | null;
}

export function ClarifyQuestionnaire({
  questionnaire,
  onSubmit,
  onCancel,
  onSomethingElse,
  busy = false,
}: ClarifyQuestionnaireProps) {
  const { isDark } = useTheme();

  // Normalize sections: multi-section or single-section wrapped
  const sections: QuestionnaireSection[] = useMemo(() => {
    if (questionnaire.sections && questionnaire.sections.length > 0) {
      return questionnaire.sections;
    }
    return [
      {
        id: questionnaire.id || "default",
        title: questionnaire.title,
        actionIndex: 0,
        steps: questionnaire.steps,
      },
    ];
  }, [questionnaire]);

  const isMultiSection = Boolean(questionnaire.sections && questionnaire.sections.length > 1);

  // Per-section state
  const [sectionStates, setSectionStates] = useState<Record<string, SectionInternalState>>(() => {
    const initial: Record<string, SectionInternalState> = {};
    for (const sec of sections) {
      const assetStep = sec.steps.find((s) => s.slot === "asset");
      const defaultAssetId = assetStep && assetStep.options.length === 1 ? assetStep.options[0].id : null;
      const venueStep = sec.steps.find((s) => s.slot === "venue");
      let defaultVenueId: string | null = null;
      if (venueStep) {
        const available = venueStep.options.filter(
          (opt) => !opt.forAsset || (defaultAssetId && opt.forAsset.toLowerCase() === defaultAssetId.toLowerCase())
        );
        if (available.length === 1) {
          defaultVenueId = available[0].id;
        }
      }
      initial[sec.id] = {
        assetId: defaultAssetId,
        venueId: defaultVenueId,
        amountRaw: "",
        activeStepIdx: 0,
      };
    }
    return initial;
  });

  const [activeSectionIdx, setActiveSectionIdx] = useState<number>(0);
  const [somethingElseText, setSomethingElseText] = useState<string>("");
  const [focusedOptionIdx, setFocusedOptionIdx] = useState<number>(0);
  const [submitted, setSubmitted] = useState<boolean>(false);

  const containerRef = useRef<HTMLDivElement>(null);

  const currentSection = sections[activeSectionIdx] || sections[0];
  const currentState = sectionStates[currentSection.id] || {
    assetId: null,
    venueId: null,
    amountRaw: "",
    activeStepIdx: 0,
  };

  // Helper: Filter step options based on chosen asset
  const getStepAvailableOptions = useCallback(
    (step: QuestionnaireStep, currentAssetId: string | null): QuestionnaireOption[] => {
      if (step.slot === "venue") {
        if (!currentAssetId) return step.options;
        return step.options.filter(
          (opt) => !opt.forAsset || opt.forAsset.toLowerCase() === currentAssetId.toLowerCase()
        );
      }
      return step.options;
    },
    []
  );

  // Check if a step should be auto-skipped (single available option, non-amount)
  const isStepAutoSkipped = useCallback(
    (section: QuestionnaireSection, stepIdx: number, assetId: string | null): boolean => {
      const step = section.steps[stepIdx];
      if (!step) return false;
      if (step.slot === "amount") return false;
      const opts = getStepAvailableOptions(step, assetId);
      return opts.length <= 1;
    },
    [getStepAvailableOptions]
  );

  // Auto-skip or advance if current step is single-option
  useEffect(() => {
    const sec = currentSection;
    const st = sectionStates[sec.id];
    if (!st) return;

    const currentStep = sec.steps[st.activeStepIdx];
    if (!currentStep) return;

    // Auto-select single asset if not selected
    if (currentStep.slot === "asset" && currentStep.options.length === 1 && !st.assetId) {
      const singleId = currentStep.options[0].id;
      setSectionStates((prev) => ({
        ...prev,
        [sec.id]: {
          ...prev[sec.id],
          assetId: singleId,
        },
      }));
    }

    // Auto-advance if this step is single-option and can be skipped
    if (isStepAutoSkipped(sec, st.activeStepIdx, st.assetId)) {
      let resolvedVenueId = st.venueId;
      if (currentStep.slot === "venue") {
        const available = getStepAvailableOptions(currentStep, st.assetId);
        if (available.length === 1 && !resolvedVenueId) {
          resolvedVenueId = available[0].id;
        }
      }

      // Advance to next non-skipped step if available
      let nextIdx = st.activeStepIdx + 1;
      while (nextIdx < sec.steps.length && isStepAutoSkipped(sec, nextIdx, st.assetId)) {
        const skipped = sec.steps[nextIdx];
        if (skipped.slot === "venue" && !resolvedVenueId) {
          const available = getStepAvailableOptions(skipped, st.assetId);
          if (available.length === 1) {
            resolvedVenueId = available[0].id;
          }
        }
        nextIdx++;
      }
      if (nextIdx < sec.steps.length && nextIdx !== st.activeStepIdx) {
        setSectionStates((prev) => ({
          ...prev,
          [sec.id]: {
            ...prev[sec.id],
            venueId: resolvedVenueId,
            activeStepIdx: nextIdx,
          },
        }));
      } else if (resolvedVenueId !== st.venueId) {
        setSectionStates((prev) => ({
          ...prev,
          [sec.id]: {
            ...prev[sec.id],
            venueId: resolvedVenueId,
          },
        }));
      }
    }
  }, [currentSection, sectionStates, isStepAutoSkipped, getStepAvailableOptions]);

  // Max info calculation for a section
  const getSectionMaxInfo = useCallback(
    (sec: QuestionnaireSection, venueId: string | null, assetId: string | null) => {
      const amountStep = sec.steps.find((s) => s.slot === "amount");
      if (!amountStep?.max) return null;
      if (venueId && amountStep.max[venueId]) {
        return amountStep.max[venueId];
      }
      if (assetId && amountStep.max[assetId]) {
        return amountStep.max[assetId];
      }
      const entry = Object.entries(amountStep.max).find(([k]) =>
        venueId
          ? k.toLowerCase() === venueId.toLowerCase()
          : assetId
          ? k.toLowerCase() === assetId.toLowerCase()
          : false
      );
      return entry ? entry[1] : null;
    },
    []
  );

  const currentMaxInfo = useMemo(() => {
    return getSectionMaxInfo(currentSection, currentState.venueId, currentState.assetId);
  }, [currentSection, currentState.venueId, currentState.assetId, getSectionMaxInfo]);

  // Amount parsing and validation
  type ParsedAmountResult =
    | { kind: "fraction"; percent: string; convertedLiteral: string | null; error: null }
    | { kind: "literal"; amount: string; convertedLiteral?: null; error: null }
    | { kind: "error"; error: string; convertedLiteral?: null };

  const parseAmountValue = useCallback(
    (raw: string, maxInfo: ReturnType<typeof getSectionMaxInfo>): ParsedAmountResult | null => {
      const trimmed = raw.trim();
      if (!trimmed) return null;

      const maxAmountNum = maxInfo ? parseFloat(maxInfo.amount) : null;

      if (trimmed.endsWith("%")) {
        const pct = parseFloat(trimmed.slice(0, -1));
        if (!Number.isFinite(pct) || pct <= 0) return { kind: "error", error: "Invalid percentage" };
        if (pct > 100) return { kind: "error", error: "Percentage cannot exceed 100%" };
        const convertedLiteral =
          maxAmountNum !== null ? ((maxAmountNum * pct) / 100).toString() : null;
        return {
          kind: "fraction",
          percent: pct.toString(),
          convertedLiteral,
          error: null,
        };
      }

      const num = parseFloat(trimmed);
      if (!Number.isFinite(num) || num <= 0) return { kind: "error", error: "Invalid amount" };
      if (maxAmountNum !== null && num > maxAmountNum) {
        return {
          kind: "error",
          error: `Amount exceeds available ${maxInfo?.amount} ${maxInfo?.asset || ""}`.trim(),
        };
      }
      return {
        kind: "literal",
        amount: trimmed,
        convertedLiteral: null,
        error: null,
      };
    },
    []
  );

  // Source section amount resolver using sourceSectionId
  const getSourceSectionAmount = useCallback(
    (sourceSecId: string, statesOverride?: Record<string, SectionInternalState>): { amount: string; asset: string } | null => {
      const srcSec = sections.find((s) => s.id === sourceSecId);
      if (!srcSec) return null;
      const statesMap = statesOverride ?? sectionStates;
      const srcSt = statesMap[sourceSecId];
      if (!srcSt || !srcSt.amountRaw) return null;

      const assetStep = srcSec.steps.find((s) => s.slot === "asset");
      const assetOpt = assetStep?.options.find((o) => o.id === srcSt.assetId);
      const assetName = assetOpt?.label || srcSt.assetId?.toUpperCase() || "";

      const maxInfo = getSectionMaxInfo(srcSec, srcSt.venueId, srcSt.assetId);
      const parsed = parseAmountValue(srcSt.amountRaw, maxInfo);
      const amountVal = parsed?.kind === "fraction" && parsed.convertedLiteral
        ? parsed.convertedLiteral
        : parsed?.kind === "literal"
        ? parsed.amount
        : srcSt.amountRaw;

      return { amount: amountVal, asset: assetName };
    },
    [sections, sectionStates, getSectionMaxInfo, parseAmountValue]
  );

  // Linked option resolver: looks up source section's amount through sourceSectionId
  const resolveLinkedOptionAmount = useCallback(
    (opt: QuestionnaireOption | string, currentSecIdx: number, statesOverride?: Record<string, SectionInternalState>): { amount: string; asset: string } | null => {
      void currentSecIdx;
      const optObj = typeof opt === "string" ? undefined : opt;
      const srcId = optObj?.sourceSectionId ?? (optObj?.id.startsWith("previous:") ? optObj.id.split(":")[1] : undefined);
      if (srcId) {
        return getSourceSectionAmount(srcId, statesOverride);
      }
      return null;
    },
    [getSourceSectionAmount]
  );

  const currentParsedAmount = useMemo(() => {
    return parseAmountValue(currentState.amountRaw, currentMaxInfo);
  }, [currentState.amountRaw, currentMaxInfo, parseAmountValue]);

  // LP Pair info
  const currentLpPairInfo = useMemo(() => {
    const amountStep = currentSection.steps.find((s) => s.slot === "amount");
    if (!amountStep?.pair || !currentState.venueId) return null;
    return amountStep.pair[currentState.venueId] ?? null;
  }, [currentSection, currentState.venueId]);

  const currentLpMatchedAmount = useMemo(() => {
    if (!currentLpPairInfo || !currentLpPairInfo.perUnit) return null;
    const ratio = parseFloat(currentLpPairInfo.perUnit);
    if (!Number.isFinite(ratio)) return null;

    let baseAmount: number | null = null;
    if (currentParsedAmount && !currentParsedAmount.error) {
      if (currentParsedAmount.kind === "literal") {
        baseAmount = parseFloat(currentParsedAmount.amount);
      } else if (currentParsedAmount.convertedLiteral) {
        baseAmount = parseFloat(currentParsedAmount.convertedLiteral);
      }
    }
    if (baseAmount !== null && baseAmount > 0) {
      const matched = (baseAmount * ratio).toFixed(4);
      return matched.replace(/\.?0+$/, "");
    }
    return null;
  }, [currentLpPairInfo, currentParsedAmount]);

  // Section completeness check
  const isSectionComplete = useCallback(
    (sec: QuestionnaireSection, st: SectionInternalState | undefined): boolean => {
      if (!st) return false;
      const assetStep = sec.steps.find((s) => s.slot === "asset");
      const venueStep = sec.steps.find((s) => s.slot === "venue");
      const amountStep = sec.steps.find((s) => s.slot === "amount");

      if (assetStep && !st.assetId) return false;
      if (venueStep) {
        const available = getStepAvailableOptions(venueStep, st.assetId);
        if (available.length > 0 && !st.venueId) return false;
      }
      if (amountStep) {
        if (st.linkedOptionId) return true;
        const maxInfo = getSectionMaxInfo(sec, st.venueId, st.assetId);
        const parsed = parseAmountValue(st.amountRaw, maxInfo);
        if (!parsed || parsed.error) return false;
      }
      return true;
    },
    [getStepAvailableOptions, getSectionMaxInfo, parseAmountValue]
  );

  // Overall completeness: every section must be complete
  const isAllComplete = useMemo(() => {
    if (busy || submitted) return false;
    return sections.every((sec) => isSectionComplete(sec, sectionStates[sec.id]));
  }, [busy, submitted, sections, sectionStates, isSectionComplete]);

  // Summary helper for a section
  const getSectionChosenSummary = useCallback(
    (sec: QuestionnaireSection, st: SectionInternalState | undefined): string | null => {
      if (!st) return null;
      const assetStep = sec.steps.find((s) => s.slot === "asset");
      const venueStep = sec.steps.find((s) => s.slot === "venue");
      const amountStep = sec.steps.find((s) => s.slot === "amount");

      const assetOpt = assetStep?.options.find((o) => o.id === st.assetId);
      const venueOpt = venueStep?.options.find((o) => o.id === st.venueId);

      const maxInfo = getSectionMaxInfo(sec, st.venueId, st.assetId);
      const parsed = parseAmountValue(st.amountRaw, maxInfo);

      if (amountStep && parsed && !parsed.error) {
        if (parsed.kind === "fraction") {
          return `${parsed.percent}% ${assetOpt?.label || ""}`.trim();
        }
        if (parsed.kind === "literal") {
          return `${parsed.amount} ${assetOpt?.label || ""}`.trim();
        }
      }
      if (st.linkedOptionId) {
        return `all of the ${assetOpt?.label || ""}`.trim();
      }
      if (venueOpt) return venueOpt.label;
      if (assetOpt) return assetOpt.label;
      return null;
    },
    [getSectionMaxInfo, parseAmountValue]
  );

  // Re-validation helper: cascades changes in section `secIdx` to later sections
  const revalidateLaterSections = useCallback(
    (changedSecIdx: number, newStates: Record<string, SectionInternalState>) => {
      const updated = { ...newStates };
      for (let i = changedSecIdx + 1; i < sections.length; i++) {
        const sec = sections[i];
        const st = updated[sec.id];
        if (!st) continue;

        // Check if section had a linked amount
        if (st.linkedOptionId) {
          const amountStep = sec.steps.find((s) => s.slot === "amount");
          const linkedOpt = amountStep?.options.find((o) =>
            o.id === st.linkedOptionId || o.sourceSectionId || o.id.startsWith("previous:")
          );
          if (linkedOpt && st.linkedOptionId === linkedOpt.id) {
            const linked = resolveLinkedOptionAmount(linkedOpt, i, updated);
            if (linked) {
              // Keep linked amount in sync with source
              st.amountRaw = linked.amount;
            }
          }
        }

        // Revalidate amount against max
        const maxInfo = getSectionMaxInfo(sec, st.venueId, st.assetId);
        const maxAmountNum = maxInfo ? parseFloat(maxInfo.amount) : null;
        if (st.amountRaw && !st.amountRaw.endsWith("%") && maxAmountNum !== null && !st.linkedOptionId) {
          const num = parseFloat(st.amountRaw);
          if (Number.isFinite(num) && num > maxAmountNum) {
            // Amount no longer fits, clear it
            st.amountRaw = "";
          }
        }
        updated[sec.id] = { ...st };
      }
      return updated;
    },
    [sections, resolveLinkedOptionAmount, getSectionMaxInfo]
  );

  // Step Answer Summary for compact done rows
  const getStepAnswerSummary = (sec: QuestionnaireSection, step: QuestionnaireStep, st: SectionInternalState): string | null => {
    if (step.slot === "asset") {
      const opt = step.options.find((o) => o.id === st.assetId);
      return opt ? opt.label : null;
    }
    if (step.slot === "venue") {
      const opt = step.options.find((o) => o.id === st.venueId);
      return opt ? opt.label : null;
    }
    if (step.slot === "amount") {
      const maxInfo = getSectionMaxInfo(sec, st.venueId, st.assetId);
      const parsed = parseAmountValue(st.amountRaw, maxInfo);
      if (parsed && !parsed.error) {
        if (parsed.kind === "fraction") return `${parsed.percent}%`;
        if (parsed.kind === "literal") return `${parsed.amount} ${maxInfo?.asset || ""}`.trim();
      }
      return null;
    }
    return null;
  };

  // Pre-send editing: Clicking an answered row reopens that step with its current answer selected
  const handleReopenStep = (stepIdx: number) => {
    if (submitted) return;
    setSectionStates((prev) => ({
      ...prev,
      [currentSection.id]: {
        ...prev[currentSection.id],
        activeStepIdx: stepIdx,
      },
    }));
    setFocusedOptionIdx(0);
  };

  // Reopen a completed section
  const handleReopenSection = (secIdx: number) => {
    if (submitted) return;
    setActiveSectionIdx(secIdx);
    setSectionStates((prev) => {
      const targetSec = sections[secIdx];
      const targetSt = prev[targetSec.id];
      return {
        ...prev,
        [targetSec.id]: {
          ...targetSt,
          activeStepIdx: 0,
        },
      };
    });
    setFocusedOptionIdx(0);
  };

  // Option selection on current step
  const handleSelectOption = (optId: string) => {
    if (submitted) return;
    const sec = currentSection;
    const st = currentState;
    const step = sec.steps[st.activeStepIdx];
    if (!step) return;

    if (step.slot === "asset") {
      const newAssetId = optId;
      // Re-validate venue for this asset
      const venueStep = sec.steps.find((s) => s.slot === "venue");
      let nextVenueId = st.venueId;
      if (venueStep) {
        const availableVenues = getStepAvailableOptions(venueStep, newAssetId);
        if (nextVenueId && !availableVenues.some((o) => o.id.toLowerCase() === nextVenueId?.toLowerCase())) {
          nextVenueId = null;
        }
        if (!nextVenueId && availableVenues.length === 1) {
          nextVenueId = availableVenues[0].id;
        }
      }

      // Re-validate amount for this asset & venue
      let nextAmountRaw = st.amountRaw;
      const nextMax = getSectionMaxInfo(sec, nextVenueId, newAssetId);
      const nextMaxNum = nextMax ? parseFloat(nextMax.amount) : null;
      if (nextAmountRaw && !nextAmountRaw.endsWith("%") && nextMaxNum !== null) {
        const num = parseFloat(nextAmountRaw);
        if (Number.isFinite(num) && num > nextMaxNum) {
          nextAmountRaw = "";
        }
      }

      // Determine next active step: show cleared step again
      let nextStepIdx = st.activeStepIdx + 1;
      if (venueStep && !nextVenueId && getStepAvailableOptions(venueStep, newAssetId).length > 1) {
        nextStepIdx = sec.steps.findIndex((s) => s.slot === "venue");
      } else if (!nextAmountRaw && sec.steps.some((s) => s.slot === "amount")) {
        nextStepIdx = sec.steps.findIndex((s) => s.slot === "amount");
      }

      // Bound step index
      nextStepIdx = Math.min(nextStepIdx, sec.steps.length - 1);

      setSectionStates((prev) => {
        const updated = {
          ...prev,
          [sec.id]: {
            ...prev[sec.id],
            assetId: newAssetId,
            venueId: nextVenueId,
            amountRaw: nextAmountRaw,
            activeStepIdx: nextStepIdx,
          },
        };
        return revalidateLaterSections(activeSectionIdx, updated);
      });
      setFocusedOptionIdx(0);
    } else if (step.slot === "venue") {
      const newVenueId = optId;
      // Re-validate amount against new venue max
      let nextAmountRaw = st.amountRaw;
      const nextMax = getSectionMaxInfo(sec, newVenueId, st.assetId);
      const nextMaxNum = nextMax ? parseFloat(nextMax.amount) : null;
      if (nextAmountRaw && !nextAmountRaw.endsWith("%") && nextMaxNum !== null) {
        const num = parseFloat(nextAmountRaw);
        if (Number.isFinite(num) && num > nextMaxNum) {
          nextAmountRaw = "";
        }
      }

      const nextStepIdx = Math.min(st.activeStepIdx + 1, sec.steps.length - 1);
      setSectionStates((prev) => {
        const updated = {
          ...prev,
          [sec.id]: {
            ...prev[sec.id],
            venueId: newVenueId,
            amountRaw: nextAmountRaw,
            activeStepIdx: nextStepIdx,
          },
        };
        return revalidateLaterSections(activeSectionIdx, updated);
      });
      setFocusedOptionIdx(0);
    }
  };

  // Amount change handler
  const handleAmountChange = (val: string) => {
    if (submitted) return;
    setSectionStates((prev) => {
      const updated = {
        ...prev,
        [currentSection.id]: {
          ...prev[currentSection.id],
          amountRaw: val,
          linkedOptionId: null,
        },
      };
      return revalidateLaterSections(activeSectionIdx, updated);
    });
  };

  // Amount preset click
  const handlePresetClick = (percentStr: string) => {
    handleAmountChange(`${percentStr}%`);
  };

  // Max click
  const handleMaxClick = () => {
    if (currentMaxInfo?.amount) {
      handleAmountChange("100%");
    }
  };

  // Select a linked option (e.g. "All of the XLM you just deposited")
  const handleSelectLinkedOption = (opt: QuestionnaireOption) => {
    if (submitted) return;
    const linked = resolveLinkedOptionAmount(opt, activeSectionIdx);
    setSectionStates((prev) => {
      const updated = {
        ...prev,
        [currentSection.id]: {
          ...prev[currentSection.id],
          linkedOptionId: opt.id,
          amountRaw: linked ? linked.amount : prev[currentSection.id].amountRaw,
        },
      };
      return revalidateLaterSections(activeSectionIdx, updated);
    });
  };

  // Navigation: Back button reopens previous visible step
  const handleBack = () => {
    if (submitted) return;
    const sec = currentSection;
    const st = currentState;
    let prevIdx = st.activeStepIdx - 1;
    while (prevIdx >= 0 && isStepAutoSkipped(sec, prevIdx, st.assetId)) {
      prevIdx--;
    }
    if (prevIdx >= 0) {
      setSectionStates((prev) => ({
        ...prev,
        [sec.id]: {
          ...prev[sec.id],
          activeStepIdx: prevIdx,
        },
      }));
      setFocusedOptionIdx(0);
    } else if (activeSectionIdx > 0) {
      // Reopen previous section at its last step
      const prevSec = sections[activeSectionIdx - 1];
      setActiveSectionIdx(activeSectionIdx - 1);
      setSectionStates((prev) => ({
        ...prev,
        [prevSec.id]: {
          ...prev[prevSec.id],
          activeStepIdx: prevSec.steps.length - 1,
        },
      }));
      setFocusedOptionIdx(0);
    }
  };

  // Navigation: Next button
  const handleNext = () => {
    if (submitted) return;
    const sec = currentSection;
    const st = currentState;
    let nextIdx = st.activeStepIdx + 1;
    while (nextIdx < sec.steps.length && isStepAutoSkipped(sec, nextIdx, st.assetId)) {
      nextIdx++;
    }
    if (nextIdx < sec.steps.length) {
      setSectionStates((prev) => ({
        ...prev,
        [sec.id]: {
          ...prev[sec.id],
          activeStepIdx: nextIdx,
        },
      }));
      setFocusedOptionIdx(0);
    } else if (activeSectionIdx < sections.length - 1) {
      // Advance to next section
      setActiveSectionIdx(activeSectionIdx + 1);
      setFocusedOptionIdx(0);
    }
  };

  // Submit questionnaire
  const handleSubmit = () => {
    if (!isAllComplete || submitted) return;
    setSubmitted(true);

    if (isMultiSection) {
      const sectionAnswers: QuestionnaireSectionAnswer[] = sections.map((sec) => {
        const st = sectionStates[sec.id];
        const maxInfo = getSectionMaxInfo(sec, st.venueId, st.assetId);
        const parsed = parseAmountValue(st.amountRaw, maxInfo);

        let amountAnswer: QuestionnaireSectionAnswer["amount"];
        if (st.linkedOptionId) {
          amountAnswer = { kind: "previous_leg" };
        } else if (parsed?.kind === "fraction") {
          amountAnswer = { kind: "fraction" as const, percent: parsed.percent };
        } else {
          amountAnswer = {
            kind: "literal" as const,
            amount: parsed?.kind === "literal" ? parsed.amount : (st.amountRaw || "0"),
          };
        }

        return {
          sectionId: sec.id,
          asset: st.assetId || "",
          venue: st.venueId,
          amount: amountAnswer,
        };
      });

      // Overall multi-section summary
      const summaryParts = sections.map((sec, i) => {
        const ans = sectionAnswers[i];
        const assetStep = sec.steps.find((s) => s.slot === "asset");
        const venueStep = sec.steps.find((s) => s.slot === "venue");
        const assetOpt = assetStep?.options.find((o) => o.id === ans.asset);
        const venueOpt = venueStep?.options.find((o) => o.id === ans.venue);
        return buildQuestionnaireSummary({ title: sec.title }, assetOpt, venueOpt, ans.amount);
      });
      const summary = summaryParts.join(", ");

      const answers: QuestionnaireAnswers = {
        questionnaireId: questionnaire.id,
        asset: sectionAnswers[0]?.asset || "",
        venue: sectionAnswers[0]?.venue ?? null,
        amount: sectionAnswers[0]?.amount ?? { kind: "literal", amount: "0" },
        summary,
        sections: sectionAnswers,
      };

      onSubmit(answers);
    } else {
      const sec = sections[0];
      const st = sectionStates[sec.id];
      const maxInfo = getSectionMaxInfo(sec, st.venueId, st.assetId);
      const parsed = parseAmountValue(st.amountRaw, maxInfo);

      const assetStep = sec.steps.find((s) => s.slot === "asset");
      const venueStep = sec.steps.find((s) => s.slot === "venue");
      const assetOpt = assetStep?.options.find((o) => o.id === st.assetId);
      const venueOpt = venueStep?.options.find((o) => o.id === st.venueId) ?? null;

      let amountAnswer: QuestionnaireAnswers["amount"];
      if (st.linkedOptionId) {
        amountAnswer = { kind: "previous_leg" };
      } else if (parsed?.kind === "fraction") {
        amountAnswer = { kind: "fraction" as const, percent: parsed.percent };
      } else {
        amountAnswer = {
          kind: "literal" as const,
          amount: parsed?.kind === "literal" ? parsed.amount : (st.amountRaw || "0"),
        };
      }

      const summary = buildQuestionnaireSummary(
        questionnaire,
        assetOpt,
        venueOpt,
        amountAnswer
      );

      const answers: QuestionnaireAnswers = {
        questionnaireId: questionnaire.id,
        asset: st.assetId || "",
        venue: st.venueId,
        amount: amountAnswer,
        summary,
      };

      onSubmit(answers);
    }
  };

  // Keyboard navigation
  const currentStep = currentSection.steps[currentState.activeStepIdx];
  const currentStepOptions = useMemo(() => {
    if (!currentStep) return [];
    return getStepAvailableOptions(currentStep, currentState.assetId);
  }, [currentStep, currentState.assetId, getStepAvailableOptions]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (submitted) return;

    if (e.target instanceof HTMLInputElement && e.target.id === "something-else-input") {
      if (e.key === "Enter" && somethingElseText.trim()) {
        e.preventDefault();
        onSomethingElse(somethingElseText.trim());
      }
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
      return;
    }

    if (e.target instanceof HTMLInputElement && currentStep?.slot === "amount") {
      if (e.key === "Enter" && isAllComplete) {
        e.preventDefault();
        handleSubmit();
      }
      return;
    }

    // Number keys 1-9 to select options directly
    if (currentStepOptions.length > 0 && e.key >= "1" && e.key <= "9") {
      const idx = parseInt(e.key, 10) - 1;
      if (idx < currentStepOptions.length) {
        e.preventDefault();
        handleSelectOption(currentStepOptions[idx].id);
        return;
      }
    }

    if (currentStepOptions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedOptionIdx((prev) => (prev + 1) % currentStepOptions.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedOptionIdx((prev) => (prev - 1 < 0 ? currentStepOptions.length - 1 : prev - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const opt = currentStepOptions[focusedOptionIdx];
        if (opt) {
          handleSelectOption(opt.id);
        }
      }
    } else if (e.key === "Enter" && isAllComplete) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const isFirstVisibleStep = useMemo(() => {
    if (activeSectionIdx > 0) return false;
    for (let i = 0; i < currentState.activeStepIdx; i++) {
      if (!isStepAutoSkipped(currentSection, i, currentState.assetId)) return false;
    }
    return true;
  }, [activeSectionIdx, currentState.activeStepIdx, currentSection, currentState.assetId, isStepAutoSkipped]);

  const isLastVisibleStep = useMemo(() => {
    if (activeSectionIdx < sections.length - 1) return false;
    for (let i = currentState.activeStepIdx + 1; i < currentSection.steps.length; i++) {
      if (!isStepAutoSkipped(currentSection, i, currentState.assetId)) return false;
    }
    return true;
  }, [activeSectionIdx, sections.length, currentState.activeStepIdx, currentSection, currentState.assetId, isStepAutoSkipped]);

  const presetsToRender = currentStep?.presets || DEFAULT_PRESETS;
  const activePercentNum = currentParsedAmount?.kind === "fraction" ? currentParsedAmount.percent : null;

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label="Clarify request"
      onKeyDown={handleKeyDown}
      className={`rounded-xl border p-4 sm:p-5 transition-colors ${
        isDark
          ? "border-[#2A2A2A] bg-[#141414] text-white"
          : "border-vgray-100 bg-surface text-vgray-900"
      }`}
    >
      {/* Header: Title, Subtitle, Step count, and Cancel (X) */}
      <div className="flex items-start justify-between gap-3 border-b border-vgray-100 dark:border-[#2A2A2A] pb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-[15px] font-semibold leading-tight">
              {currentSection.title || questionnaire.title}
            </h2>
            <span
              className="text-[12px] font-medium text-vgray-400 tabular-nums"
              data-testid="step-counter"
            >
              {currentState.activeStepIdx + 1} of {currentSection.steps.length}
            </span>
          </div>
          {questionnaire.subtitle && (
            <p className="mt-0.5 text-[13px] text-vgray-500 dark:text-vgray-400 leading-normal">
              {questionnaire.subtitle}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Close questionnaire"
          data-testid="questionnaire-cancel-btn"
          className="rounded p-1 text-vgray-400 hover:text-vgray-700 dark:hover:text-vgray-200 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500"
        >
          <X size={17} aria-hidden="true" />
        </button>
      </div>

      {/* Addendum 2: Multi-Action Section Checklist at the Top */}
      {isMultiSection && (
        <div className="pt-3 pb-2 border-b border-vgray-100 dark:border-[#2A2A2A] space-y-1.5" data-testid="section-checklist">
          {sections.map((sec, sIdx) => {
            const isDone = isSectionComplete(sec, sectionStates[sec.id]);
            const isActive = sIdx === activeSectionIdx;
            const chosenSummary = getSectionChosenSummary(sec, sectionStates[sec.id]);

            return (
              <button
                key={sec.id}
                type="button"
                disabled={submitted || (!isDone && !isActive)}
                onClick={() => isDone && handleReopenSection(sIdx)}
                data-testid={`section-item-${sIdx}`}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-[12px] text-left transition-all ${
                  isActive
                    ? isDark
                      ? "border border-violet-500 bg-[#1E1E22] text-white font-semibold"
                      : "border border-violet-500 bg-violet-50/50 text-vgray-900 font-semibold"
                    : isDone
                    ? isDark
                      ? "border border-[#2A2A2A] bg-[#1A1A1A] text-vgray-300 hover:border-[#3A3A3A] cursor-pointer"
                      : "border border-vgray-200 bg-vgray-50 text-vgray-700 hover:border-vgray-300 cursor-pointer"
                    : isDark
                    ? "border border-dashed border-[#333333] text-vgray-500 opacity-60 cursor-not-allowed"
                    : "border border-dashed border-vgray-200 text-vgray-400 opacity-60 cursor-not-allowed"
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  {isDone ? (
                    <span className="w-4 h-4 rounded-full bg-emerald-500/20 text-emerald-500 flex items-center justify-center text-[10px] font-bold">
                      ✓
                    </span>
                  ) : isActive ? (
                    <span className="w-4 h-4 rounded-full border-2 border-violet-500 flex items-center justify-center">
                      <span className="w-1.5 h-1.5 rounded-full bg-violet-500" />
                    </span>
                  ) : (
                    <span className="w-4 h-4 rounded-full border border-dashed border-vgray-400 dark:border-vgray-600 flex items-center justify-center text-[10px] text-vgray-400">
                      ○
                    </span>
                  )}
                  <span className="truncate">{sec.title}</span>
                  {isDone && chosenSummary && (
                    <span className="font-semibold text-violet-500 truncate">&rarr; {chosenSummary}</span>
                  )}
                </div>
                {isDone && !isActive && (
                  <span className="text-[11px] font-medium text-vgray-400 hover:text-violet-500">Edit</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Answered / Collapsed Steps as compact done rows ("Which USDC → AQUSDC ✓") */}
      <div className="space-y-1.5 py-3">
        {currentSection.steps.map((step, idx) => {
          if (idx >= currentState.activeStepIdx) return null;
          const answerText = getStepAnswerSummary(currentSection, step, currentState);
          if (!answerText) return null;

          const slotLabel =
            step.slot === "asset"
              ? "Asset"
              : step.slot === "venue"
              ? "Venue"
              : "Amount";

          return (
            <button
              key={step.slot + idx}
              type="button"
              disabled={submitted}
              onClick={() => handleReopenStep(idx)}
              className={`w-full flex items-center justify-between rounded-lg border px-3 py-1.5 text-left text-[12px] transition-colors ${
                isDark
                  ? "border-[#2A2A2A] bg-[#1A1A1A] text-vgray-200 hover:border-[#3A3A3A]"
                  : "border-vgray-100 bg-vgray-50/60 text-vgray-700 hover:border-vgray-200"
              }`}
              data-testid={`answered-step-${idx}`}
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <Check size={13} className="shrink-0 text-emerald-500" aria-hidden="true" />
                <span className="font-medium">
                  {step.prompt ? step.prompt : `Q${idx + 1} ${slotLabel}`} &rarr;
                </span>
                <span className="font-semibold text-violet-500 truncate">{answerText}</span>
                <span className="text-emerald-500 font-bold ml-1">✓</span>
              </div>
              <span className="text-[11px] font-medium text-vgray-400 hover:text-violet-500">
                Change
              </span>
            </button>
          );
        })}
      </div>

      {/* Active Step Content */}
      {currentStep && (
        <div className="py-2">
          <h3 className="text-[13px] font-semibold mb-2.5 text-vgray-800 dark:text-vgray-100">
            {currentStep.prompt}
          </h3>

          {/* Options for Asset or Venue (Radio rows with label on left, rate/balance on right, LP note second line) */}
          {currentStep.slot !== "amount" && (
            <div className="space-y-2" role="radiogroup" aria-label={currentStep.prompt}>
              {currentStepOptions.map((opt, oIdx) => {
                const isSelected =
                  currentStep.slot === "asset"
                    ? currentState.assetId === opt.id
                    : currentState.venueId === opt.id;
                const isFocused = focusedOptionIdx === oIdx;

                return (
                  <button
                    key={opt.id}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    disabled={submitted}
                    onClick={() => handleSelectOption(opt.id)}
                    className={`w-full flex items-center justify-between rounded-lg border p-3 text-left transition-all ${
                      isSelected
                        ? isDark
                          ? "border-violet-500 bg-violet-950/20 text-white"
                          : "border-violet-500 bg-violet-50/40 text-vgray-900"
                        : isFocused
                        ? isDark
                          ? "border-violet-400/50 bg-[#1E1E1E] text-white"
                          : "border-violet-300 bg-vgray-50 text-vgray-800"
                        : isDark
                        ? "border-[#2A2A2A] bg-[#1A1A1A] hover:border-[#3A3A3A] hover:bg-[#202020] text-vgray-200"
                        : "border-vgray-100 bg-white hover:border-vgray-200 hover:bg-vgray-50 text-vgray-800"
                    }`}
                    data-testid={`option-${opt.id}`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {/* Radio dot indicator */}
                      <span
                        className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 transition-all ${
                          isSelected
                            ? "border-violet-500"
                            : isDark
                            ? "border-vgray-600"
                            : "border-vgray-300"
                        }`}
                      >
                        {isSelected && (
                          <span className="w-1.5 h-1.5 rounded-full bg-violet-500" />
                        )}
                      </span>
                      <div className="min-w-0">
                        <div className="text-[13px] font-semibold">
                          {opt.label}
                        </div>
                        {opt.detail && (
                          <div className="text-[11px] text-vgray-400 dark:text-vgray-400 mt-0.5 truncate">
                            {opt.detail}
                          </div>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {/* Amount Step: SwapInput.tsx styling (#1A1A1A panel, #2A2A2A border, 25/50/75/Max buttons, right-aligned amount, balance underneath) */}
          {currentStep.slot === "amount" && (
            <div className="space-y-3">
              {/* Linked option row if available (Addendum 2) */}
              {currentStep.options
                .filter(
                  (opt) =>
                    (Boolean(opt.sourceSectionId) || opt.id.startsWith("previous:")) &&
                    (!opt.forAsset || !currentState.assetId || opt.forAsset.toLowerCase() === currentState.assetId.toLowerCase())
                )
                .map((linkedOpt) => {
                  const linked = resolveLinkedOptionAmount(linkedOpt, activeSectionIdx);
                  const isLinkedActive = currentState.linkedOptionId === linkedOpt.id;
                  return (
                    <button
                      key={linkedOpt.id}
                      type="button"
                      disabled={submitted}
                      onClick={() => handleSelectLinkedOption(linkedOpt)}
                      className={`w-full flex items-center justify-between rounded-xl border p-3 text-left transition-all ${
                        isLinkedActive
                          ? isDark
                            ? "border-violet-500 bg-violet-950/20 text-white"
                            : "border-violet-500 bg-violet-50/40 text-vgray-900"
                          : isDark
                          ? "border-[#2A2A2A] bg-[#1A1A1A] hover:border-[#3A3A3A] text-vgray-200"
                          : "border-vgray-200 bg-white hover:border-vgray-300 text-vgray-800"
                      }`}
                      data-testid={`option-${linkedOpt.id}`}
                    >
                      <div className="flex items-center gap-2.5">
                        <span
                          className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                            isLinkedActive ? "border-violet-500" : "border-vgray-400"
                          }`}
                        >
                          {isLinkedActive && <span className="w-1.5 h-1.5 rounded-full bg-violet-500" />}
                        </span>
                        <div>
                          <div className="text-[13px] font-semibold">{linkedOpt.label}</div>
                          <div className="text-[11px] text-vgray-400">
                            {linked ? `${linked.amount} ${linked.asset}` : linkedOpt.detail}
                          </div>
                        </div>
                      </div>
                    </button>
                  );
                })}

              {/* SwapInput card */}
              <div
                className={`rounded-2xl p-3 sm:p-4 flex flex-col gap-1.5 sm:gap-2 transition-colors ${
                  isDark
                    ? "bg-[#1A1A1A] border border-[#2A2A2A] hover:border-[#333333]"
                    : "bg-[#F7F7F7] border border-[#EEEEEE] hover:border-[#E2E2E2]"
                }`}
              >
                {/* Label row + presets */}
                <div className="flex items-center justify-between">
                  <span
                    className={`text-[12px] font-medium leading-[18px] ${
                      isDark ? "text-[#A7A7A7]" : "text-[#777777]"
                    }`}
                  >
                    Amount
                  </span>
                  <div className="flex items-center gap-1 sm:gap-1.5">
                    {presetsToRender.map((p) => {
                      const isActive = activePercentNum === p.percent;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          disabled={submitted}
                          onClick={() => handlePresetClick(p.percent)}
                          className={`px-1.5 sm:px-2.5 py-0.5 sm:py-1 rounded-md sm:rounded-lg text-[9px] sm:text-[10px] font-semibold leading-[14px] cursor-pointer transition-all ${
                            isActive
                              ? `${PRESET_COLORS[p.percent] || "bg-[#703AE6] text-white"}`
                              : isDark
                              ? "bg-[#2A2A2A] text-[#A7A7A7] hover:text-white border border-[#333333]"
                              : "bg-[#F0F0F0] text-[#888888] hover:text-[#555555] border border-[#E2E2E2]"
                          }`}
                          data-testid={`preset-${p.id}`}
                        >
                          {p.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Asset Label + Right-aligned Amount row */}
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-1.5">
                    <span className={`text-[14px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>
                      {currentMaxInfo?.asset ||
                        currentSection.steps
                          .find((s) => s.slot === "asset")
                          ?.options.find((o) => o.id === currentState.assetId)?.label ||
                        ""}
                    </span>
                  </div>

                  <div className="flex-1 min-w-0">
                    <input
                      type="text"
                      inputMode="decimal"
                      placeholder="0.0 or 50%"
                      value={currentState.amountRaw}
                      disabled={submitted}
                      onChange={(e) => handleAmountChange(e.target.value)}
                      className={`w-full text-right text-[22px] sm:text-[28px] md:text-[32px] font-semibold leading-none bg-transparent outline-none placeholder:opacity-30 ${
                        isDark
                          ? "text-white placeholder:text-[#555555]"
                          : "text-[#111111] placeholder:text-[#CCCCCC]"
                      }`}
                    />
                  </div>
                </div>

                {/* Balance underneath (Server detail & max.where, never relabeled) */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {currentMaxInfo && (
                      <span
                        className={`text-[12px] font-medium leading-[18px] ${
                          isDark ? "text-[#777777]" : "text-[#A7A7A7]"
                        }`}
                      >
                        You have{" "}
                        <span className="font-semibold tabular-nums text-vgray-900 dark:text-white">
                          {currentMaxInfo.amount} {currentMaxInfo.asset}
                        </span>{" "}
                        available{currentMaxInfo.where ? ` in ${currentMaxInfo.where}` : ""}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Note on max (e.g. "I'll deposit the other 14 from your wallet first") */}
              {currentMaxInfo?.note && (
                <div
                  className={`text-[12px] px-1 ${
                    isDark ? "text-vgray-400" : "text-vgray-500"
                  }`}
                  data-testid="amount-note"
                >
                  {currentMaxInfo.note}
                </div>
              )}

              {/* Note on pair */}
              {currentLpPairInfo?.note && (
                <div
                  className={`text-[12px] px-1 ${
                    isDark ? "text-vgray-400" : "text-vgray-500"
                  }`}
                  data-testid="pair-note"
                >
                  {currentLpPairInfo.note}
                </div>
              )}

              {/* Converted amount preview when a percentage is chosen */}
              {currentParsedAmount?.kind === "fraction" && currentParsedAmount.convertedLiteral && (
                <p className="text-[11px] text-vgray-500 dark:text-vgray-400 tabular-nums px-1" data-testid="percent-converted">
                  &asymp; {currentParsedAmount.convertedLiteral} {currentMaxInfo?.asset || ""}
                </p>
              )}

              {/* Validation error message */}
              {currentParsedAmount?.error && (
                <p
                  role="alert"
                  className="text-[12px] text-red-500 font-medium px-1"
                  data-testid="amount-error"
                >
                  {currentParsedAmount.error}
                </p>
              )}

              {/* LP Pool pair match note */}
              {currentLpPairInfo && (
                <div
                  className={`rounded-lg border p-2.5 text-[12px] ${
                    isDark
                      ? "border-[#2A2A2A] bg-[#1A1A1A] text-vgray-300"
                      : "border-vgray-100 bg-vgray-50/70 text-vgray-600"
                  }`}
                  data-testid="lp-pair-ratio"
                >
                  {currentLpMatchedAmount ? (
                    <span>
                      {currentLpPairInfo.asset} is matched at the pool ratio (~
                      <span className="font-semibold text-vgray-900 dark:text-white tabular-nums">
                        {currentLpMatchedAmount} {currentLpPairInfo.asset}
                      </span>
                      )
                    </span>
                  ) : currentLpPairInfo.perUnit ? (
                    <span>
                      The other token ({currentLpPairInfo.asset}) is matched at the pool ratio (
                      {currentLpPairInfo.perUnit} {currentLpPairInfo.asset} per unit)
                    </span>
                  ) : (
                    <span>
                      The other token ({currentLpPairInfo.asset}) is matched at the pool ratio
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Navigation Buttons: Back, Next, Send */}
      <div className="flex items-center justify-between gap-2 border-t border-vgray-100 dark:border-[#2A2A2A] pt-3.5 mt-3">
        <div>
          {!isFirstVisibleStep && (
            <button
              type="button"
              onClick={handleBack}
              disabled={busy || submitted}
              className={`${BTN_QUIET} flex items-center gap-1.5`}
              data-testid="btn-back"
            >
              <ArrowLeft size={14} aria-hidden="true" />
              Back
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          {!isLastVisibleStep && (
            <button
              type="button"
              onClick={handleNext}
              disabled={busy || submitted}
              className={`${BTN_QUIET} flex items-center gap-1.5`}
              data-testid="btn-next"
            >
              Next
              <ArrowRight size={14} aria-hidden="true" />
            </button>
          )}

          <button
            type="button"
            onClick={handleSubmit}
            disabled={!isAllComplete || busy || submitted}
            className={BTN_PRIMARY}
            data-testid="btn-send"
          >
            {busy ? "Sending..." : "Send"}
          </button>
        </div>
      </div>

      {/* "Something else" input escape hatch */}
      <div className="flex items-center gap-2 border-t border-vgray-100 dark:border-[#2A2A2A] pt-3 mt-3">
        <input
          id="something-else-input"
          type="text"
          placeholder="Something else..."
          value={somethingElseText}
          onChange={(e) => setSomethingElseText(e.target.value)}
          disabled={busy || submitted}
          className="flex-1 rounded-lg border border-vgray-200 dark:border-[#2A2A2A] bg-transparent px-3 py-1.5 text-[12px] placeholder:text-vgray-400 outline-none focus:border-violet-500 transition-colors"
          data-testid="input-something-else"
        />
        <button
          type="button"
          onClick={() => {
            if (somethingElseText.trim()) {
              onSomethingElse(somethingElseText.trim());
            }
          }}
          disabled={!somethingElseText.trim() || busy || submitted}
          className="rounded-lg border border-vgray-200 dark:border-[#2A2A2A] px-2.5 py-1.5 text-[12px] font-semibold text-vgray-700 dark:text-vgray-300 hover:border-violet-400 hover:text-violet-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          data-testid="btn-something-else"
        >
          <CornerDownLeft size={13} aria-hidden="true" />
        </button>
      </div>

      {/* Keyboard hint */}
      <div className="flex items-center justify-between text-[11px] text-vgray-400 dark:text-vgray-500 mt-2 px-0.5">
        <span>Press 1-9 to select &middot; &crarr; to submit &middot; Esc to close</span>
      </div>
    </div>
  );
}
