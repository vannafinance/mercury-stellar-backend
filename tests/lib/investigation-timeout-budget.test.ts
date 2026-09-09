import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The timeout budgets must stay ordered, and this test exists because they were not.
 *
 * Four independent timers govern one investigation: the loop's own deadline, the bound on
 * scope resolution (which runs BEFORE the loop, so it is not covered by that deadline),
 * the route's reply guarantee, and the browser's backstop. The client's was once the
 * tightest of the four, so it fired first — the user saw "the investigation timed out"
 * and every read already completed was thrown away, instead of the partial result the
 * server was about to send.
 *
 * The invariant: runtime + scope <= route < client. Asserted against the source rather
 * than a duplicated constant, so nobody can retune one number in isolation and
 * reintroduce the inversion.
 */

const read = (path: string) => readFileSync(path, "utf8");

function onlyNumber(source: string, pattern: RegExp, label: string): number {
  const match = source.match(pattern);
  if (!match) throw new Error(`could not find ${label}`);
  return Number(match[1].replace(/_/g, ""));
}

describe("investigation timeout budgets", () => {
  const runtimeMs = onlyNumber(
    read("lib/copilot/investigation/runtime.ts"),
    /maxDurationMs:\s*([\d_]+)/,
    "runtime deadline",
  );
  const scopeMs = onlyNumber(
    read("lib/copilot/investigation/service.ts"),
    /SCOPE_BUDGET_MS\s*=\s*([\d_]+)/,
    "scope-resolution bound",
  );
  const positionMs = onlyNumber(
    read("lib/copilot/investigation/service.ts"),
    /POSITION_BUDGET_MS\s*=\s*([\d_]+)/,
    "position-read bound",
  );
  const routeMs = onlyNumber(
    read("app/api/copilot/investigate/route.ts"),
    /setTimeout\(\(\) => (?:abort\.abort|onDeadline)\(\),\s*([\d_]+)\)/,
    "route reply guarantee",
  );
  const clientMs = onlyNumber(
    read("hooks/use-investigation.ts"),
    /setTimeout\(\(\) => controller\.abort\(\),\s*([\d_]+)\)/,
    "client backstop",
  );

  it("gives everything that blocks the loop no more than the route promises", () => {
    // Every one of these is serial before or around the loop, so they add up against the
    // route's single reply guarantee. Counting only two of the three is what let 83s of
    // work sit behind a 75s promise.
    expect(scopeMs + positionMs + runtimeMs).toBeLessThanOrEqual(routeMs);
  });

  it("bounds the position read, since an unbounded one can spend the whole route", () => {
    expect(positionMs).toBeGreaterThan(0);
    expect(positionMs).toBeLessThan(runtimeMs);
  });

  it("lets the server always answer before the browser gives up", () => {
    // Strictly greater, with real headroom: equal timers race, and the loser is the user.
    expect(clientMs).toBeGreaterThan(routeMs);
    expect(clientMs - routeMs).toBeGreaterThanOrEqual(15_000);
  });

  it("stays inside the route's own serverless ceiling", () => {
    const maxDuration = onlyNumber(
      read("app/api/copilot/investigate/route.ts"),
      /maxDuration\s*=\s*(\d+)/,
      "maxDuration",
    );
    expect(routeMs).toBeLessThanOrEqual(maxDuration * 1_000);
  });

  it("keeps every budget positive and human-scaled", () => {
    for (const [label, value] of Object.entries({ runtimeMs, scopeMs, positionMs, routeMs, clientMs })) {
      expect(value, label).toBeGreaterThan(5_000);
      expect(value, label).toBeLessThanOrEqual(300_000);
    }
  });
});
