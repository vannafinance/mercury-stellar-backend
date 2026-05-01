"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useState } from "react";
import { FIELD_FORMAT_MAP, LARGE_FORMAT_FIELDS } from "@/lib/constants/margin";
import { formatValue, FormatType } from "@/lib/utils/format-value";
import { useTheme } from "@/contexts/theme-context";

interface InfoItem {
  id: string;
  name: string;
}

interface ExpandableSection {
  title: string;
  headingBold?: boolean;
  items?: readonly InfoItem[];
  defaultExpanded?: boolean;
  delay?: number;
}

interface InfoProps {
  data: {
    [key: string]: number | string | null | undefined;
  };
  items?: readonly InfoItem[];
  expandableSections?: readonly ExpandableSection[];
  showExpandable?: boolean;
}

// Format value using the format helper - defined outside component
const formatFieldValue = (
  id: string,
  value: number | string | null | undefined,
): string => {
  // If value is already a string, return it directly
  if (typeof value === "string") {
    return value;
  }

  const formatType = FIELD_FORMAT_MAP[id] as FormatType | undefined;

  if (!formatType) {
    // Fallback to default number formatting
    return formatValue(value, { type: "number" });
  }

  // Determine if large format should be used
  const useLargeFormat = LARGE_FORMAT_FIELDS.includes(id as any);

  return formatValue(value, {
    type: formatType,
    useLargeFormat,
  });
};

export const InfoCard = ({
  data,
  items,
  expandableSections = [],
  showExpandable = false,
}: InfoProps) => {
  const { isDark } = useTheme();

  // Track expanded state for each section
  const [expandedStates, setExpandedStates] = useState<Record<string, boolean>>(
    expandableSections.reduce(
      (acc, section) => ({
        ...acc,
        [section.title]: section.defaultExpanded ?? false,
      }),
      {},
    ),
  );

  const toggleExpanded = (title: string) => {
    setExpandedStates((prev) => ({ ...prev, [title]: !prev[title] }));
  };

  const cardClass = `flex flex-col w-full border rounded-xl overflow-hidden ${
    isDark ? "bg-[#222222] border-[#333333]" : "bg-[#F7F7F7] border-[#E5E7EB]"
  }`;
  const rowClass = `flex justify-between items-center px-4 py-2.5 ${
    isDark ? "text-white border-[#333333]" : "border-[#F0F0F0]"
  }`;
  const dividerClass = `border-t ${isDark ? "border-[#333333]" : "border-[#F0F0F0]"}`;

  // Render a single info item row
  const renderItem = (item: InfoItem, idx: number, useAnimate = false) => (
    <motion.div
      key={item.id}
      className={rowClass}
      initial={{ opacity: 0, x: -10 }}
      {...(useAnimate
        ? {
            animate: { opacity: 1, x: 0 },
            transition: { duration: 0.3, delay: idx * 0.05 },
          }
        : {
            whileInView: { opacity: 1, x: 0 },
            viewport: { once: true },
            transition: { duration: 0.3, delay: idx * 0.05 },
          })}
    >
      <div
        className={`text-[13px] font-medium ${isDark ? "" : "text-[#6B7280]"}`}
      >
        {item.name}
      </div>
      <div
        className={`text-sm font-semibold shrink-0 ${
          isDark ? "text-white" : "text-[#111111]"
        }`}
      >
        {formatFieldValue(item.id, data[item.id])}
      </div>
    </motion.div>
  );

  return (
    <>
      {/* Main info items card */}
      {items && items.length > 0 && (
        <motion.article
          className={cardClass}
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.4, ease: "easeOut" }}
        >
          {items.map((item, idx) => renderItem(item, idx))}
        </motion.article>
      )}

      {/* Expandable section cards */}
      {showExpandable &&
        expandableSections.map((section, sectionIdx) => (
          <motion.article
            key={section.title}
            className={cardClass}
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{
              duration: 0.4,
              delay: section.delay || (sectionIdx + 1) * 0.1,
              ease: "easeOut",
            }}
          >
            {/* Section toggle header */}
            <motion.button
              type="button"
              onClick={() => toggleExpanded(section.title)}
              className={`flex justify-between items-center px-4 py-3 text-[13px] ${
                section.headingBold ? "font-bold" : "font-medium"
              } cursor-pointer w-full ${
                isDark ? "text-white" : "text-[#111111]"
              }`}
              whileTap={{ scale: 0.98 }}
              aria-expanded={expandedStates[section.title]}
              aria-controls={`section-${section.title}`}
              aria-label={`${
                expandedStates[section.title] ? "Collapse" : "Expand"
              } ${section.title}`}
            >
              {section.title}
              <motion.svg
                width="12"
                height="7"
                viewBox="0 0 13 8"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
                animate={{ rotate: expandedStates[section.title] ? 180 : 0 }}
                transition={{ duration: 0.3 }}
              >
                <path
                  d="M11.91 8.38201e-05L12.97 1.06108L7.193 6.84008C7.10043 6.93324 6.99036 7.00717 6.8691 7.05761C6.74785 7.10806 6.61783 7.13403 6.4865 7.13403C6.35517 7.13403 6.22514 7.10806 6.10389 7.05761C5.98264 7.00717 5.87257 6.93324 5.78 6.84008L0 1.06108L1.06 0.00108375L6.485 5.42508L11.91 8.38201e-05Z"
                  fill={isDark ? "#FFFFFF" : "#6B7280"}
                />
              </motion.svg>
            </motion.button>

            {/* Expandable rows */}
            <AnimatePresence>
              {expandedStates[section.title] && (
                <motion.section
                  id={`section-${section.title}`}
                  className={`flex flex-col ${dividerClass}`}
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.3 }}
                  role="region"
                  aria-labelledby={`section-header-${section.title}`}
                >
                  {section.items?.map((item, idx) =>
                    renderItem(item, idx, true),
                  )}
                </motion.section>
              )}
            </AnimatePresence>
          </motion.article>
        ))}
    </>
  );
};
