'use client';

import { useEffect, useRef } from 'react';
import type { UseMutationResult } from '@tanstack/react-query';
import toast from 'react-hot-toast';

type ToastableMutation<TData, TError extends Error, TVar> = Pick<
  UseMutationResult<TData, TError, TVar>,
  'isPending' | 'isSuccess' | 'isError' | 'data' | 'error' | 'variables'
>;

/**
 * Declarative toast side-effect for a TanStack Query mutation.
 *
 * Place next to the mutation in the component body — it watches status flags
 * and fires react-hot-toast on transition. Supports an optional loading toast
 * that is updated in-place when the mutation completes.
 *
 *   const deposit = useDeposit();
 *   useMutationToast(deposit, {
 *     loading: (v) => `Depositing ${v.amount} ${v.assetType}…`,
 *     success: (d) => `Deposited ${d.amount} ${d.assetType}!`,
 *     error:   (e) => e.message,
 *   });
 */
export function useMutationToast<TData, TError extends Error, TVar>(
  mutation: ToastableMutation<TData, TError, TVar>,
  opts: {
    loading?: string | ((variables: TVar) => string);
    success: string | ((data: TData) => string);
    error?: string | ((err: TError) => string);
  },
): void {
  // Keep opts in a ref so the effect never needs them as deps
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const toastIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const o = optsRef.current;

    if (mutation.isPending) {
      if (!o.loading) return;
      const msg =
        typeof o.loading === 'function'
          ? o.loading(mutation.variables as TVar)
          : o.loading;
      toastIdRef.current = toast.loading(msg);
      return;
    }

    if (mutation.isSuccess) {
      const msg =
        typeof o.success === 'function' ? o.success(mutation.data!) : o.success;
      if (toastIdRef.current) {
        toast.success(msg, { id: toastIdRef.current });
        toastIdRef.current = undefined;
      } else {
        toast.success(msg);
      }
      return;
    }

    if (mutation.isError && mutation.error) {
      const errFn = o.error ?? ((e: TError) => e.message);
      const msg = typeof errFn === 'function' ? errFn(mutation.error) : errFn;
      if (toastIdRef.current) {
        toast.error(msg, { id: toastIdRef.current });
        toastIdRef.current = undefined;
      } else {
        toast.error(msg);
      }
    }
    // optsRef.current intentionally omitted — always current via ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mutation.isPending, mutation.isSuccess, mutation.isError, mutation.data, mutation.error, mutation.variables]);
}
