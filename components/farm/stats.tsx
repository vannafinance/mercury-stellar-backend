import { ProgressBar } from "../ui/progress-bar";
import { useTheme } from "@/contexts/theme-context";
import { TrendUpIcon, TrendDownIcon } from "@/components/icons";
import { motion } from "framer-motion";

interface FarmStatsCardProps {
    items:{
        heading:string;
        value:string;
        downtrend?:string;
        uptrend?:string;
        progressBar?:{
            percentage:number;
            value:string;
        }
    }[]
}

export const FarmStatsCard = ({items}:FarmStatsCardProps) =>{
    const { isDark } = useTheme();

    // Split: first 2 as highlight cards, rest as compact rows
    const highlights = items.slice(0, 2);
    const details = items.slice(2);

    return (
        <motion.div
            className="w-full h-fit flex flex-col gap-2"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.4, ease: "easeOut" }}
        >
            {/* Top highlight grid */}
            <div className="grid grid-cols-2 gap-2">
                {highlights.map((item, idx) => (
                    <motion.div
                        key={idx}
                        className={`rounded-xl border p-3 flex flex-col gap-1 ${
                            isDark ? "bg-[#1A1A1A] border-[#2A2A2A]" : "bg-[#F7F7F7] border-[#E8E8E8]"
                        }`}
                        initial={{ opacity: 0, y: 10 }}
                        whileInView={{ opacity: 1, y: 0 }}
                        viewport={{ once: true }}
                        transition={{ duration: 0.3, delay: idx * 0.05 }}
                    >
                        <span className={`text-[12px] font-medium ${isDark ? "text-[#888888]" : "text-[#777777]"}`}>
                            {item.heading}
                        </span>
                        <span className={`text-[20px] font-bold leading-tight ${isDark ? "text-white" : "text-[#111111]"}`}>
                            {item.value}
                        </span>
                        {item.uptrend && (
                            <span className="flex items-center gap-0.5 mt-0.5">
                                <TrendUpIcon width={12} height={12} />
                                <span className="text-[11px] font-semibold text-green-500">{item.uptrend}</span>
                            </span>
                        )}
                        {item.downtrend && (
                            <span className="flex items-center gap-0.5 mt-0.5">
                                <TrendDownIcon width={12} height={12} />
                                <span className="text-[11px] font-semibold text-red-500">{item.downtrend}</span>
                            </span>
                        )}
                    </motion.div>
                ))}
            </div>

            {/* Detail rows */}
            <div className={`rounded-xl border overflow-hidden ${
                isDark ? "bg-[#1A1A1A] border-[#2A2A2A]" : "bg-[#F7F7F7] border-[#E8E8E8]"
            }`}>
                {details.map((item, idx) => (
                    <motion.div
                        key={idx}
                        className={`flex items-center justify-between px-3.5 py-2.5 ${
                            idx % 2 === 0
                                ? isDark ? "bg-[#1A1A1A]" : "bg-[#F7F7F7]"
                                : isDark ? "bg-[#161616]" : "bg-[#F2F2F2]"
                        }`}
                        initial={{ opacity: 0, x: -8 }}
                        whileInView={{ opacity: 1, x: 0 }}
                        viewport={{ once: true }}
                        transition={{ duration: 0.25, delay: (idx + 2) * 0.04 }}
                    >
                        <span className={`text-[12px] font-medium ${isDark ? "text-[#888888]" : "text-[#555555]"}`}>
                            {item.heading}
                        </span>

                        {item.progressBar ? (
                            <div className="w-[100px]">
                                <ProgressBar
                                    height={20}
                                    progressColor="#703AE6"
                                    backgroundColor={isDark ? "#333333" : "#E0E0E0"}
                                    showPercentage={true}
                                    percentage={item.progressBar.percentage}
                                    value={item.progressBar.value}
                                    textSize="10px"
                                />
                            </div>
                        ) : (
                            <div className="flex items-center gap-1.5">
                                <span className={`text-[14px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>
                                    {item.value}
                                </span>
                                {item.downtrend && (
                                    <span className="flex items-center gap-0.5">
                                        <TrendDownIcon width={12} height={12} />
                                        <span className="text-[10px] font-semibold text-red-500">{item.downtrend}</span>
                                    </span>
                                )}
                                {!item.downtrend && item.uptrend && (
                                    <span className="flex items-center gap-0.5">
                                        <TrendUpIcon width={12} height={12} />
                                        <span className="text-[10px] font-semibold text-green-500">{item.uptrend}</span>
                                    </span>
                                )}
                            </div>
                        )}
                    </motion.div>
                ))}
            </div>
        </motion.div>
    );
}
