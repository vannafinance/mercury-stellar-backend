"use client";

import Image from "next/image";
import { Button } from "../../ui/button";
import { useTheme } from "@/contexts/theme-context";

interface LimitBracketModalProps {
  onEdit?: () => void;
}

export const LimitBracketModal = ({ onEdit }: LimitBracketModalProps) => {
  const { isDark } = useTheme();
  return (
    <div className={`w-[740px] rounded-[20px] border px-5 py-6 flex flex-col gap-6 ${isDark ? "border-[#333333] bg-[#222222]" : "border-[#E2E2E2] bg-[#F7F7F7]"}`}>
      <h2 className={`text-[24px] leading-9 font-bold ${isDark ? "text-[#FFFFFF]" : "text-[#111111]"}`}>
        Limit Bracket
      </h2>

      <div className=" w-full flex items-center gap-2">
        <span className="rounded-sm bg-[#F1EBFD] px-3 py-1 text-[10px] leading-[15px] font-semiBold text-[#703AE6]">
          BUY
        </span>

        <div className="flex items-center gap-2">
          <span className={`text-[24px] font-bold leading-9 ${isDark ? "text-[#FFFFFF]" : "text-[#000000]"}`}>
            9279.04
          </span>

          <div className="flex flex-col gap-0.5">
            <span className={`text-[8px] leading-3 font-medium ${isDark ? "text-[#FFFFFF]" : "text-[#111111]"}`}>
              2025-10-23
            </span>
            <span className={`text-[12px] leading-[18px] font-semibold ${isDark ? "text-[#FFFFFF]" : "text-[#111111]"}`}>
              BTC/USDT
            </span>
          </div>
        </div>
      </div>

      <div className=" grid grid-cols-3 gap-10">
        <div className="flex flex-col gap-3">
          <div className={`text-[10px] leading-[15px] font-medium ${isDark ? "text-[#FFFFFF]" : "text-[#111111]"}`}>
            Total Value
          </div>
          <div className="flex flex-col gap-1">
            <div className={`font-semibold text-[16px] leading-6 ${isDark ? "text-[#FFFFFF]" : "text-[#111111]"}`}>
              99.993 USDT
            </div>
            <div className="text-[#A7A7A7] text-[12px] leading-[18px] font-semibold">
              ~99.99 USDT
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <div className={`text-[10px] leading-[15px] font-medium ${isDark ? "text-[#FFFFFF]" : "text-[#111111]"}`}>
            Gain
          </div>
          <div className="flex flex-col gap-1">
            <div className={`font-semibold text-[16px] leading-6 ${isDark ? "text-[#FFFFFF]" : "text-[#111111]"}`}>
              1.211 USDT
            </div>
            <div className="text-[#A7A7A7] text-[12px] leading-[18px] font-semibold">
              1.22%
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <div className={`text-[10px] leading-[15px] font-medium ${isDark ? "text-[#FFFFFF]" : "text-[#111111]"}`}>
            Risk
          </div>
          <div className="flex flex-col gap-1">
            <div className={`font-semibold text-[16px] leading-6 ${isDark ? "text-[#FFFFFF]" : "text-[#111111]"}`}>
              2.013 USDT
            </div>
            <div className="text-[#A7A7A7] text-[12px] leading-[18px] font-semibold">
              ~2.01 USDT
            </div>
          </div>
        </div>
      </div>

      <div className={`rounded-lg p-2 border flex flex-col gap-2 ${isDark ? "border-[#333333] bg-[#111111]" : "border-[#E2E2E2] bg-[#FFFFFF]"}`}>
        <div className={`grid grid-cols-6 border-b-2 text-[12px] leading-[18px] font-medium text-[#919191] ${isDark ? "border-b-[#333333]" : "border-b-[#E8E8E8]"}`}>
          <span className="px-2 py-1 rounded-sm">Order Type</span>
          <span className="px-2 py-1 rounded-sm">Price</span>
          <span className="px-2 py-1 rounded-sm">Units</span>
          <span className="px-2 py-1 rounded-sm">Fill%</span>
          <span className="px-2 py-1 rounded-sm">Time</span>
          <span className="px-2 py-1 rounded-sm">Status</span>
        </div>

        <div className="flex flex-col">
          <div className="grid grid-cols-6  ">
            <div className="flex gap-2.5 px-2 py-1">
              <Image
                className="object-cover w-[16px] h-[16px] "
                width={13.333333015441895}
                height={13.333333015441895}
                alt="icons"
                src="/icons/Vector.svg"
              />
              <div className=" flex flex-col gap-0.5">
                <div className={`font-medium text-[14px] ${isDark ? "text-[#FFFFFF]" : "text-[#101010]"}`}>
                  BUY
                </div>
                <div className="font-normal text-[12px] text-[#808080]">
                  Limit
                </div>
              </div>
            </div>

            <span className={`text-[12px] leading-[18px] font-medium px-2 py-1 ${isDark ? "text-[#FFFFFF]" : "text-[#222222]"}`}>
              9287
            </span>
            <span className={`text-[12px] leading-[18px] font-medium px-2 py-1 ${isDark ? "text-[#FFFFFF]" : "text-[#222222]"}`}>
              0.0010767
            </span>
            <span className={`text-[12px] leading-[18px] font-medium px-2 py-1 ${isDark ? "text-[#FFFFFF]" : "text-[#222222]"}`}>
              100%
            </span>
            <span className={`text-[12px] leading-[18px] font-medium px-2 py-1 ${isDark ? "text-[#FFFFFF]" : "text-[#222222]"}`}>
              2025-10-23{"\n"}14:25:46
            </span>
            <span className={`text-[12px] leading-[18px] font-medium px-2 py-1 ${isDark ? "text-[#FFFFFF]" : "text-[#222222]"}`}>
              Completed
            </span>
          </div>

          <div className="grid grid-cols-6  ">
            <div className="flex gap-2.5 px-2 py-1">
              <Image
                className="object-cover w-[16px] h-[16px] "
                width={13.333333015441895}
                height={13.333333015441895}
                alt="icons"
                src="/icons/Vector.svg"
              />
              <div className=" flex flex-col gap-0.5">
                <div className={`font-medium text-[14px] ${isDark ? "text-[#FFFFFF]" : "text-[#101010]"}`}>
                  SELL
                </div>
                <div className="font-normal text-[12px] text-[#808080]">
                  Limit
                </div>
              </div>
            </div>

            <span className={`text-[12px] leading-[18px] font-medium px-2 py-1 ${isDark ? "text-[#FFFFFF]" : "text-[#222222]"}`}>
              9287
            </span>
            <span className={`text-[12px] leading-[18px] font-medium px-2 py-1 ${isDark ? "text-[#FFFFFF]" : "text-[#222222]"}`}>
              0.0010767
            </span>
            <span className={`text-[12px] leading-[18px] font-medium px-2 py-1 ${isDark ? "text-[#FFFFFF]" : "text-[#222222]"}`}>
              100%
            </span>
            <span className={`text-[12px] leading-[18px] font-medium px-2 py-1 ${isDark ? "text-[#FFFFFF]" : "text-[#222222]"}`}>
              2025-10-23{"\n"}14:25:46
            </span>
            <span className={`text-[12px] leading-[18px] font-medium px-2 py-1 ${isDark ? "text-[#FFFFFF]" : "text-[#222222]"}`}>
              Completed
            </span>
          </div>
        </div>
      </div>

      {/* Info Cards */}
      <div className=" grid grid-cols-2 gap-3">
        <div className={`rounded-lg border p-2.5 flex flex-col gap-2.5 ${isDark ? "border-[#333333] bg-[#111111]" : "border-[#E2E2E2] bg-[#FFFFFF]"}`}>
          <div className="flex justify-between text-[10px] leading-3 font-semibold">
            <span className={isDark ? "text-[#FFFFFF]" : "text-black"}>STOP:</span>
            <span className="text-[#464545]">9100</span>
          </div>

          <div className="flex justify-between text-[10px] leading-3 font-semibold">
            <span className={isDark ? "text-[#FFFFFF]" : "text-black"}>Limit:</span>
            <span className="text-[#464545]">0</span>
          </div>

          <div className="flex justify-between text-[10px] leading-3 font-semibold">
            <span className={isDark ? "text-[#FFFFFF]" : "text-black"}>USDT</span>
            <span className="text-[#464545]">1 USDT</span>
          </div>
        </div>
        <div className={`rounded-lg border p-2.5 flex flex-col gap-2.5 ${isDark ? "border-[#333333] bg-[#111111]" : "border-[#E2E2E2] bg-[#FFFFFF]"}`}>
          <div className="flex justify-between text-[10px] leading-3 font-semibold">
            <span className={isDark ? "text-[#FFFFFF]" : "text-black"}>Current SL:</span>
            <span className="text-[#464545]">9100</span>
          </div>

          <div className="flex justify-between text-[10px] leading-3 font-semibold">
            <span className={isDark ? "text-[#FFFFFF]" : "text-black"}>Current Limit:</span>
            <span className="text-[#464545]">0</span>
          </div>

          <div className="flex justify-between text-[10px] leading-3 font-semibold">
            <span className={isDark ? "text-[#FFFFFF]" : "text-black"}>Status:</span>
            <span className="text-[#464545]">Partially Filled</span>
          </div>
        </div>
      </div>

      {/* Edit Button */}
      <div className="flex flex-col gap-2">
        <Button
          type="solid"
          size="medium"
          text="Edit Order"
          disabled={false}
          onClick={onEdit}
        />

        <div className="flex gap-2">
          <Button
            type="ghost"
            size="medium"
            text="Liquidate"
            disabled={false}
          />
          <Button
            type="ghost"
            size="medium"
            text="Cancel Bracket"
            disabled={false}
          />
        </div>
      </div>
    </div>
  );
};
