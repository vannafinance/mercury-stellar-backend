"use client";

import { useEffect, useCallback } from "react";
import { AnimatePresence, motion, useDragControls, PanInfo } from "framer-motion";
import { useTheme } from "@/contexts/theme-context";
import { CloseIcon } from "@/components/icons";

interface BottomSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  children: React.ReactNode;
}

export function BottomSheet({ open, onOpenChange, title, children }: BottomSheetProps) {
  const { isDark } = useTheme();
  const dragControls = useDragControls();

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onOpenChange(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  const handleDragEnd = useCallback(
    (_: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
      if (info.offset.y > 100 || info.velocity.y > 500) {
        onOpenChange(false);
      }
    },
    [onOpenChange],
  );

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[9999]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          {/* Backdrop */}
          <motion.div
            className="absolute inset-0 bg-black/50 backdrop-blur-[2px]"
            onClick={() => onOpenChange(false)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />

          {/* Sheet */}
          <motion.section
            role="dialog"
            aria-modal="true"
            aria-label={title || "Dialog"}
            className={`absolute inset-x-0 bottom-0 max-h-[85vh] rounded-t-[20px] shadow-2xl flex flex-col ${
              isDark
                ? "bg-[#1a1a1a] border-t border-[#333]"
                : "bg-white border-t border-[#E2E2E2]"
            }`}
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", stiffness: 340, damping: 36 }}
            drag="y"
            dragControls={dragControls}
            dragConstraints={{ top: 0 }}
            dragElastic={0.2}
            onDragEnd={handleDragEnd}
          >
            {/* Drag handle + header */}
            <div className="flex-shrink-0 pt-3 pb-2 px-4">
              <div
                className={`mx-auto mb-3 h-[5px] w-[40px] rounded-full ${
                  isDark ? "bg-white/20" : "bg-black/10"
                }`}
                aria-hidden="true"
              />
              <div className="flex items-center justify-between">
                {title && (
                  <h2
                    className={`text-[16px] font-semibold ${
                      isDark ? "text-white" : "text-[#111111]"
                    }`}
                  >
                    {title}
                  </h2>
                )}
                <button
                  type="button"
                  onClick={() => onOpenChange(false)}
                  aria-label="Close"
                  className={`ml-auto h-8 w-8 rounded-[10px] border flex items-center justify-center transition-colors ${
                    isDark
                      ? "border-white/10 bg-[#222] hover:bg-[#333]"
                      : "border-black/10 bg-white hover:bg-black/[0.03]"
                  }`}
                >
                  <CloseIcon stroke={isDark ? "#FFFFFF" : "#19191A"} />
                </button>
              </div>
            </div>

            {/* Scrollable content */}
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 pb-[max(20px,env(safe-area-inset-bottom))]">
              {children}
            </div>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
