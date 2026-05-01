import { OrderBookRowType } from "./OrderBook";
import { useTheme } from "@/contexts/theme-context";

export const OrderBookRow = ({
  row,
  maxTotal,
}: {
  row: OrderBookRowType;
  maxTotal: number;
}) => {
  const { isDark } = useTheme();
  const depth = maxTotal ? (row.total / maxTotal) * 100 : 0;

  return (
    <div className={`relative grid grid-cols-3 text-[10px] leading-[15px] font-medium overflow-hidden py-1 ${isDark ? "text-[#FFFFFF]" : ""}`}>
      {/* Depth Bar */}
      <div
        className={`absolute inset-y-0 right-0 transition-[width] duration-150 ease-linear ${
          row.side === "sell"
            ? isDark ? "bg-[#FC5457]/20" : "bg-[#f0d2cb]"
            : isDark ? "bg-[#1C7C83]/20" : "bg-[#c9dfde]"
        }`}
        style={{ width: `${depth}%` }}
      />

      {/* Price */}
      <span
        className={`relative z-10  ${
          row.side === "sell" ? "text-[#FC5457]" : "text-[#1C7C83]"
        }`}
      >
        {row.price.toLocaleString()}
      </span>

      {/* Amount */}
      <span className="relative z-10 text-right">
        {row.amount.toLocaleString()}
      </span>

      {/* Total */}
      <span className="relative z-10   text-right">
        {row.total.toLocaleString()}
      </span>
    </div>
  );
};
