"use client";

import Image from "next/image";
import { Checkbox } from "../../ui/Checkbox";
import { FieldArrayWithId, UseFormRegister } from "react-hook-form";
import { OrderPlacementFormValues } from "@/lib/types";
import { useTheme } from "@/contexts/theme-context";

interface MultipleTpProps {
  fields: FieldArrayWithId<
    OrderPlacementFormValues,
    "multipleTakeProfits",
    "id"
  >[];
  register: UseFormRegister<OrderPlacementFormValues>;
  onAdd: () => void;
  onRemove: (index: number) => void;
  // maxReached: boolean;
}

const inputBase =
  "w-full min-w-0 py-1 bg-transparent outline-none text-[10px] leading-[15px] font-medium text-left placeholder:text-[8px] placeholder:font-medium placeholder:text-[#C6C6C6]";

export default function MultipleTp({
  fields,
  register,
  onAdd,
  onRemove,
}: // maxReached:
MultipleTpProps) {
  const { isDark } = useTheme();
  return (
    <div className="flex flex-col rounded-sm gap-3 overflow-hidden">
      {/* Header */}
      <div className="sticky top-0 z-10 flex gap-1 text-[#A7A7A7] text-[8px] leading-3 font-medium">
        <div className="flex flex-2 gap-1 px-1">
          <div className="flex-1 py-1 text-left">Exit Price (USD)</div>
          <div className="flex-1 py-1 text-left">Profit (%)</div>
        </div>

        <div className="flex-1 py-1 text-left ">Profit (USD)</div>

        <div className="flex flex-2 gap-1 px-1">
          <div className="flex-1 py-1 text-left">Units (%)</div>
          <div className="flex-1 py-1 text-left ">Units</div>
        </div>

        <div className="w-9 py-1 text-center">Market Price</div>

        <div className="w-9 py-1 text-center">Add/Del</div>
      </div>

      {/* Rows */}
      <div className="max-h-[109px] overflow-y-auto  overscroll-contain scrollbar-hide flex flex-col gap-2">
        {fields.map((field, index) => (
          <div
            key={field.id}
            className={`flex gap-1 item-center text-[10px] leading-[15px] font-medium ${isDark ? "text-[#FFFFFF]" : "text-[#111111]"}`}
          >
            <div className={`flex flex-2 rounded-sm border gap-1 p-1 ${isDark ? "bg-[#111111] border-[#333333]" : "bg-white border-[#E2E2E2]"}`}>
              <input
                type="number"
                placeholder="Exit Price(USD)"
                {...register(`multipleTakeProfits.${index}.exitPricePercent`)}
                className={inputBase}
              />
              <input
                type="number"
                placeholder="Profit(%)"
                {...register(`multipleTakeProfits.${index}.profitPercent`)}
                className={inputBase}
              />
            </div>
            <div className={`flex-1 rounded-sm border items-center justify-center p-1 ${isDark ? "bg-[#111111] border-[#333333]" : "bg-white border-[#E2E2E2]"}`}>
              <input
                type="number"
                placeholder="Profit"
                {...register(`multipleTakeProfits.${index}.profitAmount`)}
                className={inputBase}
              />
            </div>
            <div className={`flex flex-2 rounded-sm border gap-1 p-1 ${isDark ? "bg-[#111111] border-[#333333]" : "bg-white border-[#E2E2E2]"}`}>
              <input
                type="number"
                placeholder="Units (%)"
                {...register(`multipleTakeProfits.${index}.unitsPercent`)}
                className={inputBase}
              />
              <input
                type="number"
                placeholder="Units"
                {...register(`multipleTakeProfits.${index}.units`)}
                className={inputBase}
              />
            </div>
            {/* Market Price */}
            <div className="w-9 flex justify-center ">
              <Checkbox
                {...register(`multipleTakeProfits.${index}.marketPrice`)}
              />
            </div>
            {/* Add / Remove */}
            {index === fields.length - 1 ? (
              <button
                type="button"
                onClick={onAdd}
                // disabled={maxReached}
                className={`w-9 p-1 flex justify-center items-center cursor-pointer  `}
              >
                <Image
                  src="/icons/plus.svg"
                  alt="add"
                  width={17}
                  height={17}
                  className="object-cover"
                />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onRemove(index)}
                className="min-w-9 p-1 flex justify-center items-center cursor-pointer"
              >
                <Image
                  src="/icons/minus.svg"
                  alt="remove"
                  width={17}
                  height={17}
                  className="object-cover"
                />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
