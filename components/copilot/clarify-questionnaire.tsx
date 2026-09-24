"use client";

import React, { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { Check, X, ArrowLeft, ArrowRight, CornerDownLeft } from "lucide-react";
import type {
  Questionnaire,
  QuestionnaireOption,
  QuestionnaireStep,
  QuestionnaireAnswers,
} from "@/lib/copilot/investigation/view";
import { InputWithUnit } from "@/components/ui/InputWithUnit";

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
  "rounded-lg border border-vgray-200 px-3.5 py-2 text-[13px] font-semibold text-vgray-800 transition-colors hover:border-violet-400 hover:text-violet-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500 disabled:cursor-not-allowed disabled:text-vgray-300";

const DEFAULT_PRESETS = [
  { id: "10", label: "10%", percent: "10" },
  { id: "25", label: "25%", percent: "25" },
  { id: "50", label: "50%", percent: "50" },
  { id: "100", label: "100% / max", percent: "100" },
];

export function buildQuestionnaireSummary(
  questionnaire: Questionnaire,
  assetOption?: QuestionnaireOption,
  venueOption?: QuestionnaireOption | null,
  amount?: { kind: "fraction"; percent: string } | { kind: "literal"; amount: string }
): string {
  const verb = questionnaire.title ? questionnaire.title.split(" ")[0] : "Supply";
  const assetLabel = assetOption?.label || "asset";

  let amountStr = "";
  if (amount) {
    if (amount.kind === "fraction") {
      amountStr = `${amount.percent}% of my ${assetLabel}`;
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

export function ClarifyQuestionnaire({
  questionnaire,
  onSubmit,
  onCancel,
  onSomethingElse,
  busy = false,
}: ClarifyQuestionnaireProps) {
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [selectedVenueId, setSelectedVenueId] = useState<string | null>(null);
  const [amountRaw, setAmountRaw] = useState<string>("");
  const [activeStepIndex, setActiveStepIndex] = useState<number>(0);
  const [somethingElseText, setSomethingElseText] = useState<string>("");
  const [focusedOptionIdx, setFocusedOptionIdx] = useState<number>(0);

  const containerRef = useRef<HTMLDivElement>(null);

  // Helper to get options for a step given current selections
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

  // Find asset step and auto-select if single option
  const assetStep = questionnaire.steps.find((s) => s.slot === "asset");
  const venueStep = questionnaire.steps.find((s) => s.slot === "venue");
  const amountStep = questionnaire.steps.find((s) => s.slot === "amount");

  // Initial auto-selection of single-option asset
  useEffect(() => {
    if (assetStep && assetStep.options.length === 1 && !selectedAssetId) {
      setSelectedAssetId(assetStep.options[0].id);
    }
  }, [assetStep, selectedAssetId]);

  // Venue auto-selection or reset when asset changes
  const availableVenueOptions = useMemo(() => {
    if (!venueStep) return [];
    return getStepAvailableOptions(venueStep, selectedAssetId);
  }, [venueStep, selectedAssetId, getStepAvailableOptions]);

  useEffect(() => {
    if (!venueStep) return;
    if (availableVenueOptions.length === 1) {
      setSelectedVenueId(availableVenueOptions[0].id);
    } else if (
      selectedVenueId &&
      !availableVenueOptions.some((opt) => opt.id === selectedVenueId)
    ) {
      setSelectedVenueId(null);
    }
  }, [venueStep, availableVenueOptions, selectedVenueId]);

  // Determine which steps are skipped (have only 1 available option)
  const isStepAutoSkipped = useCallback(
    (stepIndex: number): boolean => {
      const step = questionnaire.steps[stepIndex];
      if (!step) return false;
      if (step.slot === "amount") return false;
      const opts = getStepAvailableOptions(step, selectedAssetId);
      return opts.length <= 1;
    },
    [questionnaire.steps, selectedAssetId, getStepAvailableOptions]
  );

  // Advance initial activeStepIndex if first step is skipped
  useEffect(() => {
    if (activeStepIndex === 0 && isStepAutoSkipped(0)) {
      // Find the first non-skipped step
      const nextIdx = questionnaire.steps.findIndex((_, idx) => !isStepAutoSkipped(idx));
      if (nextIdx !== -1) {
        setActiveStepIndex(nextIdx);
      }
    }
  }, [activeStepIndex, isStepAutoSkipped, questionnaire.steps]);

  // Amount parsing and validation
  const maxInfo = useMemo(() => {
    if (!amountStep?.max) return null;
    if (selectedVenueId && amountStep.max[selectedVenueId]) {
      return amountStep.max[selectedVenueId];
    }
    if (selectedAssetId && amountStep.max[selectedAssetId]) {
      return amountStep.max[selectedAssetId];
    }
    // Also try matching case-insensitively
    const entry = Object.entries(amountStep.max).find(([k]) =>
      selectedVenueId
        ? k.toLowerCase() === selectedVenueId.toLowerCase()
        : selectedAssetId
        ? k.toLowerCase() === selectedAssetId.toLowerCase()
        : false
    );
    return entry ? entry[1] : null;
  }, [amountStep, selectedVenueId, selectedAssetId]);

  const maxAmountNum = maxInfo ? parseFloat(maxInfo.amount) : null;

type ParsedAmountResult =
  | { kind: "fraction"; percent: string; convertedLiteral: string | null; error: null }
  | { kind: "literal"; amount: string; convertedLiteral?: null; error: null }
  | { kind: "error"; error: string; convertedLiteral?: null };

  const parsedAmount = useMemo<ParsedAmountResult | null>(() => {
    const trimmed = amountRaw.trim();
    if (!trimmed) return null;

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
  }, [amountRaw, maxAmountNum, maxInfo]);


  // LP Pair info
  const lpPairInfo = useMemo(() => {
    if (!amountStep?.pair || !selectedVenueId) return null;
    return amountStep.pair[selectedVenueId] ?? null;
  }, [amountStep, selectedVenueId]);

  const lpMatchedAmount = useMemo(() => {
    if (!lpPairInfo || !lpPairInfo.perUnit) return null;
    const ratio = parseFloat(lpPairInfo.perUnit);
    if (!Number.isFinite(ratio)) return null;

    let baseAmount: number | null = null;
    if (parsedAmount && !parsedAmount.error) {
      if (parsedAmount.kind === "literal") {
        baseAmount = parseFloat(parsedAmount.amount);
      } else if (parsedAmount.convertedLiteral) {
        baseAmount = parseFloat(parsedAmount.convertedLiteral);
      }
    }
    if (baseAmount !== null && baseAmount > 0) {
      const matched = (baseAmount * ratio).toFixed(4);
      return matched.replace(/\.?0+$/, "");
    }
    return null;
  }, [lpPairInfo, parsedAmount]);

  // Overall completeness check
  const isComplete = useMemo(() => {
    if (busy) return false;
    if (assetStep && !selectedAssetId) return false;
    if (venueStep && availableVenueOptions.length > 0 && !selectedVenueId) return false;
    if (amountStep) {
      if (!parsedAmount || parsedAmount.error) return false;
    }
    return true;
  }, [
    busy,
    assetStep,
    selectedAssetId,
    venueStep,
    availableVenueOptions,
    selectedVenueId,
    amountStep,
    parsedAmount,
  ]);

  // Current active step definition
  const currentStep = questionnaire.steps[activeStepIndex];
  const currentStepOptions = useMemo(() => {
    if (!currentStep) return [];
    return getStepAvailableOptions(currentStep, selectedAssetId);
  }, [currentStep, selectedAssetId, getStepAvailableOptions]);

  // Find step answer for collapsed view
  const getStepAnswerSummary = (step: QuestionnaireStep): string | null => {
    if (step.slot === "asset") {
      const opt = step.options.find((o) => o.id === selectedAssetId);
      return opt ? opt.label : null;
    }
    if (step.slot === "venue") {
      const opt = step.options.find((o) => o.id === selectedVenueId);
      return opt ? opt.label : null;
    }
    if (step.slot === "amount") {
      if (parsedAmount) {
        if (parsedAmount.kind === "fraction") {
          return `${parsedAmount.percent}%`;
        }
        if (parsedAmount.kind === "literal") {
          return `${parsedAmount.amount} ${maxInfo?.asset || ""}`.trim();
        }
      }
      return null;
    }
    return null;
  };

  // Navigation: Go forward to next visible step
  const handleNext = () => {
    let nextIdx = activeStepIndex + 1;
    while (nextIdx < questionnaire.steps.length && isStepAutoSkipped(nextIdx)) {
      nextIdx++;
    }
    if (nextIdx < questionnaire.steps.length) {
      setActiveStepIndex(nextIdx);
      setFocusedOptionIdx(0);
    }
  };

  // Navigation: Go back to previous visible step
  const handleBack = () => {
    let prevIdx = activeStepIndex - 1;
    while (prevIdx >= 0 && isStepAutoSkipped(prevIdx)) {
      prevIdx--;
    }
    if (prevIdx >= 0) {
      setActiveStepIndex(prevIdx);
      setFocusedOptionIdx(0);
    }
  };

  // Select an option on the current step
  const handleSelectOption = (optId: string) => {
    if (!currentStep) return;
    if (currentStep.slot === "asset") {
      setSelectedAssetId(optId);
      // Auto-advance if not on final step
      if (activeStepIndex < questionnaire.steps.length - 1) {
        let nextIdx = activeStepIndex + 1;
        // Venue might have 1 option for this asset -> skip
        const nextStep = questionnaire.steps[nextIdx];
        if (
          nextStep &&
          nextStep.slot === "venue" &&
          getStepAvailableOptions(nextStep, optId).length <= 1
        ) {
          nextIdx++;
        }
        if (nextIdx < questionnaire.steps.length) {
          setActiveStepIndex(nextIdx);
          setFocusedOptionIdx(0);
        }
      }
    } else if (currentStep.slot === "venue") {
      setSelectedVenueId(optId);
      if (activeStepIndex < questionnaire.steps.length - 1) {
        setActiveStepIndex(activeStepIndex + 1);
        setFocusedOptionIdx(0);
      }
    }
  };

  // Preset click on amount step
  const handlePresetClick = (percentStr: string) => {
    setAmountRaw(`${percentStr}%`);
  };

  // Max click
  const handleMaxClick = () => {
    if (maxInfo?.amount) {
      setAmountRaw("100%");
    }
  };

  // Submit questionnaire
  const handleSubmit = () => {
    if (!isComplete || !selectedAssetId || !parsedAmount || parsedAmount.error) return;

    const chosenAssetOption = assetStep?.options.find((o) => o.id === selectedAssetId);
    const chosenVenueOption = venueStep?.options.find((o) => o.id === selectedVenueId) ?? null;

    const amountAnswer: QuestionnaireAnswers["amount"] =
      parsedAmount.kind === "fraction"
        ? { kind: "fraction", percent: parsedAmount.percent }
        : parsedAmount.kind === "literal"
        ? { kind: "literal", amount: parsedAmount.amount }
        : { kind: "literal", amount: "0" };

    const summary = buildQuestionnaireSummary(
      questionnaire,
      chosenAssetOption,
      chosenVenueOption,
      amountAnswer
    );

    const answers: QuestionnaireAnswers = {
      questionnaireId: questionnaire.id,
      asset: selectedAssetId,
      venue: selectedVenueId,
      amount: amountAnswer,
      summary,
    };

    onSubmit(answers);
  };

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement && e.target.id === "something-else-input") {
      if (e.key === "Enter" && somethingElseText.trim()) {
        e.preventDefault();
        onSomethingElse(somethingElseText.trim());
      }
      return;
    }

    if (e.target instanceof HTMLInputElement && currentStep?.slot === "amount") {
      if (e.key === "Enter" && isComplete) {
        e.preventDefault();
        handleSubmit();
      }
      return;
    }

    if (currentStepOptions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedOptionIdx((prev) => (prev + 1) % currentStepOptions.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedOptionIdx((prev) =>
          prev - 1 < 0 ? currentStepOptions.length - 1 : prev - 1
        );
      } else if (e.key === "Enter") {
        e.preventDefault();
        const opt = currentStepOptions[focusedOptionIdx];
        if (opt) {
          handleSelectOption(opt.id);
        }
      }
    } else if (e.key === "Enter" && isComplete) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const isFirstVisibleStep = useMemo(() => {
    for (let i = 0; i < activeStepIndex; i++) {
      if (!isStepAutoSkipped(i)) return false;
    }
    return true;
  }, [activeStepIndex, isStepAutoSkipped]);

  const isLastVisibleStep = useMemo(() => {
    for (let i = activeStepIndex + 1; i < questionnaire.steps.length; i++) {
      if (!isStepAutoSkipped(i)) return false;
    }
    return true;
  }, [activeStepIndex, isStepAutoSkipped, questionnaire.steps.length]);

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label="Clarify request"
      onKeyDown={handleKeyDown}
      className="rounded-xl border border-vgray-100 bg-surface p-4 sm:p-5 text-vgray-900 shadow-none transition-colors"
    >
      {/* Header: Title, Subtitle, Step count, and Cancel (X) */}
      <div className="flex items-start justify-between gap-3 border-b border-vgray-100 pb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-[15px] font-semibold text-vgray-900 leading-tight">
              {questionnaire.title}
            </h2>
            <span
              className="text-[12px] font-medium text-vgray-400 tabular-nums"
              data-testid="step-counter"
            >
              {activeStepIndex + 1} of {questionnaire.steps.length}
            </span>
          </div>
          {questionnaire.subtitle && (
            <p className="mt-0.5 text-[13px] text-vgray-500 leading-normal">
              {questionnaire.subtitle}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Close questionnaire"
          data-testid="questionnaire-cancel-btn"
          className="rounded p-1 text-vgray-400 hover:text-vgray-700 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500"
        >
          <X size={17} aria-hidden="true" />
        </button>
      </div>

      {/* Answered / Collapsed Steps */}
      <div className="space-y-1.5 py-3">
        {questionnaire.steps.map((step, idx) => {
          if (idx >= activeStepIndex) return null;
          const answerText = getStepAnswerSummary(step);
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
              onClick={() => setActiveStepIndex(idx)}
              className="w-full flex items-center justify-between rounded-lg border border-vgray-100 bg-vgray-50/60 px-3 py-1.5 text-left text-[12px] transition-colors hover:border-vgray-200"
              data-testid={`answered-step-${idx}`}
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <Check size={13} className="shrink-0 text-emerald-500" aria-hidden="true" />
                <span className="font-medium text-vgray-700">
                  Q{idx + 1} {slotLabel} &rarr;
                </span>
                <span className="font-semibold text-violet-600 truncate">{answerText}</span>
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
          <h3 className="text-[13px] font-semibold text-vgray-800 mb-2.5">
            {currentStep.prompt}
          </h3>

          {/* Options for Asset or Venue */}
          {currentStep.slot !== "amount" && (
            <div className="space-y-2" role="radiogroup" aria-label={currentStep.prompt}>
              {currentStepOptions.map((opt, oIdx) => {
                const isSelected =
                  currentStep.slot === "asset"
                    ? selectedAssetId === opt.id
                    : selectedVenueId === opt.id;
                const isFocused = focusedOptionIdx === oIdx;

                return (
                  <button
                    key={opt.id}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    onClick={() => handleSelectOption(opt.id)}
                    className={`w-full flex items-center justify-between rounded-lg border p-3 text-left transition-all ${
                      isSelected
                        ? "border-violet-500 bg-violet-50/40 text-vgray-900"
                        : isFocused
                        ? "border-violet-300 bg-vgray-50 text-vgray-800"
                        : "border-vgray-100 bg-white hover:border-vgray-200 hover:bg-vgray-50 text-vgray-800"
                    }`}
                    data-testid={`option-${opt.id}`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {/* Radio dot indicator */}
                      <span
                        className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 transition-all ${
                          isSelected ? "border-violet-500" : "border-vgray-300"
                        }`}
                      >
                        {isSelected && (
                          <span className="w-1.5 h-1.5 rounded-full bg-violet-500" />
                        )}
                      </span>
                      <div className="min-w-0">
                        <div className="text-[13px] font-semibold text-vgray-900">
                          {opt.label}
                        </div>
                        {opt.detail && (
                          <div className="text-[11px] text-vgray-500 mt-0.5 truncate">
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

          {/* Amount Step */}
          {currentStep.slot === "amount" && (
            <div className="space-y-3">
              {/* Max available banner */}
              {maxInfo && (
                <div className="text-[12px] font-medium text-vgray-600">
                  You have{" "}
                  <span className="font-semibold text-vgray-900 tabular-nums">
                    {maxInfo.amount} {maxInfo.asset}
                  </span>{" "}
                  available{maxInfo.where ? ` in ${maxInfo.where}` : ""}
                </div>
              )}

              {/* Preset percentage buttons */}
              <div className="flex flex-wrap items-center gap-1.5">
                {(currentStep.presets || DEFAULT_PRESETS).map((p) => {
                  const isSelected = parsedAmount?.kind === "fraction" && parsedAmount.percent === p.percent;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => handlePresetClick(p.percent)}
                      className={`px-2.5 py-1 rounded-md text-[11px] font-semibold border transition-all ${
                        isSelected
                          ? "bg-violet-500 text-white border-transparent"
                          : "bg-vgray-50 text-vgray-700 border-vgray-200 hover:text-vgray-900 hover:bg-vgray-100"
                      }`}
                      data-testid={`preset-${p.id}`}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>

              {/* Input with unit and Max button */}
              <div className="space-y-1">
                <InputWithUnit
                  placeholder="0.0 or 50%"
                  type="text"
                  name="amount"
                  value={amountRaw}
                  onChange={(e) => setAmountRaw(e.target.value)}
                  showMax={!!maxInfo}
                  onMax={handleMaxClick}
                  selectedSuffix={maxInfo?.asset || assetStep?.options.find((o) => o.id === selectedAssetId)?.label}
                />

                {/* Converted amount preview when a percentage is chosen */}
                {parsedAmount?.kind === "fraction" && parsedAmount.convertedLiteral && (
                  <p className="text-[11px] text-vgray-500 tabular-nums" data-testid="percent-converted">
                    &asymp; {parsedAmount.convertedLiteral} {maxInfo?.asset || ""}
                  </p>
                )}

                {/* Validation error message */}
                {parsedAmount?.error && (
                  <p
                    role="alert"
                    className="text-[12px] text-imperial-500 font-medium"
                    data-testid="amount-error"
                  >
                    {parsedAmount.error}
                  </p>
                )}
              </div>

              {/* LP Pool pair match note */}
              {lpPairInfo && (
                <div
                  className="rounded-lg border border-vgray-100 bg-vgray-50/70 p-2.5 text-[12px] text-vgray-600"
                  data-testid="lp-pair-ratio"
                >
                  {lpMatchedAmount ? (
                    <span>
                      {lpPairInfo.asset} is matched at the pool ratio (~
                      <span className="font-semibold text-vgray-900 tabular-nums">
                        {lpMatchedAmount} {lpPairInfo.asset}
                      </span>
                      )
                    </span>
                  ) : lpPairInfo.perUnit ? (
                    <span>
                      The other token ({lpPairInfo.asset}) is matched at the pool ratio (
                      {lpPairInfo.perUnit} {lpPairInfo.asset} per unit)
                    </span>
                  ) : (
                    <span>
                      The other token ({lpPairInfo.asset}) is matched at the pool ratio
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Navigation Buttons: Back, Next, Send */}
      <div className="flex items-center justify-between gap-2 border-t border-vgray-100 pt-3.5 mt-3">
        <div>
          {!isFirstVisibleStep && (
            <button
              type="button"
              onClick={handleBack}
              disabled={busy}
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
              disabled={busy}
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
            disabled={!isComplete || busy}
            className={BTN_PRIMARY}
            data-testid="btn-send"
          >
            {busy ? "Sending..." : "Send"}
          </button>
        </div>
      </div>

      {/* "Something else" input escape hatch */}
      <div className="flex items-center gap-2 border-t border-vgray-100 pt-3 mt-3">
        <input
          id="something-else-input"
          type="text"
          placeholder="Something else..."
          value={somethingElseText}
          onChange={(e) => setSomethingElseText(e.target.value)}
          disabled={busy}
          className="flex-1 rounded-lg border border-vgray-200 bg-transparent px-3 py-1.5 text-[12px] placeholder:text-vgray-400 outline-none focus:border-violet-500 transition-colors"
          data-testid="input-something-else"
        />
        <button
          type="button"
          onClick={() => {
            if (somethingElseText.trim()) {
              onSomethingElse(somethingElseText.trim());
            }
          }}
          disabled={!somethingElseText.trim() || busy}
          className="rounded-lg border border-vgray-200 px-2.5 py-1.5 text-[12px] font-semibold text-vgray-700 hover:border-violet-400 hover:text-violet-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          data-testid="btn-something-else"
        >
          <CornerDownLeft size={13} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
