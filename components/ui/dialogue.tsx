import { Button } from "./button";
import { Checkbox } from "./Checkbox";
import { useState } from "react";
import { motion } from "framer-motion";
import { useTheme } from "@/contexts/theme-context";
import { useViewportScale } from "@/lib/hooks/useViewportScale";

interface Dialogue {
  description?: string;
  heading: string;
  content: {
    line: string;
    points?: string[];
  }[];
  checkboxContent?: string;
  buttonText: string;
  onClose?: () => void;
  onOpen?: () => void;
  buttonOnClick: () => void;
  onCheckboxChange?: (checked: boolean) => void;
}

export const Dialogue = (props: Dialogue) => {
  const { isDark } = useTheme();
  const [isChecked, setIsChecked] = useState(false);
  const zoom = useViewportScale(1440);

  return (
    <motion.div
      className={`shadow-md flex flex-col w-full rounded-[18px] overflow-hidden ${
        isDark ? "bg-[#111111]" : "bg-[#F7F7F7]"
      }`}
      style={{ maxHeight: `calc(100vh / ${zoom} - 160px)` }}
      initial={{ opacity: 0, scale: 0.95, y: 20 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
    >
      {/* Header — pinned */}
      <div className="px-[18px] pt-[18px] pb-[10px] flex-shrink-0">
        <motion.div
          className={`text-[17px] font-bold text-center ${
            isDark ? "text-white" : ""
          }`}
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.1 }}
        >
          {props.heading}
        </motion.div>
      </div>

      {/* Scrollable body — description + list */}
      <div
        className={`flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-[18px] scrollbar-hide ${
          isDark ? "text-white" : "text-[#333333]"
        }`}
      >
        {props.description && (
          <motion.div
            className={`text-[13px] font-medium mb-[10px] ${
              isDark ? "text-white" : "text-[#333333]"
            }`}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.15 }}
          >
            {props.description}
          </motion.div>
        )}
        <ol className="list-decimal list-outside pl-5 space-y-2">
          {props.content.map((item, idx) => {
            return (
              <motion.li
                className="text-[13px] font-medium"
                key={idx}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.3, delay: 0.2 + idx * 0.05 }}
              >
                {item.line}
                {item.points && item.points.length > 0 && (
                  <ul className="list-[lower-alpha] list-outside pl-4 mt-1 space-y-1">
                    {item.points.map((point, pointIdx) => (
                      <motion.li
                        key={pointIdx}
                        className="text-[13px] font-medium"
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{
                          duration: 0.2,
                          delay: 0.25 + idx * 0.05 + pointIdx * 0.03,
                        }}
                      >
                        {point}
                      </motion.li>
                    ))}
                  </ul>
                )}
              </motion.li>
            );
          })}
        </ol>
      </div>

      {/* Footer — pinned: checkbox + buttons */}
      <div className="px-[18px] pt-[10px] pb-[14px] flex-shrink-0 flex flex-col gap-[10px]">
        {props.checkboxContent && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              duration: 0.3,
              delay: 0.3 + props.content.length * 0.05,
            }}
          >
            <Checkbox
              label={props.checkboxContent}
              checked={isChecked}
              onChange={(e) => {
                const checked = e.target.checked;
                setIsChecked(checked);
                props.onCheckboxChange?.(checked);
              }}
              className={`text-[13px] ${isDark ? "text-white" : "text-[#333333]"}`}
            />
          </motion.div>
        )}

        <motion.div
          className="flex flex-col gap-[8px]"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{
            duration: 0.3,
            delay: 0.35 + props.content.length * 0.05,
          }}
        >
          <Button
            type="solid"
            size="small"
            text={props.buttonText}
            disabled={props.checkboxContent ? !isChecked : false}
            onClick={props.buttonOnClick}
          />
          <Button
            type="ghost"
            disabled={false}
            text="Close"
            size="small"
            onClick={props.onClose || (() => {})}
          />
        </motion.div>
      </div>
    </motion.div>
  );
};
