/**
 * Manual NodeSDK setup from the Next.js 16.2.3 OpenTelemetry guide, with two
 * product choices that guide's sample does not make:
 *
 * 1. OTLP export only when OTEL_EXPORTER_OTLP_ENDPOINT is set. The SDK still
 *    starts so AsyncLocalStorage context is registered — without it,
 *    getActiveSpan() cannot attach token usage after an await.
 * 2. BatchSpanProcessor instead of Simple — Simple exports on every span and
 *    would add latency to the investigation path we are trying to measure.
 *
 * Langfuse (self-hosted ≥ 3.22) wants OTLP/HTTP, not gRPC:
 *   OTEL_EXPORTER_OTLP_ENDPOINT={host}/api/public/otel
 *   OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic …,x-langfuse-ingestion-version=4
 */
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { setupBrokenPipeHandling } from "./lib/server/broken-pipe";

setupBrokenPipeHandling();

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
const sdk = new NodeSDK({
  // NodeSDK 0.222 field. Next 16.2.3 sample still uses resourceFromAttributes
  // + ATTR_SERVICE_NAME; both set service.name.
  serviceName: process.env.OTEL_SERVICE_NAME?.trim() || "vanna-copilot",
  ...(endpoint
    ? { spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())] }
    : {}),
});
sdk.start();
const shutdown = () => {
  void sdk.shutdown();
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
