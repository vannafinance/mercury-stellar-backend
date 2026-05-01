"use client";

import { useEffect, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";

import ToggleButton from "../../ui/toggle";
import { Button } from "../../ui/button";
import {
  OrderPlacementFormValues,
  OrderSide,
  OrderType,
  TimeInForce,
} from "@/lib/types";
import Image from "next/image";
import { Checkbox } from "../../ui/Checkbox";
import { Dropdown } from "../../ui/dropdown";
import MultipleTp from "./MultipleTp";
import { RiskRewardSelector } from "./Risk-Reward";
import { AnimatedTabs } from "../../ui/animated-tabs";
import { resetOrderForm } from "@/lib/resetOrderForm";
import { useUserStore } from "@/store/user";
import { useSpotTradeStore } from "@/store/spot-trade-store";
import { mapOrderToActivePosition, mapOrderToOpenOrder } from "@/lib/helper";
import { InputWithUnit } from "../../ui/InputWithUnit";
import { BaseInput } from "../../ui/BaseInput";
import { useTheme } from "@/contexts/theme-context";

type FormMode = "create" | "edit";

interface OrderPlacementFormProps {
  mode?: FormMode;
  initialValues?: OrderPlacementFormValues;
  onCancel?: () => void;
  onSave?: (values: OrderPlacementFormValues) => void;
}
const tabs = [
  { id: "limit", label: "Limit" },
  { id: "market", label: "Market" },
  { id: "trigger", label: "Trigger" },
];

const TIME_IN_FORCE_OPTIONS: TimeInForce[] = ["GTC", "Post-Only", "FOK", "IOC"];

const buySellTabs: { id: OrderSide; label: string }[] = [
  { id: "buy", label: "Buy" },
  { id: "sell", label: "Sell" },
];

// const MAX_TP_ROWS = 3;

const EMPTY_TP_ROW = {
  exitPricePercent: null,
  profitPercent: null,
  profitAmount: null,
  unitsPercent: null,
  units: null,
  marketPrice: false,
};

export default function OrderPlacementForm({
  mode = "create",
  initialValues,
  onCancel,
  onSave,
}: OrderPlacementFormProps) {
  const orderPlacementFormDefaultValues: OrderPlacementFormValues = {
    orderType: "limit",
    orderSide: "buy",

    loopEnabled: false,
    noOfLoops: undefined, // null = infinity

    triggerPrice: null,
    triggerMode: "limit",

    entryPrice: null,
    totalUnits: null,
    totalAmount: null,

    takeProfitEnabled: false,
    multipleTpEnabled: false,

    singleTakeProfit: {
      exitPrice: null,
      profitPercent: null,
      profitAmount: null,
    },

    multipleTakeProfits: [],

    stopLossEnabled: false,
    stopLoss: {
      triggerPrice: null,
      limitPrice: null,
      trailVariance: null,
      trailVarianceUnit: "USD",
      rrRatio: "NA",
      customRR: null,
    },

    timeInForce: "GTC",

    riskAmount: 0,
    riskPercent: 0,
    gainAmount: 0,
    gainPercent: 0,
  };
  const { isDark } = useTheme();
  const userAddress = useUserStore((state) => state.address);

  const setSpotTrade = useSpotTradeStore((s) => s.set);
  const getSpotTrade = useSpotTradeStore((s) => s.get);

  const {
    control,
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
    reset,
  } = useForm<OrderPlacementFormValues>({
    defaultValues: orderPlacementFormDefaultValues,
  });

  const orderType: OrderType = watch("orderType");
  const orderSide: OrderSide = watch("orderSide");
  const isLoopOn = watch("loopEnabled");
  const noOfLoops = watch("noOfLoops");
  const triggerMode = watch("triggerMode");
  const takeProfitEnabled = watch("takeProfitEnabled");
  const multiTpEnabled = watch("multipleTpEnabled");
  const stopLossEnabled = watch("stopLossEnabled");
  const rrRatio = watch("stopLoss.rrRatio");
  const customRR = watch("stopLoss.customRR");
  const timeInForce = watch("timeInForce");

  const { fields, append, remove } = useFieldArray({
    control,
    name: "multipleTakeProfits",
  });

  // ✅ MAX 3 ROWS GUARD
  const handleAddTp = () => {
    // if (fields.length >= MAX_TP_ROWS) return;
    append(EMPTY_TP_ROW);
  };

  useEffect(() => {
    if (mode === "edit" && initialValues) {
      reset(initialValues);
    }
  }, [mode, initialValues, reset]);

  // as soon as multiTP is enabled, add a row if none exist
  useEffect(() => {
    if (multiTpEnabled && fields.length === 0) {
      append(EMPTY_TP_ROW);
    }

    if (!multiTpEnabled && fields.length > 0) {
      remove(); //
    }
  }, [multiTpEnabled]);

  const handleOrderTypeChange = (val: string) => {
    if (val === "limit" || val === "market" || val === "trigger") {
      setValue("orderType", val);
    }
  };

  const handleTabChange = (tabId: string) => {
    setValue("orderSide", tabId as OrderSide);
  };

  const handleModeToggle = () => {
    setValue("triggerMode", triggerMode === "limit" ? "market" : "limit");
  };

  // sync when store changes (e.g. reset from somewhere else)
  // useEffect(() => {
  //   reset(form);
  // }, [form, reset]);

  const onSubmit = (values: OrderPlacementFormValues) => {
    if (values.orderType === "market") {
      const currentPrice = 66500;
      const position = mapOrderToActivePosition(values, currentPrice);
      const prevPositions = getSpotTrade((s) => s.activePositions);
      setSpotTrade({ activePositions: [position, ...prevPositions] });
    }
    if (values.orderType === "limit") {
      const openOrders = mapOrderToOpenOrder(values);
      const prevOpenOrders = getSpotTrade((s) => s.openOrders);
      setSpotTrade({ openOrders: [openOrders, ...prevOpenOrders] });
    }

    console.log("ORDER SUBMIT =>", values);

    resetOrderForm(setValue, () => remove());
  };

  useEffect(() => {
    if (!takeProfitEnabled) {
      setValue("multipleTpEnabled", false);
      remove(); // saari multi TP rows clear
    }
  }, [remove, setValue, takeProfitEnabled]);

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className={`max-w-[316px] rounded-2xl p-4 flex flex-col gap-5 text-[10px] leading-[15px] font-medium ${
        isDark ? "bg-[#222222] text-[#FFFFFF]" : "bg-[#F7F7F7] text-[#111111]"
      } ${mode === "create" ? isDark ? "border border-[#333333]" : "border border-[#E2E2E2]" : ""} `}
    >
      {mode === "create" && (
        <AnimatedTabs
          tabs={tabs}
          activeTab={orderType}
          onTabChange={handleOrderTypeChange}
          type="underline"
        />
      )}

      {mode === "create" && (
        <AnimatedTabs
          type="segment"
          tabs={buySellTabs}
          activeTab={orderSide}
          onTabChange={(val) => setValue("orderSide", val as OrderSide)}
        />
      )}

      {/* Loop toggle row */}
      {orderType === "limit" && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 justify-end">
            <span className={`text-[10px] leading-[15px] font-medium ${isDark ? "text-[#FFFFFF]" : "text-[#111111]"}`}>
              Loop
            </span>
            <ToggleButton
              size="small"
              defaultChecked={isLoopOn}
              onToggle={(val) => setValue("loopEnabled", val)}
            />
          </div>
          {isLoopOn && (
            <div className="flex flex-col gap-2">
              <div className="flex flex-col gap-1">
                <label className={`text-[10px] leading-[15px] font-medium ${isDark ? "text-[#FFFFFF]" : "text-[#111111]"}`}>
                  No of Loops
                </label>
                <div className={`h-9 flex items-center rounded-lg border px-2 ${isDark ? "border-[#333333] bg-[#111111]" : "border-[#E2E2E2] bg-white"}`}>
                  <input
                    placeholder="Enter No of Loops"
                    disabled={noOfLoops === null}
                    className={`w-full text-[12px] leading-[18px] font-medium outline-none bg-transparent placeholder:text-[#C6C6C6]
                    ${isDark ? "text-[#FFFFFF]" : ""}
                    disabled:text-[#9CA3AF]
                    disabled:placeholder:text-[#D1D5DB]
                    disabled:cursor-not-allowed
                    `}
                    {...register("noOfLoops", {
                      min: { value: 1, message: "Min 1 loop" },
                    })}
                  />
                </div>
              </div>

              <div className="flex gap-2 min-w-0 ">
                {[5, 10, 15].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setValue("noOfLoops", n)}
                    className={`flex-1 min-w-0 cursor-pointer  h-9 rounded-lg p-2.5  text-[12px] leading-[18px] font-medium  ${
                      noOfLoops === n
                        ? "bg-[#F1EBFD] text-[#703AE6]"
                        : isDark ? "bg-[#111111] text-[#FFFFFF]" : "bg-white text-[#111111]"
                    }`}
                  >
                    {n}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setValue("noOfLoops", null)}
                  className={`flex-1 min-w-0 flex items-center justify-center cursor-pointer h-9 rounded-lg p-2.5 text-[20px] leading-[22px] font-medium ${
                    noOfLoops === null
                      ? "bg-[#703AE6] text-white"
                      : isDark ? "bg-[#111111] text-[#FFFFFF]" : "bg-white text-[#111111]"
                  }`}
                >
                  <Image
                    src="/icons/infinite.svg"
                    alt="infinite"
                    width={18}
                    height={17}
                  />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {orderType === "trigger" && (
        <InputWithUnit
          label="Trigger Price"
          placeholder="Trigger Price"
          name="triggerPrice"
          register={register}
          rules={{
            required: "Required",
            min: { value: 0, message: "Must be positive" },
            valueAsNumber: true,
          }}
          suffixMode="static"
          selectedSuffix="USDT"
        />
      )}

      <div className=" flex flex-col gap-3 ">
        {/* Limit market toggle */}
        {orderType === "trigger" && (
          <div className="flex items-center gap-1 justify-end">
            <span className={`text-[10px] leading-[15px] font-medium ${isDark ? "text-[#FFFFFF]" : "text-[#111111]"}`}>
              Limit
            </span>
            <ToggleButton size="small" onToggle={handleModeToggle} />
            <span className={`text-[10px] leading-[15px] font-medium ${isDark ? "text-[#FFFFFF]" : "text-[#111111]"}`}>
              Market
            </span>
          </div>
        )}

        <div className=" flex gap-3  min-w-0">
          {orderType !== "market" ? (
            <div className="flex-1 min-w-0">
              <InputWithUnit
                label="Entry Price"
                placeholder="Enter Price"
                name="entryPrice"
                register={register}
                rules={{
                  required: "Required",
                  min: { value: 0, message: "Must be positive" },
                  valueAsNumber: true,
                }}
                suffixMode="static"
                selectedSuffix="USDT"
              />
            </div>
          ) : (
            <div className="flex-1 min-w-0">
              <BaseInput label="Market Price" disabled={true}>
                <div className="flex-1 min-w-0 text-[12px] leading-[18px] font-medium">
                  66500
                </div>
                <span className={`text-[8px] leading-3 font-medium ${isDark ? "text-[#FFFFFF]" : "text-[#111111]"}`}>
                  USDT
                </span>
              </BaseInput>
            </div>
          )}

          {/* Total Units */}
          <div className="flex-1 min-w-0">
            <InputWithUnit
              label="Total Units"
              placeholder="Enter Unit"
              name="totalUnits"
              register={register}
              rules={{
                required: "Required",
                min: { value: 0, message: "Must be positive" },
                valueAsNumber: true,
              }}
              suffixMode="static"
              selectedSuffix="USDT"
            />
          </div>
        </div>
      </div>

      {/* Total Amount + % buttons */}
      <div className="flex flex-col gap-2">
        {/* label + MB text */}
        <div className="flex items-center justify-between ">
          <label className={`text-[10px] leading-[15px] font-medium ${isDark ? "text-[#FFFFFF]" : "text-[#111111]"}`}>
            Total Amount
          </label>

          <span className="flex items-center gap-1 text-[10px] leading-[15px] font-medium text-[#919191]">
            <Image
              className="object-cover"
              width={14}
              height={14}
              alt="icons"
              src="/icons/info.svg"
            />
            MB: 2000.00 USDT
          </span>
        </div>

        {/* Input + % buttons row */}

        <BaseInput>
          <input
            type="number"
            placeholder="Enter Amount"
            className=" flex-1 min-w-0 bg-transparent text-[12px] leading-[18px] font-medium outline-none placeholder:text-[#C6C6C6] "
            {...register("totalAmount", {
              required: "Required",
              min: { value: 0, message: "Must be positive" },
              valueAsNumber: true,
            })}
          />

          <span className="text-[8px] leading-3 font-medium text-[#111111]">
            USDT
          </span>
        </BaseInput>

        {/* % BUTTONS */}
        <div className="flex gap-2 min-w-0">
          {[10, 25, 50, 100].map((p) => (
            <button
              key={p}
              type="button"
              className={`flex-1  cursor-pointer min-w-0 h-9 rounded-lg text-[10px] leading-[15px] font-medium ${isDark ? "bg-[#111111] text-[#FFFFFF]" : "bg-white text-[#111111]"}`}
            >
              {p}%
            </button>
          ))}
        </div>
      </div>

      <div
        className={` ${
          takeProfitEnabled
            ? `flex flex-col gap-2 border-b pb-4 ${isDark ? "border-[#333333]" : "border-[#E2E2E2]"}`
            : ""
        }`}
      >
        <div className="flex justify-between  ">
          <Checkbox label="Take Profit" {...register("takeProfitEnabled")} />

          {takeProfitEnabled && (
            <div className="flex items-center gap-2 justify-end">
              <span className={`text-[10px] leading-[15px] font-medium ${isDark ? "text-[#FFFFFF]" : "text-[#111111]"}`}>
                Multiple TP
              </span>
              <ToggleButton
                size="small"
                onToggle={(val) => setValue("multipleTpEnabled", val)}
              />
            </div>
          )}
        </div>

        {takeProfitEnabled && !multiTpEnabled && (
          <div className={`flex gap-1 min-w-0 border rounded-lg p-2 ${isDark ? "bg-[#111111] border-[#333333]" : "bg-white border-[#E2E2E2]"}`}>
            <div className=" flex flex-1 flex-col min-w-0 gap-1">
              <label className="text-[8px] font-medium leading-3 text-[#C6C6C6]">
                Exit Price (USD)
              </label>
              <input
                type="number"
                placeholder="00.00"
                className={`w-full min-w-0 text-[12px] font-medium leading-[18px] outline-none bg-transparent ${isDark ? "text-[#FFFFFF]" : "text-[#000000]"}`}
                {...register("singleTakeProfit.exitPrice", { min: 0 })}
              />
            </div>

            <div className="flex flex-1 flex-col min-w-0 items-center gap-1">
              <label className="text-[8px] font-medium leading-3 text-[#C6C6C6]">
                Profit (%)
              </label>
              <input
                type="number"
                placeholder="00.00"
                className={`w-full min-w-0 text-[12px] font-medium text-center flex-1 leading-[18px] outline-none bg-transparent ${isDark ? "text-[#FFFFFF]" : "text-[#000000]"}`}
                {...register("singleTakeProfit.profitPercent", { min: 0 })}
              />
            </div>

            <div className="flex flex-1 flex-col min-w-0 items-end gap-1">
              <label className="text-[8px] font-medium leading-3 text-[#C6C6C6]">
                Profit (USD)
              </label>
              <input
                type="number"
                placeholder="00.00"
                className={`w-full min-w-0 text-[12px] font-medium text-right flex-1 leading-[18px] outline-none bg-transparent ${isDark ? "text-[#FFFFFF]" : "text-[#000000]"}`}
                {...register("singleTakeProfit.profitAmount", { min: 0 })}
              />
            </div>
          </div>
        )}
        {takeProfitEnabled && multiTpEnabled && (
          <MultipleTp
            fields={fields}
            register={register}
            onAdd={handleAddTp}
            onRemove={remove}
            // maxReached={fields.length >= MAX_TP_ROWS}
          />
        )}
      </div>

      <div
        className={`${
          stopLossEnabled
            ? `flex flex-col gap-2 border-b pb-4 ${isDark ? "border-[#333333]" : "border-[#E2E2E2]"}`
            : ""
        }`}
      >
        <Checkbox label="Stop Loss" {...register("stopLossEnabled")} />

        {stopLossEnabled && (
          <>
            <div className="flex gap-1 w-full items-start overflow-hidden">
              <div className="flex-1 min-w-0">
                <InputWithUnit
                  label="SL Trigger Price"
                  placeholder="00.00"
                  name="stopLoss.triggerPrice"
                  register={register}
                  rules={{ min: 0 }}
                  suffixMode="static"
                  selectedSuffix="USDT"
                />
              </div>

              <div className="flex-1 min-w-0">
                <InputWithUnit
                  label="SL Limit (optional)"
                  placeholder="00.00"
                  name="stopLoss.limitPrice"
                  register={register}
                  rules={{ min: 0 }}
                  suffixMode="static"
                  selectedSuffix="USDT"
                />
              </div>

              <div className="flex-1 min-w-0">
                <InputWithUnit
                  label="Trail Variance"
                  placeholder="00.00"
                  name="stopLoss.trailVariance"
                  register={register}
                  rules={{ min: 0 }}
                  suffixMode="static"
                  selectedSuffix="USDT"
                />
              </div>
            </div>

            {/*Risk Reward */}
            <RiskRewardSelector
              value={rrRatio ?? "NA"}
              customValue={customRR ?? null}
              onChange={(v) => setValue("stopLoss.rrRatio", v)}
              onCustomChange={(v) => setValue("stopLoss.customRR", v)}
            />
          </>
        )}
      </div>

      <div className={`flex flex-col gap-1 pt-2 text-[11px] ${isDark ? "text-[#FFFFFF]" : "text-[#111111]"}`}>
        <div className="flex gap-16">
          <div className="flex gap-1 w-[138px]">
            <div className={`text-[10px] font-semibold leading-[15px] ${isDark ? "text-[#FFFFFF]" : "text-[#111111]"}`}>
              Risk:
            </div>
            <div className="text-[#464545] text-[10px] font-medium leading-[15px]">
              00.00 USDT
            </div>
          </div>
          <div className="flex gap-1 w-[138px]">
            <div className={`text-[10px] font-semibold leading-[15px] ${isDark ? "text-[#FFFFFF]" : "text-[#111111]"}`}>
              Risk (in %):
            </div>
            <div className="text-[#464545] text-[10px] font-medium leading-[15px]">
              00.00
            </div>
          </div>
        </div>
        <div className="flex gap-16">
          <div className="flex gap-1 w-[138px]">
            <div className={`text-[10px] font-semibold leading-[15px] ${isDark ? "text-[#FFFFFF]" : "text-[#111111]"}`}>
              Gain:
            </div>
            <div className="text-[#464545] text-[10px] font-medium leading-[15px]">
              00.00 USDT
            </div>
          </div>
          <div className="flex gap-1 w-[138px]">
            <div className={`text-[10px] font-semibold leading-[15px] ${isDark ? "text-[#FFFFFF]" : "text-[#111111]"}`}>
              Gain (in %):
            </div>
            <div className="text-[#464545] text-[10px] font-medium leading-[15px]">
              00.00
            </div>
          </div>
        </div>
      </div>

      {/* Time in Force Dropdown */}
      {orderType === "limit" && (
        <div className="flex items-center gap-2 ">
          <div className="text-[#6F6F6F] text-[12px]  font-medium leading-[18px] whitespace-nowrap ">
            Time in Force
          </div>
          <Dropdown
            items={TIME_IN_FORCE_OPTIONS}
            selectedOption={timeInForce ?? "GTC"}
            setSelectedOption={(val) =>
              setValue("timeInForce", val as TimeInForce)
            }
            classname="gap-0.5 text-[12px] leading-[18px] font-medium"
            dropdownClassname="text-[12px] font-semibold"
          />
        </div>
      )}

      {/* Submit */}
      {/* {userAddress ? (
        <Button text="Place Order" size="small" type="solid" disabled={false} />
      ) : (
        <Button
          text="Connect Wallet to Trade"
          size="small"
          type="solid"
          disabled={true}
        />
      )} */}

      {!userAddress ? (
        <Button
          text="Connect Wallet To Trade"
          size="small"
          type="solid"
          disabled={true}
        />
      ) : mode === "edit" ? (
        <div className="flex gap-3">
          <Button
            text="Cancel"
            size="small"
            type="ghost"
            onClick={onCancel}
            disabled={false}
          />

          <Button
            text="Save As"
            size="small"
            type="solid"
            onClick={handleSubmit(onSave!)}
            disabled={false}
          />
        </div>
      ) : (
        <Button text="Place Order" size="small" type="solid" disabled={false} />
      )}
    </form>
  );
}
