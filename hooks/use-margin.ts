'use client';
import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMarginAccountInfoStore } from '@/store/margin-account-info-store';
import { MarginAccountService } from '@/lib/margin-utils';
import { getMarginHistoryByAccount } from '@/lib/margin-history';
import { useLedgerTick } from '@/contexts/ledger-subscriber';

export const useMarginHistory = () => {
  const marginAccountAddress = useMarginAccountInfoStore((s) => s.marginAccountAddress);
  const qc = useQueryClient();
  const { tick } = useLedgerTick();
  const lastTickRef = useRef(tick);

  const query = useQuery({
    queryKey: ['margin', 'history', marginAccountAddress ?? null],
    enabled: Boolean(marginAccountAddress),
    queryFn: async () => {
      if (!marginAccountAddress) return [];
      return MarginAccountService.getMarginTransactionHistory(marginAccountAddress);
    },
    staleTime: 4_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (tick === lastTickRef.current) return;
    lastTickRef.current = tick;
    qc.invalidateQueries({ queryKey: ['margin', 'history'] });
  }, [tick, qc]);

  const onchainHistory = query.data ?? [];
  const localHistory = getMarginHistoryByAccount(marginAccountAddress);
  const onchainHashes = new Set(onchainHistory.map((item) => item.hash).filter(Boolean));
  const mergedHistory = [
    ...onchainHistory,
    ...localHistory.filter((item) => !item.hash || !onchainHashes.has(item.hash)),
  ].sort((a, b) => b.timestamp - a.timestamp);

  return {
    history: mergedHistory,
    isLoading: query.isLoading,
    isRefreshing: query.isFetching && !query.isLoading,
  };
};
