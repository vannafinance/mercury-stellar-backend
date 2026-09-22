import { Buffer } from 'node:buffer';
import { context } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';

// Ensure Buffer is available globally (happy-dom doesn't expose it by default)
if (typeof globalThis.Buffer === 'undefined') {
  (globalThis as unknown as Record<string, unknown>).Buffer = Buffer;
}

// NodeSDK is not loaded in vitest. Without a context manager, getActiveSpan()
// cannot see the span withSpan just started (OTel default manager is a no-op).
context.setGlobalContextManager(new AsyncLocalStorageContextManager());

// Ensure Buffer is available globally (happy-dom doesn't expose it by default)
if (typeof globalThis.Buffer === 'undefined') {
  (globalThis as unknown as Record<string, unknown>).Buffer = Buffer;
}
