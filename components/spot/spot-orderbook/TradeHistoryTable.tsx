import { TradeHistoryType } from "@/lib/types";
import { Column, Table } from "../../ui/Table";
import { useTheme } from "@/contexts/theme-context";

export const tradeHistoryColumns: Column<TradeHistoryType>[] = [
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
    header: "Pairs",
    accessorKey: "pair",
  },

  {
    id: "side",
    header: "Side",
    accessorKey: "side",
  },

  {
    id: "executedQty",
    header: "Executed Qty",
    accessorKey: "executedQty",
  },

  {
    id: "avgFilledPrice",
    header: "Avg Filled Price",
    accessorKey: "avgFilledPrice",
  },

  {
    id: "fee",
    header: "Fee",
    accessorKey: "fee",
  },

  {
    id: "role",
    header: "Role",
    accessorKey: "role",
  },

  {
    id: "total",
    header: "Total",
    accessorKey: "total",
  },
];

export const tradeHistoryData: TradeHistoryType[] = [
  {
    id: "trade-1",
    dateTime: "2025-10-23 14:25:46",
    pair: "BTC/USDT",
    side: "Buy",
    executedQty: "$59,980",
    avgFilledPrice: "ORD-2025-011245",
    fee: "0.0005 BTC",
    role: "Taker",
    total: "Filled",
  },
  {
    id: "trade-2",
    dateTime: "2025-10-23 13:58:12",
    pair: "ETH/USDT",
    side: "Sell",
    executedQty: "$12,450",
    avgFilledPrice: "ORD-2025-011246",
    fee: "0.003 ETH",
    role: "Maker",
    total: "Filled",
  },
  {
    id: "trade-3",
    dateTime: "2025-10-23 13:15:40",
    pair: "SOL/USDT",
    side: "Buy",
    executedQty: "$8,320",
    avgFilledPrice: "ORD-2025-011247",
    fee: "0.02 SOL",
    role: "Taker",
    total: "Filled",
  },
  {
    id: "trade-4",
    dateTime: "2025-10-23 12:42:05",
    pair: "BNB/USDT",
    side: "Buy",
    executedQty: "$6,780",
    avgFilledPrice: "ORD-2025-011248",
    fee: "0.01 BNB",
    role: "Maker",
    total: "Filled",
  },
  {
    id: "trade-5",
    dateTime: "2025-10-23 11:59:33",
    pair: "XRP/USDT",
    side: "Sell",
    executedQty: "$4,210",
    avgFilledPrice: "ORD-2025-011249",
    fee: "3.5 XRP",
    role: "Taker",
    total: "Filled",
  },
  {
    id: "trade-6",
    dateTime: "2025-10-23 11:10:18",
    pair: "ADA/USDT",
    side: "Buy",
    executedQty: "$3,950",
    avgFilledPrice: "ORD-2025-011250",
    fee: "6 ADA",
    role: "Maker",
    total: "Filled",
  },
  {
    id: "trade-7",
    dateTime: "2025-10-23 10:25:54",
    pair: "DOGE/USDT",
    side: "Buy",
    executedQty: "$2,100",
    avgFilledPrice: "ORD-2025-011251",
    fee: "45 DOGE",
    role: "Taker",
    total: "Filled",
  },
  {
    id: "trade-8",
    dateTime: "2025-10-23 09:40:09",
    pair: "AVAX/USDT",
    side: "Sell",
    executedQty: "$7,650",
    avgFilledPrice: "ORD-2025-011252",
    fee: "0.08 AVAX",
    role: "Maker",
    total: "Filled",
  },
  {
    id: "trade-9",
    dateTime: "2025-10-23 08:55:21",
    pair: "MATIC/USDT",
    side: "Buy",
    executedQty: "$1,980",
    avgFilledPrice: "ORD-2025-011253",
    fee: "12 MATIC",
    role: "Taker",
    total: "Filled",
  },
  {
    id: "trade-10",
    dateTime: "2025-10-23 08:10:47",
    pair: "DOT/USDT",
    side: "Sell",
    executedQty: "$5,430",
    avgFilledPrice: "ORD-2025-011254",
    fee: "0.15 DOT",
    role: "Maker",
    total: "Filled",
  },
];

export default function TradeHistoryTable() {
  const { isDark } = useTheme();
  return (
    <div className={`p-2 rounded-lg border ${isDark ? "border-[#333333] bg-[#222222]" : "border-[#E2E2E2] bg-[#F7F7F7]"}`}>
      <Table
        columns={tradeHistoryColumns}
        data={tradeHistoryData}
        getRowKey={(row) => row.id}
      />
    </div>
  );
}
