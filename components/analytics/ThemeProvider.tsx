"use client";

import { useEffect } from "react";
import { useThemeStore } from "@/lib/analytics/theme";

export default function ThemeProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const setTheme = useThemeStore((s) => s.setTheme);

  useEffect(() => {
    const sync = () => {
      const isDark = document.documentElement.classList.contains("dark");
      const theme = isDark ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", theme);
      setTheme(theme);
    };

    sync();

    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => observer.disconnect();
  }, [setTheme]);

  return <>{children}</>;
}
