import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Avoid restoring stale route artifacts between local verification runs.
    turbopackFileSystemCacheForDev: false,
  },
  serverExternalPackages: [
    "@opentelemetry/sdk-node",
    "@opentelemetry/resources",
    "@opentelemetry/sdk-trace-node",
    "@opentelemetry/exporter-trace-otlp-http",
    "@opentelemetry/semantic-conventions",
    "@opentelemetry/context-async-hooks",
  ],
  turbopack: {
    // This repo sits beside another package-lock.json. Pin tracing/build scope
    // to this application instead of letting Next infer the parent workspace.
    root: process.cwd(),
  },
  // Emit a self-contained .next/standalone/server.js (only the traced runtime
  // deps) so the Cloud Run container image stays slim. Required by the Docker
  // build — without it there is no standalone server to copy into the runner.
  output: "standalone",

  compiler: {
    // Strip console.* from production bundles at build time so the 167 dev log
    // calls across the app never ship to users — smaller bundles, no main-thread
    // logging cost, and no internal detail leaked in the console. console.error
    // is kept so genuine production errors remain visible (e.g. to monitoring).
    // console.warn is kept too: the server's warn lines are the only record of why a
    // copilot run stopped (decision/evidence refused, failed reads), and stripping them
    // left "could not be completed" failures undiagnosable in Cloud Logging (24 Oct).
    // Dev builds keep all logging.
    removeConsole:
      process.env.NODE_ENV === "production" ? { exclude: ["error", "warn"] } : false,
  },
};

export default nextConfig;
