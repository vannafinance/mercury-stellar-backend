// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { hasUnexpiredPrivySession, readPersistedPrivyExpiry } from "@/lib/privy-session";

function jwt(expSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
  return `eyJhbGciOiJub25lIn0.${payload}.sig`;
}

describe("persisted Privy session", () => {
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    document.cookie = "privy-token=; max-age=0; path=/";
  });

  it("is absent when nothing is stored", () => {
    expect(readPersistedPrivyExpiry()).toBeNull();
    expect(hasUnexpiredPrivySession(1_700_000_000_000)).toBe(false);
  });

  it("reads an unexpired privy:token from localStorage", () => {
    const exp = Math.floor(Date.now() / 1000) + 3_600;
    localStorage.setItem("privy:token", jwt(exp));
    expect(hasUnexpiredPrivySession()).toBe(true);
    expect(readPersistedPrivyExpiry()).toBe(exp * 1000);
  });

  it("treats an expired token as no session", () => {
    localStorage.setItem("privy:token", jwt(Math.floor(Date.now() / 1000) - 60));
    expect(hasUnexpiredPrivySession()).toBe(false);
  });
});
