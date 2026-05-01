import { OrderHistoryType } from "@/lib/types";
import { Column, Table } from "../../ui/Table";
import cn from "classnames";
import { useTheme } from "@/contexts/theme-context";

export const orderHistoryColumns: Column<OrderHistoryType>[] = [
  {
    id: "dateTime",
    header: "Date/Time",
    render: (row) => {
      const [date, time] = row.dateTime.split(" ");
      return (
        <div className="flex flex-col">
          <span>{date}</span>
          <span>{time}</span>
        </div>
      );
    },
  },

  {
    id: "pair",
    header: "Pair",
    accessorKey: "pair",
  },

  {
    id: "type",
    header: "Type",
    accessorKey: "type",
  },

  {
    id: "side",
    header: "Side",
    accessorKey: "side",
  },

  {
    id: "orderQty",
    header: "Order Qty",
    accessorKey: "orderQty",
  },

  {
    id: "executedQty",
    header: "Executed Qty",
    accessorKey: "executedQty",
  },

  {
    id: "price",
    header: "Price (USDT)",
    render: (row) => row.price.toLocaleString(),
  },

  {
    id: "avgFillPrice",
    header: "Avg Fill Price",
    render: (row) => row.avgFillPrice.toLocaleString(),
  },

  {
    id: "takeProfit",
    header: "Take Profit",
    render: (row) =>
      row.takeProfit ? (
        <div className="flex flex-col">
          {row.takeProfit.map((tp) => (
            <span key={tp.label} className="pr-2 py-1">
              {tp.label}: {tp.value.toLocaleString()}
            </span>
          ))}
        </div>
      ) : (
        "-"
      ),
  },

  {
    id: "averageTPPrice",
    header: "Average TP Price",
    accessorKey: "averageTPPrice",
  },

  {
    id: "slTriggerPrice",
    header: "SL Trigger",
    accessorKey: "slTriggerPrice",
  },

  {
    id: "slLimit",
    header: "SL Limit",
    accessorKey: "slLimit",
  },

  {
    id: "trailPctOrUsd",
    header: "Trail(% or usd)",
    accessorKey: "trailPctOrUsd",
  },

  {
    id: "loop",
    header: "Loop",
    accessorKey: "loop",
  },

  {
    id: "gainPct",
    header: "Gain (%)",
    accessorKey: "gainPct",
  },

  {
    id: "gainUsd",
    header: "Gain (USD)",
    accessorKey: "gainUsd",
  },
  {
    id: "totalGainUsd",
    header: "Total Gain(usd)",
    render: (row) => row.totalGainUsd?.toLocaleString() ?? "-",
  },
  {
    id: "total",
    header: "Total",
    render: (row) => row.total?.toLocaleString() ?? "-",
  },

  {
    id: "triggerCondition",
    header: "Trigger Condition",
    accessorKey: "triggerCondition",
  },
  {
    id: "reduceOnly",
    header: "Reduce Only",
    accessorKey: "reduceOnly",
  },
  {
    id: "status",
    header: "Status",
    accessorKey: "status",
  },
  {
    id: "orderId",
    header: "Order Id",
    accessorKey: "orderId",
  },
];

export const orderHistoryData: OrderHistoryType[] = [
  {
    id: "hist-1",
    dateTime: "2025-10-23 14:25:46",
    pair: "BTC/USDT",
    type: "Conditional",
    side: "Buy",
    orderQty: "2.00 BTC",
    executedQty: "1.25 BTC",
    price: 60500,
    avgFillPrice: 60450,
    takeProfit: [
      { label: "Tp1", value: 61000 },
      { label: "Tp2", value: 61200 },
    ],
    averageTPPrice: "1.00 BTC",
    slTriggerPrice: 60000,
    slLimit: 59500,
    trailPctOrUsd: "-",
    loop: "3/10",
    gainPct: "0.08%",
    gainUsd: "$48.00",
    totalGainUsd: 9600.0,
    triggerCondition: "<=",
    total: "$150.00",
    status: "Partially Filled",
    orderId: "ORD-20251023-14512",
  },

  {
    id: "hist-2",
    dateTime: "2025-10-22 11:10:12",
    pair: "ETH/USDT",
    type: "Limit",
    side: "Sell",
    orderQty: "5.0 ETH",
    executedQty: "5.0 ETH",
    price: 3350,
    avgFillPrice: 3348,
    averageTPPrice: "1.00 BTC",
    trailPctOrUsd: "-",
    gainPct: "0.32%",
    gainUsd: "$54.20",
    total: "$54.20",
    status: "Filled",
    orderId: "ORD-20251023",
  },
  {
    id: "hist-2",
    dateTime: "2025-10-22 11:10:12",
    pair: "ETH/USDT",
    type: "Limit",
    side: "Sell",
    orderQty: "5.0 ETH",
    executedQty: "5.0 ETH",
    price: 3350,
    avgFillPrice: 3348,
    averageTPPrice: "1.00 BTC",
    trailPctOrUsd: "-",
    gainPct: "0.32%",
    gainUsd: "$54.20",
    total: "$54.20",
    status: "Filled",
    orderId: "ORD-20251023",
  },
  {
    id: "hist-2",
    dateTime: "2025-10-22 11:10:12",
    pair: "ETH/USDT",
    type: "Limit",
    side: "Sell",
    orderQty: "5.0 ETH",
    executedQty: "5.0 ETH",
    price: 3350,
    avgFillPrice: 3348,
    averageTPPrice: "1.00 BTC",
    trailPctOrUsd: "-",
    gainPct: "0.32%",
    gainUsd: "$54.20",
    total: "$54.20",
    status: "Filled",
    orderId: "ORD-20251023",
  },
  {
    id: "hist-2",
    dateTime: "2025-10-22 11:10:12",
    pair: "ETH/USDT",
    type: "Limit",
    side: "Sell",
    orderQty: "5.0 ETH",
    executedQty: "5.0 ETH",
    price: 3350,
    avgFillPrice: 3348,
    averageTPPrice: "1.00 BTC",
    trailPctOrUsd: "-",
    gainPct: "0.32%",
    gainUsd: "$54.20",
    total: "$54.20",
    status: "Filled",
    orderId: "ORD-20251023",
  },
  {
    id: "hist-2",
    dateTime: "2025-10-22 11:10:12",
    pair: "ETH/USDT",
    type: "Limit",
    side: "Sell",
    orderQty: "5.0 ETH",
    executedQty: "5.0 ETH",
    price: 3350,
    avgFillPrice: 3348,
    averageTPPrice: "1.00 BTC",
    trailPctOrUsd: "-",
    gainPct: "0.32%",
    gainUsd: "$54.20",
    total: "$54.20",
    status: "Filled",
    orderId: "ORD-20251023",
  },
];

export default function OrderHistoryTable() {
  const { isDark } = useTheme();
  return (
    <div className={`p-2 rounded-lg border ${isDark ? "border-[#333333] bg-[#222222]" : "border-[#E2E2E2] bg-[#F7F7F7]"}`}>
      <Table
        columns={orderHistoryColumns}
        data={orderHistoryData}
        getRowKey={(row) => row.id}
      />
    </div>
  );
}
