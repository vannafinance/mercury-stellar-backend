"use client";

import { useMemo, useState } from "react";
import { OrderBookRow } from "./OrderBookRow";
import { OrderSide } from "@/lib/types";
import { calculateRatio, groupOrdersByTick } from "@/lib/helper";
import { Dropdown } from "../../ui/dropdown";
import Image from "next/image";
import { MarketTrades } from "./MarketTrades";
import { useTheme } from "@/contexts/theme-context";

export interface OrderBookRowType {
  price: number;
  amount: number;
  total: number;
  side: OrderSide;
}

export type OrderBookView = "both" | "buy" | "sell";

const VIEW_ICONS: Record<OrderBookView, string> = {
  both: "/spot/orderbook-view-both.svg",
  buy: "/spot/orderbook-view-buy.svg",
  sell: "/spot/orderbook-view-sell.svg",
};

const TICK_OPTIONS = ["0.01", "0.1", "1", "10", "50", "100", "1000"];

const buyOrders: OrderBookRowType[] = [
  { price: 102599.1, amount: 0.78, total: 79877, side: "buy" },
  { price: 102599.3, amount: 1.31, total: 213466, side: "buy" },
  { price: 102599.5, amount: 0.49, total: 263628, side: "buy" },
  { price: 102599.7, amount: 0.91, total: 357014, side: "buy" },
  { price: 102599.9, amount: 0.66, total: 424905, side: "buy" },
  { price: 102600.1, amount: 1.42, total: 570868, side: "buy" },
  { price: 102600.3, amount: 0.4, total: 611801, side: "buy" },
  { price: 102600.5, amount: 1.1, total: 724980, side: "buy" },
];

const sellOrders: OrderBookRowType[] = [
  { price: 102615.4, amount: 0.69, total: 70752, side: "sell" },
  { price: 102615.2, amount: 0.91, total: 164168, side: "sell" },
  { price: 102615.0, amount: 1.33, total: 300415, side: "sell" },
  { price: 102614.8, amount: 0.51, total: 352552, side: "sell" },
  { price: 102614.6, amount: 0.94, total: 449185, side: "sell" },
  { price: 102614.4, amount: 0.61, total: 511964, side: "sell" },
  { price: 102614.2, amount: 0.78, total: 592424, side: "sell" },
  { price: 102614.0, amount: 1.12, total: 707441, side: "sell" },
];

