// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';

// ─── Controllable Horizon SSE mock ───────────────────────────────────────────
let capturedHandlers: { onmessage?: (r: unknown) => void; onerror?: (e: unknown) => void } = {};
let capturedCloseStream = vi.fn();

vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>();

  function MockHorizonServer() {
    return {
      ledgers: () => ({
        cursor: () => ({
          stream: (handlers: typeof capturedHandlers) => {
            capturedHandlers = handlers;
            return capturedCloseStream;
          },
        }),
      }),
    };
  }

  return {
    ...actual,
    Horizon: { ...actual.Horizon, Server: MockHorizonServer },
  };
});

import { LedgerSubscriberProvider, useLedgerTick } from '@/contexts/ledger-subscriber';

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(LedgerSubscriberProvider, null, children);
}

describe('useLedgerTick', () => {
  beforeEach(() => {
    capturedHandlers = {};
    capturedCloseStream = vi.fn();
  });

  afterEach(() => vi.clearAllMocks());

  it('starts at tick=0 and latestLedger=0', () => {
    const { result } = renderHook(useLedgerTick, { wrapper });
    expect(result.current.tick).toBe(0);
    expect(result.current.latestLedger).toBe(0);
  });

  it('increments tick on each ledger close message', async () => {
    const { result } = renderHook(useLedgerTick, { wrapper });

    await act(async () => {
      capturedHandlers.onmessage?.({ sequence: 12345 });
    });
    expect(result.current.tick).toBe(1);

    await act(async () => {
      capturedHandlers.onmessage?.({ sequence: 12346 });
    });
    expect(result.current.tick).toBe(2);
  });

  it('updates latestLedger to the sequence from the message', async () => {
    const { result } = renderHook(useLedgerTick, { wrapper });

    await act(async () => {
      capturedHandlers.onmessage?.({ sequence: 55555 });
    });
    expect(result.current.latestLedger).toBe(55555);
  });

  it('calls the close function on unmount', () => {
    const { unmount } = renderHook(useLedgerTick, { wrapper });
    unmount();
    expect(capturedCloseStream).toHaveBeenCalledOnce();
  });

  it('does not throw when onerror is called', async () => {
    renderHook(useLedgerTick, { wrapper });

    await act(async () => {
      expect(() => capturedHandlers.onerror?.(new Error('SSE error'))).not.toThrow();
    });
  });
});
