"use client";

/**
 * Health-factor dial — the single most important number on this page, as a gauge.
 *
 * Ported from the Claude Design `Copilot.dc.html` "Your account" tile. A ratio in a table
 * says nothing about proximity: 1.35 and 3.40 are both just numbers until you can see that
 * one sits a hair above the liquidation arc and the other is nowhere near it. The dial makes
 * distance-to-liquidation the thing you read first.
 *
 * Three properties it is careful about, each of them a way a gauge can lie:
 *
 *   - The danger arc is always drawn in full colour, never dimmed. Every other zone dims
 *     when the needle is elsewhere, but the band that means "you get liquidated here" does
 *     not fade just because you are currently safe.
 *   - No debt is not the same as a high ratio. With nothing borrowed the health factor is
 *     mathematically infinite; the needle parks at the top of the scale and the figure reads
 *     "∞", rather than showing some large number that invites comparison.
 *   - An unavailable reading is drawn as unavailable — grey, no needle, no arc highlight.
 *     A gauge that defaults to full-green when the read failed is worse than no gauge, and
 *     that failure has happened on this surface before.
 *
 * Geometry is the design's, unchanged: a semicircle spanning health factor 1.0 → 3.0, so
 * `t = (hf - 1) / 2` clamped, swept from π (left) to 0 (right) about the centre (90, 92).
 */

const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

export type HealthZone = "danger" | "warn" | "caution" | "healthy" | "unknown";

/** Boundaries match `lib/margin-health.ts`; liquidation is 1.10 with no threshold haircut. */
export function zoneOf(hf: number | null | undefined): HealthZone {
  if (hf == null || Number.isNaN(hf)) return "unknown";
  if (hf <= 1.1) return "danger";
  if (hf < 1.3) return "warn";
  if (hf < 1.8) return "caution";
  return "healthy";
}

const ZONE_COLOR: Record<HealthZone, string> = {
  danger: "var(--z-danger)",
  warn: "var(--z-warn)",
  caution: "var(--z-caution)",
  healthy: "var(--z-healthy)",
  unknown: "var(--g400)",
};

const ZONE_DIM: Record<HealthZone, string> = {
  danger: "var(--z-danger-dim)",
  warn: "var(--z-warn-dim)",
  caution: "var(--z-caution-dim)",
  healthy: "var(--z-healthy-dim)",
  unknown: "var(--g50)",
};

const ZONE_LABEL: Record<HealthZone, string> = {
  danger: "at risk",
  warn: "caution",
  caution: "watch",
  healthy: "healthy",
  unknown: "unavailable",
};

const CX = 90;
const CY = 92;

function dialT(v: number): number {
  return Math.max(0, Math.min(1, (v - 1) / 2));
}

function dialPoint(t: number, r: number): { x: number; y: number } {
  const a = Math.PI * (1 - Math.max(0, Math.min(1, t)));
  return { x: CX + r * Math.cos(a), y: CY - r * Math.sin(a) };
}

function dialArc(v0: number, v1: number, r: number): string {
  const p0 = dialPoint(dialT(v0), r);
  const p1 = dialPoint(dialT(v1), r);
  return `M ${p0.x.toFixed(2)} ${p0.y.toFixed(2)} A ${r} ${r} 0 0 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`;
}

const SEGMENTS: Array<{ z: Exclude<HealthZone, "unknown">; a: number; b: number }> = [
  { z: "danger", a: 1.0, b: 1.1 },
  { z: "warn", a: 1.1, b: 1.3 },
  { z: "caution", a: 1.3, b: 1.8 },
  { z: "healthy", a: 1.8, b: 3.0 },
];

export interface HealthDialProps {
  /** Live health factor. null when the position read failed — drawn as unavailable. */
  hf: number | null;
  /** The user's own floor, or the policy default. Marked as a violet tick. */
  floor?: number;
  /** Where it would land if the pending plan ran — drawn as a hollow "from" marker. */
  hfBefore?: number | null;
  collateralUsd?: number | null;
  debtUsd?: number | null;
  /** True when nothing is borrowed: the ratio is infinite, not merely large. */
  noDebt?: boolean;
}

