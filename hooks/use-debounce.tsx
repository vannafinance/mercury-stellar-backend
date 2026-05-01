import { useCallback, useEffect, useRef } from "react";

/**
 * Custom hook to debounce a function call
 *
 * @template T - Function type to debounce
 * @param fn - The function to debounce
 * @param delay - Delay in milliseconds (must be >= 0)
 * @returns Debounced function with the same signature as the input function
 *
 * @example
 * ```tsx
 * const handleSearch = useDebounce((searchTerm: string) => {
 *   console.log('Searching for:', searchTerm);
 * }, 300);
 *
 * // Call it - will only execute after 300ms of no calls
 * handleSearch('react');
 * ```
 *
 * @remarks
 * - The debounced function will only execute after the specified delay
 * - If called multiple times within the delay period, only the last call will execute
 * - The function reference is stable and won't change unless delay changes
 * - Automatically cleans up timers on unmount or when delay changes
 */
export function useDebounce<T extends (...args: any[]) => any>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const fnRef = useRef(fn);

  // Validate delay
  if (delay < 0) {
    console.warn(
      `useDebounce: delay must be >= 0, got ${delay}. Using 0 instead.`
    );
    delay = 0;
  }

  // Keep the latest function reference without triggering re-creation
  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  // Cleanup timer on unmount or when delay changes
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [delay]);

  // Memoized debounced function
  return useCallback(
    (...args: Parameters<T>) => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }

      timerRef.current = setTimeout(() => {
        fnRef.current(...args);
        timerRef.current = null;
      }, delay);
    },
    [delay]
  );
}
