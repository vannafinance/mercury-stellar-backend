"use client";

import { useState, useEffect } from "react";

/**
 * Returns a zoom factor that scales the UI proportionally on large screens.
 * Below `baseWidth`, returns 1 (no scaling).
 * Above `baseWidth`, returns viewport / baseWidth (e.g., 1920/1440 = 1.33).
 */
export function useViewportScale(baseWidth = 1440): number {
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    const update = () => {
      const vw = window.innerWidth;
      setZoom(vw > baseWidth ? vw / baseWidth : 1);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [baseWidth]);

  return zoom;
}