export default function OrderBook() {
  const { isDark } = useTheme();
  const [activeTab, setActiveTab] = useState<"orderbook" | "markettrades">(
    "orderbook"
  );
  const [view, setView] = useState<OrderBookView>("both");
  const [tick, setTick] = useState(0.01);

  //  replace these with WS / API state later
  const rawBuys = buyOrders;
  const rawSells = sellOrders;

  const buys = useMemo(() => groupOrdersByTick(rawBuys, tick), [rawBuys, tick]);

  const sells = useMemo(
    () => groupOrdersByTick(rawSells, tick),
    [rawSells, tick]
  );

  const maxTotal = useMemo(() => {
    return Math.max(...buys.map((o) => o.total), ...sells.map((o) => o.total));
  }, [buys, sells]);

  const { buyRatio, sellRatio } = useMemo(
    () => calculateRatio(buys, sells),
    [buys, sells]
  );

  // mid price (best bid / ask)
  const bestBid = buys[0]?.price;
  const bestAsk = sells[0]?.price;
  const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : undefined;

  return (
    <div className={`flex flex-col rounded-xl p-2 gap-1 ${isDark ? "bg-[#222222]" : "bg-[#F7F7F7]"}`}>
      {/* Buttons */}
      <div className={`flex items-center p-1 rounded-lg h-[47px] ${isDark ? "bg-[#111111]" : "bg-white"}`}>
        <button
          onClick={() => setActiveTab("orderbook")}
          className={`cursor-pointer flex flex-1 items-center justify-center rounded-lg py-3 px-2
      ${activeTab === "orderbook" ? "bg-[#F1EBFD]" : "bg-transparent"}`}
        >
          <span
            className={`text-[12px] font-semibold text-center
          ${activeTab === "orderbook" ? "text-[#703AE6]" : isDark ? "text-[#FFFFFF]" : "text-black"}`}
          >
            Orderbook
          </span>
        </button>

        <button
          onClick={() => setActiveTab("markettrades")}
          className={`cursor-pointer flex flex-1 items-center justify-center rounded-lg py-3 px-2
      ${activeTab === "markettrades" ? "bg-[#F1EBFD]" : "bg-transparent"}`}
        >
          <span
            className={`text-[12px] font-semibold text-center
          ${activeTab === "markettrades" ? "text-[#703AE6]" : isDark ? "text-[#FFFFFF]" : "text-black"}`}
          >
            Market Trades
          </span>
        </button>
      </div>
      {activeTab === "orderbook" && (
        <div className="flex w-full items-center  px-1">
          <div className="flex  gap-2">
            {(Object.keys(VIEW_ICONS) as OrderBookView[]).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`  w-4 h-4 cursor-pointer transition ${
                  view === v ? "" : isDark ? "hover:bg-white/20" : "hover:bg-white/60"
                }`}
                aria-label={`View ${v}`}
              >
                <Image src={VIEW_ICONS[v]} alt={v} width={16} height={16} />
              </button>
            ))}
          </div>

          <div className="ml-auto">
            <Dropdown
              items={TICK_OPTIONS}
              selectedOption={String(tick)}
              setSelectedOption={(val) => setTick(Number(val))}
              classname=" gap-0.5 text-[10px] leading-[15px] font-medium  "
              dropdownClassname="text-[12px] leading-[18px] font-medium "
            />
          </div>
        </div>
      )}

      {activeTab === "orderbook" && (
        <>
          <div className="flex flex-col gap-1">
            {/** sell side */}
            <div className=" flex flex-col">
              <div className=" grid grid-cols-3 text-[10px]  leading-[15px] text-[#5C5B5B] font-medium">
                <span className="py-1 ">Price(USDT)</span>
                <span className="py-1  text-right">Amount(BTC)</span>
                <span className="py-1  text-right">Total(USDT)</span>
              </div>
              <div>
                {(view === "both" || view === "sell") &&
                  sells.map((r, i) => (
                    <OrderBookRow key={i} row={r} maxTotal={maxTotal} />
                  ))}
              </div>
            </div>

            {/** mid price */}
            {view === "both" && mid && (
              <div className="font-semibold  text-[12px] leading-[18px] text-[#FC5457]">
                {mid.toLocaleString()}
              </div>
            )}

            {/**Buy Side */}
            <div>
              {(view === "both" || view === "buy") &&
                buys.map((r, i) => (
                  <OrderBookRow key={i} row={r} maxTotal={maxTotal} />
                ))}
            </div>
          </div>

          {/* Ratio */}
          {view === "both" && (
            <div className="flex items-center gap-[3px]">
              {/* Buy */}
              <div className="text-[12px] leading-[18px] font-semibold text-[#24A0A9] shrink-0">
                B {buyRatio}%
              </div>

              {/* Ratio Bar */}
              <div className="flex-1 h-1 rounded-full overflow-hidden flex">
                <div
                  className="bg-[#24A0A9]"
                  style={{ width: `${buyRatio}%` }}
                />
                <div
                  className="bg-[#FC5457]"
                  style={{ width: `${sellRatio}%` }}
                />
              </div>

              {/* Sell */}
              <span className="text-[12px] leading-[18px] font-semibold text-[#FC5457] shrink-0">
                {sellRatio}% S
              </span>
            </div>
          )}
        </>
      )}

      {activeTab === "markettrades" && <MarketTrades />}
    </div>
  );
}
