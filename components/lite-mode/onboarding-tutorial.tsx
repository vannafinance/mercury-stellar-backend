"use client";

import { useState, useEffect, useCallback } from "react";
import Image from "next/image";
import { motion, AnimatePresence } from "framer-motion";
import { useTheme } from "@/contexts/theme-context";

const STORAGE_KEY = "vanna-lite-onboarding-seen";

/* Drop a screenshot at this path and it auto-loads for the Pool step.
   Falls back to the SVG illustration if the file isn't present. */
const POOL_IMAGE_SRC = "/onboarding/pool-picker.png";

type StepKey = "welcome" | "pool" | "leverage" | "deploy";

interface Step {
  key: StepKey;
  eyebrow: string;
  title: string;
  description: string;
}

const STEPS: Step[] = [
  {
    key: "welcome",
    eyebrow: "Getting Started",
    title: "Welcome to Vanna Lite",
    description:
      "A simpler way to earn leveraged yield. Deposit collateral, borrow undercollateralized credit, and deploy to top lending pools  all in one click.",
  },
  {
    key: "pool",
    eyebrow: "Step 01 · Choose",
    title: "Pick a curated pool",
    description:
      "Compare live Supply APR, Vanna borrow rate, and pool liquidity at a glance. Every pool is vetted and audited.",
  },
  {
    key: "leverage",
    eyebrow: "Step 02 · Configure",
    title: "Set your leverage",
    description:
      "Drag the slider from 1x to 7x. Vanna extends undercollateralized credit against your deposit  no liquidation risk up to your pool's threshold.",
  },
  {
    key: "deploy",
    eyebrow: "Step 03 · Deploy",
    title: "One-click execution",
    description:
      "Review your net APR, health factor, and borrowed amount. Confirm once and Vanna handles the deposit, borrow, and deploy on-chain.",
  },
];

/* ─────────────── Step-specific illustrations ─────────────── */

const WelcomeIllustration = ({ isDark }: { isDark: boolean }) => {
  const logoSrc = isDark ? "/logos/vanna-white.png" : "/logos/vanna.png";
  return (
    <div className="relative w-full h-full flex items-center justify-center">
      {/* Ambient gradient glow */}
      <div
        className="absolute inset-0 flex items-center justify-center pointer-events-none"
        aria-hidden
      >
        <div
          className="w-[220px] h-[140px] rounded-full blur-2xl opacity-[0.22]"
          style={{
            background:
              "radial-gradient(ellipse at center, #703AE6 0%, #FC5457 50%, transparent 70%)",
          }}
        />
      </div>
      {/* Concentric rings */}
      <svg
        viewBox="0 0 240 140"
        fill="none"
        className="absolute inset-0 w-full h-full"
        aria-hidden
      >
        <ellipse
          cx="120"
          cy="70"
          rx="90"
          ry="44"
          stroke={isDark ? "#1F1F1F" : "#EDEDED"}
          strokeWidth="1"
          strokeDasharray="2 4"
          fill="none"
        />
        <ellipse
          cx="120"
          cy="70"
          rx="62"
          ry="30"
          stroke={isDark ? "#2A2A2A" : "#E0E0E0"}
          strokeWidth="1"
          strokeDasharray="2 3"
          fill="none"
        />
        {/* Orbit dots */}
        <circle cx="30" cy="70" r="2.5" fill="#703AE6" />
        <circle cx="210" cy="70" r="2.5" fill="#FC5457" />
      </svg>
      {/* Logo */}
      <div className="relative z-10 h-[56px] w-auto flex items-center">
        <Image
          src={logoSrc}
          alt="Vanna"
          width={160}
          height={56}
          priority
          className="h-[56px] w-auto object-contain"
        />
      </div>
    </div>
  );
};

