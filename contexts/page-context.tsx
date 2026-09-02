"use client";

/**
 * Page-aware assistant context registry.
 *
 * Pages register a getter (not values in state) so metrics stay fresh at send
 * time without re-render loops between provider and page.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

export type PageMetric = {
  label: string;
  value: string | null;
  isPlaceholder?: boolean;
  glossaryKey?: string;
};

export type PageDescriptor = {
  route: string;
  title: string;
  purpose: string;
  metrics: PageMetric[];
  actions: string[];
};

type Ctx = {
  register: (get: () => PageDescriptor) => () => void;
  getPageContext: () => PageDescriptor | null;
};

const PageCtx = createContext<Ctx | null>(null);

export function PageContextProvider({ children }: { children: ReactNode }) {
  const stack = useRef<Array<() => PageDescriptor>>([]);

  const register = useCallback((get: () => PageDescriptor) => {
    stack.current.push(get);
    return () => {
      stack.current = stack.current.filter((g) => g !== get);
    };
  }, []);

  const getPageContext = useCallback(() => {
    const top = stack.current[stack.current.length - 1];
    if (!top) return null;
    try {
      const d = top();
      return { ...d, metrics: (d.metrics || []).slice(0, 10) };
    } catch {
      return null;
    }
  }, []);

  const value = useMemo(() => ({ register, getPageContext }), [register, getPageContext]);
  return <PageCtx.Provider value={value}>{children}</PageCtx.Provider>;
}

export function usePageContextApi(): Ctx {
  const ctx = useContext(PageCtx);
  if (!ctx) throw new Error("usePageContextApi must be used inside <PageContextProvider>");
  return ctx;
}

/** Register this page's assistant context (re-read at send time). */
export function useRegisterPage(get: () => PageDescriptor) {
  const { register } = usePageContextApi();
  const latest = useRef(get);
  latest.current = get;

  useEffect(() => register(() => latest.current()), [register]);
}
