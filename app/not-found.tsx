"use client";

import Image from "next/image";
import Link from "next/link";
import { motion } from "framer-motion";

// Branded 404 — "4 [floating Vanna logo as the 0] 4". Renders for any unknown
// route AND any page that calls notFound() (gated /stats). Uses the app's
// semantic palette so it adapts to the active light/dark theme.
export default function NotFound() {
  const digit = "clamp(6rem, 19vw, 11rem)";
  const orb = "clamp(6.5rem, 17vw, 10rem)";

  return (
    <div className="relative flex min-h-[78vh] flex-col items-center justify-center overflow-hidden bg-vgray-50 px-6 py-12 text-center">
      {/* 4 · Vanna logo (the 0) · 4 */}
      <div className="flex items-center justify-center gap-2 sm:gap-3">
        <span
          aria-hidden
          className="select-none font-black leading-none text-vgray-300"
          style={{ fontSize: digit }}
        >
          4
        </span>

        <motion.div
          animate={{ y: [0, -14, 0] }}
          transition={{ duration: 3.6, repeat: Infinity, ease: "easeInOut" }}
          className="relative shrink-0 rounded-full bg-surface shadow-xl ring-4 ring-imperial-500/25"
          style={{ width: orb, height: orb }}
        >
          <Image
            src="/logos/vanna-icon.png"
            alt="Vanna"
            fill
            sizes="160px"
            className="object-contain p-[18%]"
            priority
          />
        </motion.div>

        <span
          aria-hidden
          className="select-none font-black leading-none text-vgray-300"
          style={{ fontSize: digit }}
        >
          4
        </span>
      </div>

      <motion.h1
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="mt-8 text-4xl font-extrabold tracking-tight text-vgray-900"
      >
        Page Not Found
      </motion.h1>

      <motion.p
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.12 }}
        className="mt-3 max-w-sm text-sm leading-relaxed text-vgray-500"
      >
        Vanna looked everywhere but couldn’t find it. Maybe this page doesn’t exist.
      </motion.p>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.24 }}
        className="mt-7"
      >
        <Link href="/">
          <motion.span
            whileHover={{ scale: 1.04 }}
            whileTap={{ scale: 0.97 }}
            className="inline-block rounded-xl bg-imperial-500 px-7 py-3 text-sm font-semibold text-white shadow-lg shadow-imperial-500/25 transition-colors hover:bg-imperial-600"
          >
            Back to Home
          </motion.span>
        </Link>
      </motion.div>
    </div>
  );
}
