"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAppModeStore } from "@/store/app-mode-store";

type PersistApi = {
  hasHydrated: () => boolean;
  onFinishHydration: (cb: () => void) => () => void;
};

function getPersistApi(): PersistApi | null {
  const api = (useAppModeStore as unknown as { persist?: PersistApi }).persist;
  return api ?? null;
}

/**
 * Blocks a page from rendering in lite mode. Returns true until zustand-persist has
 * hydrated, so pro-only pages never paint their content while appMode is still at
 * the default "pro" before the persisted "lite" value is restored from storage.
 * Once hydrated and confirmed lite, redirects to "/".
 */
export function useLiteModeGuard(): boolean {
  const router = useRouter();
  const appMode = useAppModeStore((s) => s.mode);
  const [hydrated, setHydrated] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return getPersistApi()?.hasHydrated() ?? true;
  });

  useEffect(() => {
    if (hydrated) return;
    const persist = getPersistApi();
    if (!persist) {
      setHydrated(true);
      return;
    }
    if (persist.hasHydrated()) {
      setHydrated(true);
      return;
    }
    const unsub = persist.onFinishHydration(() => setHydrated(true));
    return unsub;
  }, [hydrated]);

  useEffect(() => {
    if (hydrated && appMode === "lite") {
      router.replace("/");
    }
  }, [hydrated, appMode, router]);

  return !hydrated || appMode === "lite";
}
