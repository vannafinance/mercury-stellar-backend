// Entrypoint wrapper for the Next standalone server.
//
// WHY THIS EXISTS
// App Router stamps `Vary: rsc, next-router-state-tree, next-router-prefetch,
// next-router-segment-prefetch` onto every response, including plain JSON route
// handlers. Cloud CDN only caches responses whose Vary stays within a small
// allowlist (Accept, Accept-Encoding, Origin, Sec-Fetch-*), so those values
// silently disqualify every /api response from being cached — the s-maxage
// values the routes set are read and then discarded. Vercel's CDN accepts
// arbitrary Vary, which is why this only appeared after the move to GCP.
//
// Next appends its RSC values to whatever Vary already exists, so
// next.config.ts headers(), route-level headers and middleware all land BEFORE
// it and get appended to rather than replacing it. There is no override point
// inside Next: https://github.com/vercel/next.js/discussions/66471
//
// So intercept at the Node layer instead, which is the only place that runs
// after Next. Scoped to /api paths only: those Vary values are load-bearing for
// HTML and RSC responses, where Next uses them to avoid serving a
// client-navigation payload in place of a full document.
//
// REMOVE THIS when Next stops emitting the header (it has already been
// superseded by the `_rsc` query parameter for CDN disambiguation) and restore
// `CMD ["node", "server.js"]` in the Dockerfile.

const http = require("node:http");

const RSC_VARY = new Set([
  "rsc",
  "next-router-state-tree",
  "next-router-prefetch",
  "next-router-segment-prefetch",
  "next-url",
]);

/** Drop RSC values from a Vary header. Returns "" when nothing survives. */
function stripRsc(value) {
  return (Array.isArray(value) ? value.join(",") : String(value))
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && !RSC_VARY.has(s.toLowerCase()))
    .join(", ");
}

const isApi = (res) => (res.req?.url || "").startsWith("/api/");
const isVary = (name) => typeof name === "string" && name.toLowerCase() === "vary";

const setHeader = http.ServerResponse.prototype.setHeader;
http.ServerResponse.prototype.setHeader = function (name, value) {
  if (isVary(name) && isApi(this)) {
    // Never leave the header absent — an /api response that varies on nothing
    // still legitimately varies on Accept-Encoding, since the load balancer
    // negotiates compression.
    value = stripRsc(value) || "Accept-Encoding";
  }
  return setHeader.call(this, name, value);
};

const appendHeader = http.ServerResponse.prototype.appendHeader;
if (appendHeader) {
  http.ServerResponse.prototype.appendHeader = function (name, value) {
    if (isVary(name) && isApi(this)) {
      const kept = stripRsc(value);
      // Appending the fallback here would duplicate an existing Accept-Encoding.
      if (!kept) return this;
      value = kept;
    }
    return appendHeader.call(this, name, value);
  };
}

const writeHead = http.ServerResponse.prototype.writeHead;
http.ServerResponse.prototype.writeHead = function (statusCode, reason, headers) {
  const bag = typeof reason === "object" && reason !== null ? reason : headers;
  if (bag && !Array.isArray(bag) && isApi(this)) {
    for (const key of Object.keys(bag)) {
      if (isVary(key)) bag[key] = stripRsc(bag[key]) || "Accept-Encoding";
    }
  }
  return writeHead.apply(this, arguments);
};

require("./server.js");
