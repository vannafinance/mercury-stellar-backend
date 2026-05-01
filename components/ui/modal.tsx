"use client";

import React, { ReactNode, useEffect } from "react";
import { createPortal } from "react-dom";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  bottomSheet?: boolean;
}

export const Modal = ({ open, onClose, children }: ModalProps) => {
  useEffect(() => {
    if (!open) return;

    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    document.addEventListener("keydown", handleEsc);
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", handleEsc);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-1000 flex items-center justify-center">
      {/* Overlay */}
      <div
        className="absolute inset-0 bg-black/30  backdrop-blur-[15px]"
        onClick={onClose}
      />

      {/* Content */}
      <div className="relative z-1001 w-full max-w-[90vw] px-4 sm:px-0 sm:max-w-max">{children}</div>
    </div>,
    document.body
  );
};
