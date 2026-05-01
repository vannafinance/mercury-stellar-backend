'use client';
import { useQuery } from '@tanstack/react-query';
import { useMarginAccountInfoStore } from '@/store/margin-account-info-store';
import { MarginAccountService } from '@/lib/margin-utils';
import { getMarginHistoryByAccount } from '@/lib/margin-history';

export const useMarginHistory = () => {
  const marginAccountAddress = useMarginAccountInfoStore((s) => s.marginAccountAddress);

  const query = useQuery({
    queryKey: ['margin', 'history', marginAccountAddress ?? null],
    enabled: Boolean(marginAccountAddress),
    queryFn: async () => {
      if (!marginAccountAddress) return [];
      return MarginAccountService.getMarginTransactionHistory(marginAccountAddress);
    },
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchInterval: marginAccountAddress ? 10_000 : false,
    refetchOnWindowFocus: true,
  });

  const onchainHistory = query.data ?? [];
  const localHistory = getMarginHistoryByAccount(marginAccountAddress);
  const onchainHashes = new Set(onchainHistory.map((item) => item.hash).filter(Boolean));
  const mergedHistory = [
    ...onchainHistory,
    ...localHistory.filter((item) => !item.hash || !onchainHashes.has(item.hash)),
  ].sort((a, b) => b.timestamp - a.timestamp);

  return {
    history: mergedHistory,
    isLoading: query.isLoading || query.isFetching,
  };
};