const money = (n: number) =>
  `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function HealthDial({
  hf,
  floor = 1.3,
  hfBefore = null,
  collateralUsd = null,
  debtUsd = null,
  noDebt = false,
}: HealthDialProps) {
  const unknown = hf == null || !Number.isFinite(hf);
  const zone: HealthZone = unknown ? "unknown" : noDebt ? "healthy" : zoneOf(hf);
  const color = ZONE_COLOR[zone];

  // Parked at the top of the scale rather than off it: with no debt the ratio is infinite,
  // and a needle past the arc reads as a rendering fault.
  const needleValue = unknown ? null : noDebt ? 3.0 : (hf as number);
  const needle = needleValue == null ? { x: CX, y: CY } : dialPoint(dialT(needleValue), 50);

  const ghost =
    !unknown && hfBefore != null && Number.isFinite(hfBefore) && Math.abs((hf as number) - hfBefore) > 0.005
      ? dialPoint(dialT(hfBefore), 66)
      : null;

  const floorIn = dialPoint(dialT(floor), 57);
  const floorOut = dialPoint(dialT(floor), 75);

  const hfText = unknown ? "—" : noDebt ? "∞" : (hf as number).toFixed(2);
  const hfSub = unknown
    ? "position read unavailable"
    : noDebt
      ? "no debt — nothing to liquidate"
      : `liquidates at 1.10`;

  // Proportional to each other, so the two bars are comparable rather than each filling its
  // own track. Debt beside a much larger collateral figure should look small.
  const scale = Math.max(collateralUsd ?? 0, debtUsd ?? 0, 1);
  const pct = (n: number | null) => `${Math.max(0, Math.min(100, ((n ?? 0) / scale) * 100))}%`;

  return (
    <div
      style={{
        borderRadius: 20,
        border: `1px solid ${unknown ? "var(--g100)" : ZONE_DIM[zone]}`,
        background: unknown ? "var(--surface)" : ZONE_DIM[zone],
        padding: 22,
        transition: "background 300ms ease, border-color 300ms ease",
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <p
          className="m-0 uppercase"
          style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: ".22em", color: "var(--g400)" }}
        >
          Your account
        </p>
        <span
          className="uppercase"
          style={{
            borderRadius: 6,
            padding: "4px 10px",
            fontFamily: MONO,
            fontSize: 9.5,
            letterSpacing: ".16em",
            fontWeight: 700,
            color,
            background: ZONE_DIM[zone],
          }}
        >
          {ZONE_LABEL[zone]}
        </span>
      </div>

      <div className="mt-3 flex items-center gap-3.5">
        <svg
          role="img"
          aria-label={
            unknown
              ? "Health factor unavailable"
              : `Health factor ${hfText}, ${ZONE_LABEL[zone]}, liquidation at 1.10`
          }
          viewBox="0 0 180 108"
          style={{ width: 150, height: "auto", flexShrink: 0 }}
        >
          {SEGMENTS.map((s) => (
            <path
              key={s.z}
              d={dialArc(s.a, s.b, 66)}
              fill="none"
              strokeWidth={9}
              // The liquidation band never dims. Every other zone fades when the needle is
              // elsewhere; the one that means "liquidated here" stays legible regardless.
              stroke={
                s.z === "danger"
                  ? "var(--z-danger)"
                  : s.z === zone
                    ? ZONE_COLOR[s.z]
                    : ZONE_DIM[s.z]
              }
            />
          ))}

          {ghost ? (
            <circle
              cx={ghost.x}
              cy={ghost.y}
              r={3.6}
              fill="var(--surface)"
              stroke="var(--g300)"
              strokeWidth={1.8}
            />
          ) : null}

          <line
            x1={floorIn.x}
            y1={floorIn.y}
            x2={floorOut.x}
            y2={floorOut.y}
            stroke="var(--violet-500)"
            strokeWidth={2.4}
            strokeLinecap="round"
          />

          {/* No needle when the reading is unavailable — pointing at a zone we did not
              measure would assert something we do not know. */}
          {needleValue != null ? (
            <>
              <line
                x1={CX}
                y1={CY}
                x2={needle.x}
                y2={needle.y}
                stroke={color}
                strokeWidth={2.6}
                strokeLinecap="round"
              />
              <circle cx={CX} cy={CY} r={4.2} fill={color} />
            </>
          ) : null}

          <text x={18} y={106} fontFamily={MONO} fontSize={9} fill="var(--z-danger)">
            1.10
          </text>
          <text x={146} y={106} fontFamily={MONO} fontSize={9} fill="var(--g400)">
            3.0+
          </text>
        </svg>

        <div className="min-w-0">
          <p
            className="m-0 uppercase"
            style={{ fontFamily: MONO, fontSize: 10, letterSpacing: ".18em", color: "var(--g400)" }}
          >
            health factor
          </p>
          <p
            className="m-0 mt-0.5"
            style={{
              fontFamily: MONO,
              fontSize: 36,
              lineHeight: "42px",
              fontWeight: 700,
              fontVariantNumeric: "tabular-nums",
              color,
            }}
          >
            {hfText}
          </p>
          <p
            className="m-0 mt-0.5"
            style={{ fontFamily: MONO, fontSize: 10.5, lineHeight: "15px", color: "var(--g400)" }}
          >
            {hfSub}
          </p>
          {ghost && hfBefore != null ? (
            <p
              className="m-0 mt-1.5"
              style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--g500)" }}
            >
              from {hfBefore.toFixed(2)} · pending
            </p>
          ) : null}
          <p
            className="m-0 mt-1.5"
            style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--violet-500)" }}
          >
            your floor {floor.toFixed(2)}
          </p>
        </div>
      </div>

      {collateralUsd != null || debtUsd != null ? (
        <div className="mt-4 flex flex-col gap-3">
          {[
            { label: "collateral", value: collateralUsd, bar: "var(--bar-cool)" },
            { label: "borrowed · deployed", value: debtUsd, bar: "var(--bar-warm)" },
          ].map((row) => (
            <div key={row.label}>
              <div className="flex items-baseline justify-between gap-3">
                <span
                  className="uppercase"
                  style={{
                    fontFamily: MONO,
                    fontSize: 10.5,
                    letterSpacing: ".1em",
                    color: "var(--g400)",
                  }}
                >
                  {row.label}
                </span>
                <span
                  style={{
                    fontFamily: MONO,
                    fontSize: 13,
                    fontVariantNumeric: "tabular-nums",
                    color: "var(--g900)",
                  }}
                >
                  {row.value == null ? "—" : money(row.value)}
                </span>
              </div>
              <div
                className="mt-1.5 overflow-hidden"
                style={{ height: 6, borderRadius: 999, background: "var(--bar-track)" }}
              >
                <div
                  style={{
                    height: 6,
                    width: pct(row.value),
                    borderRadius: 999,
                    background: row.bar,
                    transition: "width 400ms ease-out",
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
