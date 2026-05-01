import { iconPaths } from "@/lib/constants";
import Image from "next/image";
import { Button } from "./button";
import { motion } from "framer-motion";
import { useTheme } from "@/contexts/theme-context";

interface AmountBreakdownDialogueProps {
  heading: string;
  asset: string;
  totalDeposit: number;
  breakdown: {
    name: string;
    value: number;
  }[];
  onClose?: () => void;
}

export const AmountBreakdownDialogue = (
  props: AmountBreakdownDialogueProps
) => {
  const { isDark } = useTheme();
  
  return (
    <motion.div
      className={`flex flex-col w-[360px] max-w-[92vw] max-h-[calc(100vh-160px)] rounded-[18px] relative overflow-hidden ${
        isDark ? "bg-[#111111]" : "bg-white"
      }`}
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
    >
      {/* Header — stays pinned when body scrolls */}
      <div className="flex flex-col gap-[10px] px-[16px] pt-[16px] pb-[10px]">
        <motion.div
          className={`text-[16px] font-semibold text-center ${
            isDark ? "text-white" : ""
          }`}
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.1 }}
        >
          {props.heading}
        </motion.div>

        <motion.div
          className={`flex justify-between items-center ${
            isDark ? "text-white" : ""
          }`}
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.3, delay: 0.15 }}
        >
          <div className="text-[13px] font-medium flex gap-[6px] items-center">
            <Image
              src={iconPaths[props.asset]}
              alt={props.asset}
              width={18}
              height={18}
            />
            {props.asset}
          </div>
          <div className="text-[13px] font-medium">
            {props.totalDeposit} {props.asset}
          </div>
        </motion.div>
      </div>

      {/* Body — scrolls when list is taller than remaining space */}
      <div className="flex flex-col gap-[4px] px-[16px] pb-[12px] overflow-y-auto min-h-0 scrollbar-hide">
        <motion.div
          className={`rounded-[10px] py-[8px] px-[10px] text-[12px] font-medium ${
            isDark ? " text-[#919191]" : "bg-[#F6F6F6] text-[#131313A1]"
          }`}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.2 }}
        >
          Across {props.breakdown.length} Chains
        </motion.div>
        {props.breakdown.map((item, idx) => {
          return (
            <motion.div
              key={idx}
              className={`flex justify-between items-center py-[10px] px-[10px] rounded-[10px] ${
                isDark ? "bg-[#222222] text-white" : "bg-[#FBFBFB]"
              }`}
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.3, delay: 0.25 + idx * 0.05 }}
              whileHover={{
                backgroundColor: isDark ? "#2A2A2A" : "#F0F0F0",
              }}
            >
              <div className="flex gap-[6px] items-center text-[12px]">
                <Image
                  className="rounded-full"
                  src={iconPaths[item.name.toUpperCase()]}
                  alt={item.name}
                  width={18}
                  height={18}
                />
                {item.name}
              </div>
              <div className="text-[12px] font-medium">
                {item.value} {props.asset}
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* Footer — stays pinned */}
      <motion.div
        className="px-[16px] pt-[8px] pb-[14px]"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{
          duration: 0.3,
          delay: 0.4 + props.breakdown.length * 0.05,
        }}
      >
        <Button
          type="ghost"
          text="Close"
          size="small"
          onClick={props.onClose || (() => {})}
          disabled={false}
        />
      </motion.div>
    </motion.div>
  );
};
