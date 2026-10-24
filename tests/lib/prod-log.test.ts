import { afterEach, describe, expect, it, vi } from "vitest";
import { copilotLog } from "@/lib/copilot/prod-log";

/**
 * 24 Oct 2026: the deployed copilot logged nothing. next.config.ts strips every console.* but
 * console.error from production builds, so the investigation's phase lines (which read ran, how
 * long it took, why a run stopped) never reached Cloud Logging and two live failures could not be
 * diagnosed. A line written straight to stdout as JSON is not touched by that, and Cloud Run turns
 * it into a structured entry with a severity.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("copilotLog", () => {
  it("in production writes one structured JSON line to stdout and does not use console", () => {
    vi.stubEnv("NODE_ENV", "production");
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    copilotLog("[copilot] investigation phase", { phase: "loop", ms: 1234, outcome: "stopped", reason: "repeated_read" });
    expect(info).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
    const line = String(write.mock.calls[0][0]);
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual({
      severity: "INFO", message: "[copilot] investigation phase", component: "copilot",
      phase: "loop", ms: 1234, outcome: "stopped", reason: "repeated_read",
    });
  });

  it("outside production keeps the console line it always had", () => {
    vi.stubEnv("NODE_ENV", "development");
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    copilotLog("[copilot] investigation phase", { phase: "scope", ms: 5 });
    expect(write).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith("[copilot] investigation phase", { phase: "scope", ms: 5 });
  });

  it("a field that cannot be serialised never throws into the turn", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => copilotLog("[copilot] investigation phase", { phase: "x", circular })).not.toThrow();
  });

  it("a caller's field can never override the severity or component of the line", () => {
    vi.stubEnv("NODE_ENV", "production");
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    copilotLog("[copilot] investigation phase", { severity: "CRITICAL", component: "other", phase: "loop" });
    const parsed = JSON.parse(String(write.mock.calls[0][0]));
    expect(parsed.severity).toBe("INFO");
    expect(parsed.component).toBe("copilot");
  });
});
