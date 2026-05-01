import { iconPaths } from "@/lib/constants";
import Image from "next/image";
import { useState } from "react";

interface AmountBreakdownDropDownProps {
  breakdownData: Array<{
    name: string;
    value: number;
    valueInUSD: number;
  }>;
}

export const AmountBreakdownDropDown = (
  props: AmountBreakdownDropDownProps
) => {
  const isGrid = props.breakdownData.length > 3;

  return (
    <div className="w-fit rounded-[12px] bg-[#F7F7F7] border-[1px]">
      <div className="text-[12px] font-medium text-black px-[12px] pt-[16px] pb-[4px] border-b-[1px] border-b-[#E5E5E5]">
        Total Breakdown:
      </div>

      {/* If more than 3 items → show in a 3‑column grid, otherwise simple list */}
      <div className={isGrid ? "grid grid-cols-3" : ""}>
        {props.breakdownData.map((item, idx) => {
          const content = (
            <div className="px-[12px] py-[8px] flex items-start justify-start gap-[8px]">
              {/* Index (1., 2., 3., ...) */}
              <div className="text-[12px] font-medium">{idx + 1}.</div>

              <div className="w-[16px] h-[16px]">
                <Image
                  src={
                    iconPaths[item.name.toUpperCase() as keyof typeof iconPaths]
                  }
                  alt={item.name}
                  width={16}
                  height={16}
                />
              </div>
              <div className="flex flex-col gap-[2px]">
                <div className="text-[12px] font-medium">
                  {item.value} {item.name}
                </div>
                <div className="text-[10px] font-medium text-neutral-500">
                  {item.valueInUSD ? `${item.valueInUSD} USD` : ""}
                </div>
              </div>
            </div>
          );

          return isGrid ? (
            <div key={idx} className="flex items-center gap-[4px] ">
              {content}
            </div>
          ) : (
            <div
              key={idx}
              className={` ${
                props.breakdownData.length - 1 === idx
                  ? "border-b-0"
                  : "border-b-[1px] border-b-[#E5E5E5]"
              } flex gap-[8px] items-center`}
            >
              {content}
            </div>
          );
        })}
      </div>
    </div>
  );
};