const PoolIllustration = ({ isDark }: { isDark: boolean }) => {
  const barBg = isDark ? "#2C2C2C" : "#E5E7EB";
  const cardBg = isDark ? "#222222" : "#F7F7F7";
  return (
    <svg viewBox="0 0 200 120" fill="none" className="w-full h-full">
      <defs>
        <linearGradient id="vanna-grad-2" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#703AE6" />
          <stop offset="100%" stopColor="#FC5457" />
        </linearGradient>
      </defs>
      {[30, 56, 82].map((y, i) => (
        <g key={i}>
          <rect x="30" y={y} width="140" height="18" rx="4" fill={cardBg} />
          <circle
            cx="42"
            cy={y + 9}
            r="5"
            fill={i === 0 ? "#703AE6" : i === 1 ? "#FC5457" : "#32EEE2"}
            opacity="0.9"
          />
          <rect x="54" y={y + 5} width="32" height="3" rx="1.5" fill={barBg} />
          <rect
            x="54"
            y={y + 11}
            width="22"
            height="2"
            rx="1"
            fill={barBg}
            opacity="0.6"
          />
        </g>
      ))}
      <rect
        x="28.5"
        y="28.5"
        width="143"
        height="21"
        rx="5"
        stroke="url(#vanna-grad-2)"
        strokeWidth="1.5"
        fill="none"
      />
    </svg>
  );
};

const LeverageIllustration = ({ isDark }: { isDark: boolean }) => {
  const trackBg = isDark ? "#2C2C2C" : "#E5E7EB";
  return (
    <svg viewBox="0 0 200 120" fill="none" className="w-full h-full">
      <defs>
        <linearGradient id="vanna-grad-3" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#703AE6" />
          <stop offset="100%" stopColor="#FC5457" />
        </linearGradient>
      </defs>
      {[40, 65, 90, 115, 140, 165].map((x, i) => (
        <rect
          key={i}
          x={x}
          y={i % 2 === 0 ? 40 : 42}
          width="1"
          height={i % 2 === 0 ? 8 : 5}
          fill={trackBg}
        />
      ))}
      <text
        x="40"
        y="32"
        fontSize="8"
        fill={isDark ? "#777777" : "#9CA3AF"}
        fontFamily="sans-serif"
        fontWeight="600"
      >
        1x
      </text>
      <text
        x="155"
        y="32"
        fontSize="8"
        fill={isDark ? "#777777" : "#9CA3AF"}
        fontFamily="sans-serif"
        fontWeight="600"
      >
        7x
      </text>
      <rect x="40" y="60" width="125" height="4" rx="2" fill={trackBg} />
      <rect x="40" y="60" width="78" height="4" rx="2" fill="url(#vanna-grad-3)" />
      <circle
        cx="118"
        cy="62"
        r="9"
        fill={isDark ? "#1A1A1A" : "#FFFFFF"}
        stroke="url(#vanna-grad-3)"
        strokeWidth="2"
      />
      <circle cx="118" cy="62" r="3" fill="url(#vanna-grad-3)" />
      <rect x="104" y="80" width="28" height="16" rx="4" fill="url(#vanna-grad-3)" />
      <text
        x="118"
        y="91"
        fontSize="9"
        fill="#FFFFFF"
        fontFamily="sans-serif"
        fontWeight="700"
        textAnchor="middle"
      >
        5.0x
      </text>
    </svg>
  );
};

/**
 * Deploy illustration — stylized transaction preview card.
 * Shows a mini "Position Preview" receipt: header, two KPI rows, and a
 * gradient "Deploy" bar. Communicates "what happens on confirm" clearly.
 */
