"use client";

import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Image from "next/image";
import { useTheme } from "@/contexts/theme-context";

interface ExpandableModalProps {
  /**
   * The content to be displayed in both normal and expanded view
   */
  children: React.ReactNode;
  /**
   * Custom className for the expand button
   */
  buttonClassName?: string;
  /**
   * Custom className for the modal container
   */
  modalClassName?: string;
  /**
   * Custom icon for expand button (optional)
   */
  expandIcon?: string;
  /**
   * Show expand button (default: true)
   */
  showButton?: boolean;
  /**
   * Custom header content for the modal (optional)
   */
  modalHeader?: React.ReactNode;
  /**
   * Enable scrolling for modal content (default: true)
   */
  scrollable?: boolean;
  /**
   * Position of content: "top" or "bottom" (default: "top")
   * When scrollable is true and position is "bottom", scroll starts from bottom
   */
  contentPosition?: "top" | "bottom";
}

export const ExpandableModal = ({
  children,
  buttonClassName = "mt-[6px] cursor-pointer flex items-center justify-center w-[32px] h-[32px] rounded-[8px] text-black bg-white border-[1px]",
  modalClassName = "",
  expandIcon = "/icons/expand-icon.png",
  showButton = true,
  modalHeader,
  scrollable = true,
  contentPosition = "top",
}: ExpandableModalProps) => {
  const { isDark } = useTheme();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom when modal opens and contentPosition is "bottom"
  useEffect(() => {
    if (
      isModalOpen &&
      contentPosition === "bottom" &&
      scrollable &&
      contentRef.current
    ) {
      // Small delay to ensure content is rendered
      setTimeout(() => {
        if (contentRef.current) {
          contentRef.current.scrollTop = contentRef.current.scrollHeight;
        }
      }, 100);
    }
  }, [isModalOpen, contentPosition, scrollable]);

  return (
    <>
      {showButton && (
        <div
          onClick={() => setIsModalOpen(true)}
          className={buttonClassName}
        >
          <Image
            src={expandIcon}
            alt="expand-icon"
            width={12}
            height={12}
          />
        </div>
      )}

      {/* Expanded Modal */}
      <AnimatePresence>
        {isModalOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm"
            onClick={() => setIsModalOpen(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.2 }}
              className={`relative w-[90vw] max-w-[1200px] h-[85vh] max-h-[800px] rounded-[20px] p-[24px] shadow-2xl flex flex-col overflow-hidden ${
                isDark ? "bg-[#222222]" : "bg-white"
              } ${modalClassName}`}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Close Button */}
              <button
                onClick={() => setIsModalOpen(false)}
                className={`absolute mt-[6px] top-[24px] right-[24px] z-[100] w-[32px] h-[32px] flex items-center justify-center rounded-[8px] border-[1px] transition-colors ${
                  isDark
                    ? "bg-[#222222] hover:bg-[#333333]"
                    : "bg-white hover:bg-gray-50"
                }`}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    d="M12 4L4 12M4 4L12 12"
                    stroke={isDark ? "#FFFFFF" : "#19191A"}
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>

              {/* Modal Header (Optional) */}
              {modalHeader && (
                <div className="w-full h-fit mb-[24px] pr-[40px]">
                  {modalHeader}
                </div>
              )}

              {/* Expanded Content */}
              <div
                ref={contentRef}
                className={`w-full flex-1 min-h-0 ${
                  scrollable ? "overflow-auto" : "overflow-hidden"
                }`}
              >
                {children}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};

