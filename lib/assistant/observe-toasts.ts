/**
 * Record error toasts as Assistant session events without touching every caller.
 * Mount once from the Assistant launcher.
 */

import toast from "react-hot-toast";
import { recordToastError } from "@/store/assistant-events";

let patched = false;
const originalError = toast.error.bind(toast);

export function observeAssistantToasts(): () => void {
  if (patched) return () => undefined;
  patched = true;
  toast.error = ((message: Parameters<typeof toast.error>[0], opts?: Parameters<typeof toast.error>[1]) => {
    const text =
      typeof message === "string"
        ? message
        : message != null
          ? String(message)
          : "";
    if (text) recordToastError(text);
    return originalError(message, opts);
  }) as typeof toast.error;
  return () => {
    toast.error = originalError;
    patched = false;
  };
}