const DeployIllustration = ({ isDark }: { isDark: boolean }) => {
  const cardStroke = isDark ? "#2A2A2A" : "#E5E7EB";
  const cardFill = isDark ? "#141414" : "#FFFFFF";
  const rowFill = isDark ? "#1C1C1C" : "#F7F7F7";
  const labelColor = isDark ? "#8A8A8A" : "#6B7280";
  const valueColor = isDark ? "#FFFFFF" : "#111111";
  const mutedStroke = isDark ? "#222222" : "#EDEDED";

  return (
    <svg viewBox="0 0 240 150" fill="none" className="w-full h-full">
      <defs>
        <linearGradient id="vanna-grad-4" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#703AE6" />
          <stop offset="100%" stopColor="#FC5457" />
        </linearGradient>
        <filter id="deploy-shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="4" stdDeviation="6" floodOpacity="0.12" />
        </filter>
      </defs>

      {/* Soft backdrop glow */}
      <ellipse cx="120" cy="130" rx="90" ry="14" fill="url(#vanna-grad-4)" opacity="0.08" />

      {/* Back card (peeking) */}
      <rect
        x="44"
        y="10"
        width="152"
        height="110"
        rx="10"
        fill={cardFill}
        stroke={mutedStroke}
        strokeWidth="1"
        opacity="0.55"
        transform="rotate(-3 120 65)"
      />

      {/* Main card */}
      <g filter="url(#deploy-shadow)">
        <rect
          x="40"
          y="14"
          width="160"
          height="118"
          rx="12"
          fill={cardFill}
          stroke={cardStroke}
          strokeWidth="1"
        />
      </g>

      {/* Header row — pair + status pill */}
      <g>
        {/* Token circles */}
        <circle cx="58" cy="32" r="6" fill="#2775CA" />
        <text x="58" y="35" fontSize="5.5" fill="#FFFFFF" fontFamily="sans-serif" fontWeight="700" textAnchor="middle">
          USDC
        </text>
        <circle cx="68" cy="32" r="6" fill="#B6509E" stroke={cardFill} strokeWidth="1.5" />
        <text x="68" y="35" fontSize="5" fill="#FFFFFF" fontFamily="sans-serif" fontWeight="700" textAnchor="middle">
          AAVE
        </text>
        {/* Pair label */}
        <text x="80" y="30" fontSize="8" fill={valueColor} fontFamily="sans-serif" fontWeight="700">
          USDC · Aave
        </text>
        <text x="80" y="39" fontSize="6" fill={labelColor} fontFamily="sans-serif" fontWeight="500">
          V3 Pool
        </text>
        {/* Status pill */}
        <rect x="158" y="22" width="32" height="14" rx="7" fill="url(#vanna-grad-4)" opacity="0.12" />
        <circle cx="166" cy="29" r="1.8" fill="#703AE6" />
        <text x="172" y="32" fontSize="6" fill="#703AE6" fontFamily="sans-serif" fontWeight="700">
          READY
        </text>
      </g>

      {/* Divider */}
      <line x1="52" y1="48" x2="188" y2="48" stroke={mutedStroke} strokeWidth="1" />

      {/* KPI row 1 — Leverage */}
      <rect x="52" y="56" width="136" height="18" rx="5" fill={rowFill} />
      <text x="60" y="68" fontSize="7" fill={labelColor} fontFamily="sans-serif" fontWeight="600">
        Leverage
      </text>
      <text x="180" y="68" fontSize="8" fill={valueColor} fontFamily="sans-serif" fontWeight="700" textAnchor="end">
        5.0x
      </text>

      {/* KPI row 2 — Net APR */}
      <rect x="52" y="78" width="136" height="18" rx="5" fill={rowFill} />
      <text x="60" y="90" fontSize="7" fill={labelColor} fontFamily="sans-serif" fontWeight="600">
        Net APR
      </text>
      <text x="180" y="90" fontSize="8" fontFamily="sans-serif" fontWeight="700" textAnchor="end" fill="url(#vanna-grad-4)">
        +18.4%
      </text>

      {/* Deploy button */}
      <rect x="52" y="104" width="136" height="20" rx="6" fill="url(#vanna-grad-4)" />
      <text x="120" y="117" fontSize="8.5" fill="#FFFFFF" fontFamily="sans-serif" fontWeight="700" textAnchor="middle">
        Deploy Position
      </text>
      {/* Tiny sparkle on button */}
      <path
        d="M104 114 L106 110 L107 114 L111 115 L107 116 L106 120 L104 116 L100 115 Z"
        fill="#FFFFFF"
        opacity="0.7"
      />
    </svg>
  );
};

