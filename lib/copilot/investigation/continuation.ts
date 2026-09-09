import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { InvestigationScope } from "./types";
import { ResearchError } from "./scope";
import { isRecord } from "./decision";
import { isResearchEvidence, type ResearchEvidence } from "./evidence";

export type { ResearchEvidence };

export interface ResearchConversation {
  purpose: "vanna-research-v1";
  scope: InvestigationScope;
  server: string;
  expiresAt: number;
  messages: string[];
  lastQuestion: string | null;
  /**
   * Compact reads + capacity from this investigation. Propose reuses them when
   * still fresh so "Prepare this plan" is not a second world-read.
   */
  evidence?: ResearchEvidence;
}

/** Client-held encrypted context, authenticated by the server. Never an approval token. */
export function researchCodec(secret: string, server: string, now = Date.now) {
  if (secret.length < 32) throw new ResearchError("research_not_configured", "Investigation is not configured on this deployment yet.", 503);
  const key = Buffer.from(hkdfSync("sha256", secret, "vanna-research", "continuation-v1", 32));
  const validate = (value: unknown): value is ResearchConversation => {
    if (!isRecord(value) || value.purpose !== "vanna-research-v1" || value.server !== server ||
      !isRecord(value.scope) || typeof value.scope.subject !== "string" ||
      typeof value.scope.network !== "string" ||
      ![value.scope.trader, value.scope.smartAccount].every((address) => address === null || typeof address === "string") ||
      typeof value.expiresAt !== "number" || value.expiresAt <= now() || value.expiresAt > now() + 30 * 60_000 ||
      !Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 8 ||
      !value.messages.every((message) => typeof message === "string" && message.trim().length > 0 && message.length <= 8_000) ||
      value.messages.join("").length > 24_000 ||
      !(value.lastQuestion === null || typeof value.lastQuestion === "string" && value.lastQuestion.length <= 1600) ||
      (value.evidence !== undefined && !isResearchEvidence(value.evidence))) return false;
    return true;
  };
  const read = (token: string): ResearchConversation => {
    try {
      if (token.length > 65_536) throw new Error("length");
      const [version, iv, tag, ciphertext, extra] = token.split(".");
      if (version !== "r1" || extra || !iv || !tag || !ciphertext) throw new Error("shape");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      decipher.setAAD(Buffer.from("vanna-research-v1"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      const value: unknown = JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8"));
      if (!validate(value)) throw new Error("shape");
      return value;
    } catch (error) {
      if (error instanceof ResearchError) throw error;
      throw new ResearchError("context_expired", "This investigation has expired or the connected account changed. Start a new investigation to refresh its context.");
    }
  };
  function encrypt(value: ResearchConversation): string {
    const payload = { ...value };
    if (payload.evidence === undefined) delete payload.evidence;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from("vanna-research-v1"));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
    return ["r1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
  }
  return {
    open(token: string, scope: InvestigationScope): ResearchConversation {
      const value = read(token);
      if (value.scope.subject !== scope.subject || value.scope.trader !== scope.trader ||
        value.scope.smartAccount !== scope.smartAccount || value.scope.network !== scope.network) {
        throw new ResearchError("context_expired", "This investigation has expired or the connected account changed. Start a new investigation to refresh its context.");
      }
      return value;
    },
    /**
     * Decrypt a continuation without a pre-resolved scope. The caller must re-resolve
     * scope independently and confirm it still matches — used by proposal routes, which
     * receive only the sealed token and must not take a wallet from the browser.
     */
    read,
    seal(
      scope: InvestigationScope,
      messages: string[],
      lastQuestion: string | null,
      evidence?: ResearchEvidence | null,
    ): string {
      const value: ResearchConversation = {
        purpose: "vanna-research-v1", server, scope, messages, lastQuestion, expiresAt: now() + 30 * 60_000,
        ...(evidence ? { evidence } : {}),
      };
      if (!validate(value)) throw new ResearchError("context_full", "This investigation has reached its conversation limit. Start a new one with your current requirements.");
      const token = encrypt(value);
      // Evidence is an accelerator, not a requirement. If it blows the token budget,
      // drop it and let propose re-read rather than failing the investigation.
      if (token.length > 65_536) {
        if (!evidence) throw new ResearchError("context_full", "This investigation has reached its conversation limit. Start a new investigation.");
        const fallback = encrypt({ ...value, evidence: undefined });
        if (fallback.length > 65_536) throw new ResearchError("context_full", "This investigation has reached its conversation limit. Start a new investigation.");
        return fallback;
      }
      return token;
    },
  };
}
