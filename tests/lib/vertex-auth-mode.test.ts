import { describe, it, expect, afterEach } from "vitest";
import { vertexAuthMode } from "@/lib/copilot/vertex";

/**
 * Which credential Vertex will use, and in what order.
 *
 * This decision is invisible until it fails, and when it fails the symptom is not an error
 * the user can read — the routing call throws, understanding falls back to keyword
 * matching, and the reply becomes the generic capability paragraph. That is what made the
 * same prompt answer on one machine and not another, so the selection is pinned here.
 */

const VARS = [
  "GOOGLE_WORKLOAD_IDENTITY_AUDIENCE",
  "GOOGLE_WORKLOAD_IDENTITY_SERVICE_ACCOUNT",
  "GOOGLE_OIDC_TOKEN_ENV",
  "VERCEL_OIDC_TOKEN",
  "CUSTOM_OIDC_TOKEN",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "GOOGLE_APPLICATION_CREDENTIALS_JSON",
] as const;

const saved = new Map<string, string | undefined>();
function setEnv(vars: Record<string, string | undefined>) {
  for (const v of VARS) {
    if (!saved.has(v)) saved.set(v, process.env[v]);
    delete process.env[v];
  }
  for (const [k, v] of Object.entries(vars)) {
    if (v !== undefined) process.env[k] = v;
  }
}

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
});

const AUDIENCE =
  "//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/vercel/providers/vercel-oidc";
const KEY_JSON = JSON.stringify({
  client_email: "vanna-copilot@vanna-mcp.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\\nx\\n-----END PRIVATE KEY-----\\n",
});

describe("vertexAuthMode", () => {
  it("nothing configured → developer login (the state to warn about)", () => {
    setEnv({});
    expect(vertexAuthMode()).toBe("developer_login");
  });

  it("a service-account key → service_account", () => {
    setEnv({ GOOGLE_SERVICE_ACCOUNT_JSON: KEY_JSON });
    expect(vertexAuthMode()).toBe("service_account");
  });

  it("accepts the GOOGLE_APPLICATION_CREDENTIALS_JSON spelling too", () => {
    setEnv({ GOOGLE_APPLICATION_CREDENTIALS_JSON: KEY_JSON });
    expect(vertexAuthMode()).toBe("service_account");
  });

  it("federation audience + host OIDC token → workload_identity", () => {
    setEnv({
      GOOGLE_WORKLOAD_IDENTITY_AUDIENCE: AUDIENCE,
      VERCEL_OIDC_TOKEN: "header.payload.sig",
    });
    expect(vertexAuthMode()).toBe("workload_identity");
  });

  it("federation wins over a key when both are present", () => {
    // The keyless credential should be preferred: a key in an env var is a durable secret
    // and federation has nothing to leak.
    setEnv({
      GOOGLE_WORKLOAD_IDENTITY_AUDIENCE: AUDIENCE,
      VERCEL_OIDC_TOKEN: "header.payload.sig",
      GOOGLE_SERVICE_ACCOUNT_JSON: KEY_JSON,
    });
    expect(vertexAuthMode()).toBe("workload_identity");
  });

  it("federation configured but no OIDC token → falls back, does not claim federation", () => {
    // The normal state on a laptop: the audience is in .env.example / shared config but no
    // host is minting a token. Claiming "workload_identity" here would hide a broken deploy.
    setEnv({
      GOOGLE_WORKLOAD_IDENTITY_AUDIENCE: AUDIENCE,
      GOOGLE_SERVICE_ACCOUNT_JSON: KEY_JSON,
    });
    expect(vertexAuthMode()).toBe("service_account");
  });

  it("federation configured, no OIDC token and no key → developer login", () => {
    setEnv({ GOOGLE_WORKLOAD_IDENTITY_AUDIENCE: AUDIENCE });
    expect(vertexAuthMode()).toBe("developer_login");
  });

  it("an empty OIDC token does not count as federation", () => {
    setEnv({ GOOGLE_WORKLOAD_IDENTITY_AUDIENCE: AUDIENCE, VERCEL_OIDC_TOKEN: "   " });
    expect(vertexAuthMode()).toBe("developer_login");
  });

  it("the OIDC token variable is overridable, so this is not Vercel-only", () => {
    setEnv({
      GOOGLE_WORKLOAD_IDENTITY_AUDIENCE: AUDIENCE,
      GOOGLE_OIDC_TOKEN_ENV: "CUSTOM_OIDC_TOKEN",
      CUSTOM_OIDC_TOKEN: "header.payload.sig",
    });
    expect(vertexAuthMode()).toBe("workload_identity");
  });

  it("an OIDC token under the default name is ignored when the override points elsewhere", () => {
    setEnv({
      GOOGLE_WORKLOAD_IDENTITY_AUDIENCE: AUDIENCE,
      GOOGLE_OIDC_TOKEN_ENV: "CUSTOM_OIDC_TOKEN",
      VERCEL_OIDC_TOKEN: "header.payload.sig",
    });
    expect(vertexAuthMode()).toBe("developer_login");
  });
});
