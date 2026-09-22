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
  // Cleared as well as set: these are real markers of a Google-managed runtime, so a
  // suite that actually runs on Cloud Run (or in a Cloud Build step) would otherwise see
  // them leak in and flip every "developer_login" expectation below.
  "K_SERVICE",
  "FUNCTION_TARGET",
  "GAE_ENV",
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

  /**
   * Cloud Run holds no key and no OIDC token: the credential is the attached service
   * account, reachable only through the metadata server, which an env-var check cannot
   * see. Reporting "developer_login" there put a `gcloud login` warning on every healthy
   * deployed revision — on a host with no gcloud binary and no user login — while Vertex
   * was authenticating fine through ADC. A warning that fires on a working deploy is worse
   * than none, because it teaches people to ignore the real one.
   */
  it("Cloud Run with no key → attached_service_account, not a gcloud warning", () => {
    setEnv({ K_SERVICE: "vanna-app-dev" });
    expect(vertexAuthMode()).toBe("attached_service_account");
  });

  it("Cloud Functions gen1 (FUNCTION_TARGET) and App Engine (GAE_ENV) count too", () => {
    setEnv({ FUNCTION_TARGET: "handler" });
    expect(vertexAuthMode()).toBe("attached_service_account");
    setEnv({ GAE_ENV: "standard" });
    expect(vertexAuthMode()).toBe("attached_service_account");
  });

  it("an explicit key still wins over the attached account", () => {
    // A deploy that deliberately mounts its own key should report that key, not the
    // ambient host identity — getAccessToken tries the key first, so the chip must agree.
    setEnv({ K_SERVICE: "vanna-app-dev", GOOGLE_SERVICE_ACCOUNT_JSON: KEY_JSON });
    expect(vertexAuthMode()).toBe("service_account");
  });

  it("federation still wins over the attached account", () => {
    setEnv({
      K_SERVICE: "vanna-app-dev",
      GOOGLE_WORKLOAD_IDENTITY_AUDIENCE: AUDIENCE,
      VERCEL_OIDC_TOKEN: "header.payload.sig",
    });
    expect(vertexAuthMode()).toBe("workload_identity");
  });

  it("an empty K_SERVICE is not a managed runtime", () => {
    setEnv({ K_SERVICE: "   " });
    expect(vertexAuthMode()).toBe("developer_login");
  });
});
