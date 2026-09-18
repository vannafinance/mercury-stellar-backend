/**
 * Compress a paste/drop/canvas screenshot into an Assistant image attachment.
 * Bounds match `lib/assistant/packet.ts` — the Guide only looks; it never signs.
 */

import type { AssistantImageAttachment, AssistantImageMime } from "@/lib/copilot/types";
import { ALLOWED_IMAGE_MIMES, MAX_IMAGE_B64_CHARS } from "@/lib/assistant/packet";

export const MAX_IMAGE_EDGE = 1024;
export const JPEG_QUALITY = 0.72;

export function isAllowedImageMime(mime: string): mime is AssistantImageMime {
  return (ALLOWED_IMAGE_MIMES as readonly string[]).includes(mime);
}

/** Strip a `data:image/...;base64,` prefix. Raw base64 with no prefix is rejected. */
export function stripDataUrlPrefix(dataUrl: string): { mime: string; data: string } | null {
  if (!dataUrl) return null;
  const match = dataUrl.trim().match(/^data:([^;,]+)(?:;charset=[^;,]+)?;base64,([\s\S]+)$/i);
  if (!match) return null;
  const mime = match[1].trim().toLowerCase();
  const data = match[2].replace(/\s+/g, "");
  if (!data) return null;
  return { mime, data };
}

export function attachmentFitsBudget(data: string): boolean {
  return data.length > 0 && data.length <= MAX_IMAGE_B64_CHARS;
}

function scaleForEdge(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const longest = Math.max(w, h);
  if (longest <= maxEdge) return { width: Math.round(w), height: Math.round(h) };
  const scale = maxEdge / longest;
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

function canvasToAttachment(
  canvas: HTMLCanvasElement,
  source: AssistantImageAttachment["source"],
  mime: AssistantImageMime,
  quality: number,
): AssistantImageAttachment | null {
  const type = mime === "image/png" ? "image/png" : mime;
  const dataUrl =
    type === "image/png" ? canvas.toDataURL("image/png") : canvas.toDataURL(type, quality);
  const parsed = stripDataUrlPrefix(dataUrl);
  if (!parsed || !isAllowedImageMime(parsed.mime) || !attachmentFitsBudget(parsed.data)) {
    return null;
  }
  return {
    mime: parsed.mime,
    data: parsed.data,
    source,
    width: canvas.width,
    height: canvas.height,
  };
}

function shrinkUntilItFits(
  sourceCanvas: HTMLCanvasElement,
  source: AssistantImageAttachment["source"],
): AssistantImageAttachment | null {
  let width = sourceCanvas.width;
  let height = sourceCanvas.height;
  let quality = JPEG_QUALITY;
  for (let attempt = 0; attempt < 6; attempt++) {
    const sized = document.createElement("canvas");
    sized.width = Math.max(1, width);
    sized.height = Math.max(1, height);
    const ctx = sized.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(sourceCanvas, 0, 0, sized.width, sized.height);
    const att = canvasToAttachment(sized, source, "image/jpeg", quality);
    if (att) return att;
    width = Math.max(1, Math.round(width * 0.75));
    height = Math.max(1, Math.round(height * 0.75));
    quality = Math.max(0.45, quality - 0.1);
  }
  return null;
}

/**
 * Draw `canvas` into a JPEG/PNG attachment. Large images become JPEG at 0.72
 * with a longest edge of ~1024.
 */
export function compressCanvas(
  canvas: HTMLCanvasElement,
  source: AssistantImageAttachment["source"],
): AssistantImageAttachment | null {
  const { width, height } = scaleForEdge(canvas.width, canvas.height, MAX_IMAGE_EDGE);
  const large = canvas.width > MAX_IMAGE_EDGE || canvas.height > MAX_IMAGE_EDGE;
  const dest = document.createElement("canvas");
  dest.width = width;
  dest.height = height;
  const ctx = dest.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(canvas, 0, 0, width, height);

  // Region crops and oversized pastes become JPEG 0.72 so the POST stays under budget.
  if (large || source === "region") {
    return (
      canvasToAttachment(dest, source, "image/jpeg", JPEG_QUALITY) ??
      shrinkUntilItFits(dest, source)
    );
  }
  return (
    canvasToAttachment(dest, source, "image/png", 1) ?? shrinkUntilItFits(dest, source)
  );
}

async function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("image decode failed"));
      img.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Compress a File/Blob from paste or drop. Wrong mime → null (caller may toast).
 */
export async function compressImageFile(
  file: File | Blob,
  source: AssistantImageAttachment["source"],
): Promise<AssistantImageAttachment | null> {
  const mime = (file.type || "").toLowerCase();
  if (!isAllowedImageMime(mime)) return null;

  const img = await blobToImage(file);
  const naturalW = img.naturalWidth || img.width;
  const naturalH = img.naturalHeight || img.height;
  const { width, height } = scaleForEdge(naturalW, naturalH, MAX_IMAGE_EDGE);
  const large =
    naturalW > MAX_IMAGE_EDGE ||
    naturalH > MAX_IMAGE_EDGE ||
    (typeof file.size === "number" && file.size > 180_000);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, width, height);

  if (large || mime === "image/jpeg") {
    return (
      canvasToAttachment(canvas, source, "image/jpeg", JPEG_QUALITY) ??
      shrinkUntilItFits(canvas, source)
    );
  }
  if (mime === "image/webp") {
    return (
      canvasToAttachment(canvas, source, "image/webp", 0.8) ??
      canvasToAttachment(canvas, source, "image/jpeg", JPEG_QUALITY) ??
      shrinkUntilItFits(canvas, source)
    );
  }
  return (
    canvasToAttachment(canvas, source, "image/png", 1) ??
    canvasToAttachment(canvas, source, "image/jpeg", JPEG_QUALITY) ??
    shrinkUntilItFits(canvas, source)
  );
}