const SvgStepVisual = ({ stepKey, isDark }: { stepKey: StepKey; isDark: boolean }) => {
  switch (stepKey) {
    case "welcome":
      return <WelcomeIllustration isDark={isDark} />;
    case "pool":
      return <PoolIllustration isDark={isDark} />;
    case "leverage":
      return <LeverageIllustration isDark={isDark} />;
    case "deploy":
      return <DeployIllustration isDark={isDark} />;
  }
};

/* Pool slide — try user-provided image first, fallback to SVG */
const PoolVisual = ({ isDark }: { isDark: boolean }) => {
  const [failed, setFailed] = useState(false);
  if (failed) return <PoolIllustration isDark={isDark} />;
  return (
    <div className="relative w-full h-full flex items-center justify-center">
      <div
        className={`relative w-full h-full rounded-xl overflow-hidden border ${
          isDark ? "border-[#1F1F1F] bg-[#0B0B0B]" : "border-[#EDEDED] bg-white"
        }`}
        style={{
          boxShadow: isDark
            ? "0 8px 24px rgba(0,0,0,0.35)"
            : "0 8px 24px rgba(17,17,17,0.06)",
        }}
      >
        <Image
          src={POOL_IMAGE_SRC}
          alt="Pick a curated pool"
          fill
          sizes="460px"
          className="object-cover object-top"
          onError={() => setFailed(true)}
        />
      </div>
    </div>
  );
};

