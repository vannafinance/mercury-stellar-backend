/**
 * Which credential a call goes out with, and that the ambient binding actually
 * survives async work (it is bound once per request and read deep inside
 * handle.ts, so if it did not propagate across awaits every write would silently
 * fall back to M2M).
 */

import { describe, expect, it } from "vitest";
import {
  callNeedsUserToken,
  currentUser,
  readOnlyToolNames,
  withBoundUser,
} from "@/lib/copilot/user-context";

const USER = { sub: "user_01KX5T71JJ7PY4RVV06K9SW04E", accessToken: "tok" };

describe("read/write credential split", () => {
  it("reads stay on M2M", () => {
    for (const tool of [
      "vanna_get_price",
      "vanna_get_account_health",
      "vanna_get_pool_stats",
      "vanna_oracle",
      "vanna_margin_status",
      "vanna_list_smart_accounts",
    ]) {
      expect(callNeedsUserToken(tool)).toBe(false);
    }
  });

  it("writes and signing need the user token", () => {
    for (const tool of [
      "vanna_lend",
      "vanna_borrow",
      "vanna_swap",
      "vanna_deposit_collateral",
      "vanna_enable_auto_sign",
      "vanna_sign_and_submit",
      "vanna_sign",
      "vanna_earn_write",
      "vanna_margin_trade",
    ]) {
      expect(callNeedsUserToken(tool)).toBe(true);
    }
  });

  it("an UNKNOWN tool defaults to the user token, not to M2M", () => {
    // The allowlist is of reads on purpose. A write tool added later must not
    // quietly regress to the machine credential and fail auto-sign with a 401
    // that points at nothing.
    expect(callNeedsUserToken("vanna_some_future_write")).toBe(true);
    expect(callNeedsUserToken("")).toBe(true);
  });

  it("every read name is a vanna tool (guards against typos in the allowlist)", () => {
    for (const name of readOnlyToolNames()) {
      expect(name.startsWith("vanna_")).toBe(true);
    }
  });
});

describe("ambient binding", () => {
  it("is null outside a bound scope", () => {
    expect(currentUser()).toBeNull();
  });

  it("survives awaits, which is the entire point", async () => {
    await withBoundUser(USER, async () => {
      expect(currentUser()?.sub).toBe(USER.sub);
      await new Promise((r) => setTimeout(r, 5));
      expect(currentUser()?.sub).toBe(USER.sub);
      await Promise.all([
        (async () => {
          await new Promise((r) => setTimeout(r, 1));
          expect(currentUser()?.sub).toBe(USER.sub);
        })(),
      ]);
    });
    expect(currentUser()).toBeNull();
  });

  it("does not leak between concurrent requests", async () => {
    const a = { sub: "user_a", accessToken: "ta" };
    const b = { sub: "user_b", accessToken: "tb" };
    const seen: string[] = [];
    await Promise.all([
      withBoundUser(a, async () => {
        await new Promise((r) => setTimeout(r, 10));
        seen.push(currentUser()!.sub);
      }),
      withBoundUser(b, async () => {
        await new Promise((r) => setTimeout(r, 2));
        seen.push(currentUser()!.sub);
      }),
    ]);
    expect(seen.sort()).toEqual(["user_a", "user_b"]);
  });

  it("binding null runs the function signed-out", async () => {
    const out = await withBoundUser(null, async () => currentUser());
    expect(out).toBeNull();
  });
});
