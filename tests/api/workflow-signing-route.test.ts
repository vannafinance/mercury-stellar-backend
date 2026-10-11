import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const h = vi.hoisted(() => ({ user: vi.fn(), prepare: vi.fn() }));
vi.mock("@/lib/copilot/request-user", () => ({ loadUserFromRequest: h.user }));
vi.mock("@/lib/copilot/config", () => ({ copilotConfig: { publicOrigin: "http://test", mcpBaseUrl: "http://mcp", sessionSecret: "x".repeat(32) } }));
vi.mock("@/lib/copilot/investigation/execute", () => ({ prepareWorkflowSigning: h.prepare }));
vi.mock("@/lib/copilot/mcp-client", () => ({ getMcpClient: () => ({}) }));
import { POST } from "@/app/api/copilot/workflow/[id]/prepare-sign/route";
const ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
function call(body = "{}", origin = "http://test") {
  return POST(new NextRequest(`http://test/api/copilot/workflow/${ID}/prepare-sign`, { method: "POST", headers: { origin }, body }), { params: Promise.resolve({ id: ID }) });
}
beforeEach(() => {
  vi.clearAllMocks();
  h.user.mockResolvedValue({ bound: { sub: "owner", kind: "stellar", accessToken: "" }, commit: (r: Response) => r });
  h.prepare.mockResolvedValue({ id: ID, status: "awaiting_signature" });
});
describe("owned signing preparation route", () => {
  it("uses the authenticated subject and server-owned journal without accepting transaction details", async () => {
    const response = await call(); expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(h.prepare).toHaveBeenCalledWith(expect.objectContaining({ id: ID, subject: "owner", server: "http://mcp", network: "testnet" }));
  });
  it("requires a current authenticated session", async () => {
    h.user.mockResolvedValue({ bound: null, commit: (r: Response) => r });
    expect((await call()).status).toBe(401); expect(h.prepare).not.toHaveBeenCalled();
  });
  it("refuses injected tools, amounts and envelopes", async () => {
    expect((await call(JSON.stringify({ amount: "900", unsignedXdr: "fake" }))).status).toBe(400);
    expect(h.prepare).not.toHaveBeenCalled();
  });
  it("refuses a foreign origin", async () => {
    expect((await call("{}", "http://foreign")).status).toBe(403); expect(h.prepare).not.toHaveBeenCalled();
  });
  it("keeps transport failures distinct from a transaction execution failure", async () => {
    h.prepare.mockRejectedValue(new TypeError("network"));
    const response = await call(); expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("signing_unavailable");
  });
});