export const OnboardingTutorial = () => {
  const { isDark } = useTheme();
  const [isOpen, setIsOpen] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const seen = window.localStorage.getItem(STORAGE_KEY);
    if (!seen) {
      const timer = setTimeout(() => setIsOpen(true), 400);
      return () => clearTimeout(timer);
    }
  }, []);

  const markSeen = useCallback(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, "1");
    }
  }, []);

  const handleClose = useCallback(() => {
    markSeen();
    setIsOpen(false);
  }, [markSeen]);

  const handleNext = useCallback(() => {
    if (stepIndex < STEPS.length - 1) {
      setStepIndex((i) => i + 1);
    } else {
      handleClose();
    }
  }, [stepIndex, handleClose]);

  const handlePrev = useCallback(() => {
    if (stepIndex > 0) setStepIndex((i) => i - 1);
  }, [stepIndex]);

  const step = STEPS[stepIndex];
  const isLast = stepIndex === STEPS.length - 1;
  const progressPct = ((stepIndex + 1) / STEPS.length) * 100;

  const cardBg = isDark ? "bg-[#0F0F0F]" : "bg-white";
  const cardBorder = isDark ? "border-[#1F1F1F]" : "border-[#EDEDED]";
  const visualBg = isDark
    ? "bg-[linear-gradient(180deg,#161616_0%,#0F0F0F_100%)]"
    : "bg-[linear-gradient(180deg,#FAFAFA_0%,#FFFFFF_100%)]";
  const titleColor = isDark ? "text-white" : "text-[#111111]";
  const bodyColor = isDark ? "text-[#9A9A9A]" : "text-[#6B7280]";
  const eyebrowColor = isDark ? "text-[#6B6B6B]" : "text-[#9CA3AF]";
  const dividerColor = isDark ? "border-[#1F1F1F]" : "border-[#EDEDED]";
  const progressTrack = isDark ? "bg-[#1F1F1F]" : "bg-[#EDEDED]";
  const secondaryBtn = isDark
    ? "text-[#9A9A9A] hover:text-white"
    : "text-[#6B7280] hover:text-[#111111]";
  const closeBtn = isDark
    ? "text-[#6B6B6B] hover:text-white hover:bg-[#1F1F1F]"
    : "text-[#9CA3AF] hover:text-[#111111] hover:bg-[#F4F4F4]";

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[100] flex items-center justify-center px-4 bg-black/70 backdrop-blur-md"
          onClick={handleClose}
        >
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
            onClick={(e) => e.stopPropagation()}
            className={`relative w-full max-w-[460px] border rounded-[20px] overflow-hidden ${cardBg} ${cardBorder}`}
            style={{
              boxShadow: isDark
                ? "0 24px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.02)"
                : "0 24px 60px rgba(17,17,17,0.12), 0 2px 8px rgba(17,17,17,0.04)",
            }}
          >
            {/* Visual header */}
            <div className={`relative h-[200px] ${visualBg} overflow-hidden`}>
              <div className="absolute top-4 left-5 flex items-center gap-2 z-10">
                <span
                  className={`text-[10px] font-semibold uppercase tracking-[1px] ${eyebrowColor}`}
                >
                  {step.eyebrow}
                </span>
              </div>

              <button
                onClick={handleClose}
                aria-label="Close tutorial"
                className={`absolute top-3 right-3 w-8 h-8 flex items-center justify-center rounded-full transition-colors z-10 ${closeBtn}`}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path
                    d="M1 1L11 11M11 1L1 11"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </button>

              <div
                className={`absolute inset-0 flex items-center justify-center pt-8 ${
                  step.key === "pool" ? "px-5 pb-3" : "px-8 pb-4"
                }`}
              >
                <AnimatePresence mode="wait">
                  <motion.div
                    key={step.key}
                    initial={{ opacity: 0, scale: 0.96 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.98 }}
                    transition={{ duration: 0.28, ease: "easeOut" }}
                    className={`w-full h-full ${
                      step.key === "pool" ? "" : "max-h-40"
                    }`}
                  >
                    {step.key === "pool" ? (
                      <PoolVisual isDark={isDark} />
                    ) : (
                      <SvgStepVisual stepKey={step.key} isDark={isDark} />
                    )}
                  </motion.div>
                </AnimatePresence>
              </div>

              <div
                className={`absolute bottom-0 left-0 right-0 h-px ${
                  isDark ? "bg-[#1F1F1F]" : "bg-[#EDEDED]"
                }`}
              />
            </div>

            {/* Text content */}
            <div className="px-6 pt-6 pb-5">
              <AnimatePresence mode="wait">
                <motion.div
                  key={step.key}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.22, ease: "easeOut" }}
                >
                  <h2
                    className={`text-[20px] font-semibold leading-[28px] tracking-[-0.2px] mb-2 ${titleColor}`}
                  >
                    {step.title}
                  </h2>
                  <p className={`text-[13px] leading-[21px] ${bodyColor}`}>
                    {step.description}
                  </p>
                </motion.div>
              </AnimatePresence>
            </div>

            {/* Footer */}
            <div
              className={`flex items-center justify-between gap-4 px-6 py-4 border-t ${dividerColor}`}
            >
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <span className={`text-[11px] font-semibold tabular-nums ${eyebrowColor}`}>
                  {String(stepIndex + 1).padStart(2, "0")}
                  <span className="opacity-50"> / {String(STEPS.length).padStart(2, "0")}</span>
                </span>
                <div
                  className={`relative flex-1 h-[3px] rounded-full overflow-hidden ${progressTrack}`}
                >
                  <motion.div
                    className="absolute inset-y-0 left-0 bg-gradient rounded-full"
                    initial={false}
                    animate={{ width: `${progressPct}%` }}
                    transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                  />
                </div>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                {stepIndex > 0 ? (
                  <button
                    onClick={handlePrev}
                    className={`text-[12px] font-semibold px-3 py-2 rounded-lg transition-colors ${secondaryBtn}`}
                  >
                    Back
                  </button>
                ) : (
                  <button
                    onClick={handleClose}
                    className={`text-[12px] font-semibold px-3 py-2 rounded-lg transition-colors ${secondaryBtn}`}
                  >
                    Skip
                  </button>
                )}
                <button
                  onClick={handleNext}
                  className="text-[12px] font-semibold text-white bg-gradient px-4 py-2 rounded-lg hover:opacity-90 transition-opacity"
                >
                  {isLast ? "Get Started" : "Continue"}
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
