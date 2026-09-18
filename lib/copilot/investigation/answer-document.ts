import type { StructuredAnswer, AnswerVenue } from "../answer-schema";
import type { ResearchFact, ResearchView } from "./view";

/**
 * The investigation service deliberately keeps its wire contract as `message` plus
 * structured research facts.  This adapter is the boundary for UI presentation: the
 * existing message remains the headline for compatibility, while every supporting value
 * comes from an audited fact rather than from parsing or rewriting that message.
 */
export function investigationAnswerDocument(result: ResearchView): StructuredAnswer {
  const venues = [...new Set(result.facts.map((fact) => fact.venue))];
  const venue = venues.length === 1 ? answerVenue(venues[0]) : undefined;

  return {
    headline: result.message,
    facts: result.facts.map(toAnswerFact),
    ...(venue ? { venue } : {}),
  };
}

function toAnswerFact(fact: ResearchFact) {
  return {
    label: fact.label,
    value: displayFactValue(fact),
  };
}

/** Keep units attached to the value so a typed fact cannot lose its meaning in a grid. */
function displayFactValue(fact: ResearchFact): string {
  const unit = fact.unit.trim();
  const value = formatNumericValue(fact.value, unit);
  if (unit === "USD") return `$${value}`;
  if (unit === "% APR") return `${value}% APR`;
  if (unit === "HF") return value;
  return unit ? `${value} ${unit}` : value;
}

/**
 * Formatting is applied to values, never to prose.  It is intentionally limited to the
 * units emitted by the normalizer; unknown units retain their source precision.
 */
function formatNumericValue(value: string, unit: string): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return value;

  if (unit === "USD") {
    return number.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (unit === "% APR") {
    return number.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (unit === "HF") {
    return number.toFixed(2);
  }
  return value;
}

function answerVenue(venue: ResearchFact["venue"]): AnswerVenue | undefined {
  return venue === "signing" ? undefined : venue;
}
