"use client";

import Image from "next/image";
import { useEffect, useState, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { EducationIcon } from "@/components/icons";

interface Carousel {
  items: {
    icon: string;
    title: string;
    description: string;
  }[];
  autoplayInterval?: number; // in milliseconds, default 5000
}

export const Carousel = (props: Carousel) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const autoplayInterval = props.autoplayInterval || 3000;
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  // Simplified autoplay logic
  const nextSlide = useCallback(() => {
    setCurrentIndex((prev) => (prev === props.items.length - 1 ? 0 : prev + 1));
  }, [props.items.length]);

  const startAutoplay = useCallback(() => {
    stopAutoplay();
    intervalRef.current = setInterval(nextSlide, autoplayInterval);
  }, [nextSlide, autoplayInterval]);

  const stopAutoplay = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    startAutoplay();
    return stopAutoplay;
  }, [startAutoplay, stopAutoplay]);

  const currentItem = props.items[currentIndex];

  return (
    <div
      className="flex flex-col justify-center items-center shadow-md relative w-full h-auto min-h-[120px] sm:h-[150px] rounded-[16px] bg-[#7B44E1D1] overflow-hidden py-4 sm:py-4 px-5 sm:px-[40px]"
      onMouseEnter={stopAutoplay}
      onMouseLeave={startAutoplay}
    >
      <Image
        width={1280}
        height={240}
        alt="Collateral Loan"
        src={"/assets/background.jpg"}
        className="absolute inset-0 w-full h-full opacity-18 object-cover"
      />
      <div
        className="relative z-10 w-full h-fit flex flex-col sm:flex-row items-start sm:items-center gap-4 sm:gap-5"
        role="region"
        aria-label="Carousel"
        aria-live="polite"
      >
        <div className="w-full sm:w-auto shrink-0 h-fit flex items-center gap-4 sm:gap-[24px]">
          <div className="w-10 h-10 sm:w-13 sm:h-13 p-1.5 sm:p-2 bg-[#F4F4F4] rounded-full flex flex-col justify-center items-center shrink-0">
            <EducationIcon />
          </div>

          <AnimatePresence mode="wait">
            <motion.div
              key={currentIndex}
              className="text-white font-bold text-[17px] sm:text-[18px] lg:text-[21px] w-full sm:w-[180px] lg:w-[204px]"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              transition={{ duration: 0.4, ease: "easeInOut" }}
            >
              {currentItem.title}
            </motion.div>
          </AnimatePresence>
        </div>

        <div className="hidden sm:block w-px shrink-0 h-13 bg-white/40" />

        <AnimatePresence mode="wait">
          <motion.div
            key={currentIndex}
            className="text-[12px] sm:text-[12px] lg:text-[14px] text-white/90 sm:text-white font-medium sm:font-semibold w-full sm:flex-1 sm:min-w-0 pb-2 sm:pb-0"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.4, ease: "easeInOut" }}
          >
            {currentItem.description}
          </motion.div>
        </AnimatePresence>
      </div>
      {/* Carousel indicators */}
      <div
        className="absolute bottom-3 sm:bottom-4 left-1/2 transform -translate-x-1/2 flex gap-2"
        role="tablist"
        aria-label="Carousel navigation"
      >
        {props.items.map((item, index) => (
          <button
            key={index}
            type="button"
            onClick={() => setCurrentIndex(index)}
            className={`w-1.5 h-1.5 rounded-full transition-all cursor-pointer ${
              index === currentIndex ? "bg-white w-5" : "bg-white/50"
            }`}
            aria-label={`Go to slide ${index + 1}: ${item.title}`}
            aria-selected={index === currentIndex}
            role="tab"
          />
        ))}
      </div>
    </div>
  );
};
