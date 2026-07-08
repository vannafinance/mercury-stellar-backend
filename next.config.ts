import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained .next/standalone/server.js (only the traced runtime
  // deps) so the Cloud Run container image stays slim. Required by the Docker
  // build — without it there is no standalone server to copy into the runner.
  output: "standalone",

  compiler: {
    // Strip console.* from production bundles at build time so the 167 dev log
    // calls across the app never ship to users — smaller bundles, no main-thread
    // logging cost, and no internal detail leaked in the console. console.error
    // is kept so genuine production errors remain visible (e.g. to monitoring).
    // Dev builds keep all logging.
    removeConsole:
      process.env.NODE_ENV === "production" ? { exclude: ["error"] } : false,
  },
};

export default nextConfig;
