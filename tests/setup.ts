import { Buffer } from 'node:buffer';

// Ensure Buffer is available globally (happy-dom doesn't expose it by default)
if (typeof globalThis.Buffer === 'undefined') {
  (globalThis as unknown as Record<string, unknown>).Buffer = Buffer;
}
