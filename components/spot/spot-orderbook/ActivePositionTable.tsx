import Image from "next/image";
import cn from "classnames";
import { Column, Table } from "../../ui/Table";
import { ActivePositionType } from "@/lib/types";
import { useSpotTradeStore } from "@/store/spot-trade-store";
import { useTheme } from "@/contexts/theme-context";

export const activePositionsColumns: Column<ActivePositionType>[] = [
  {
    id: "view",
    header: "View",
    className: "w-[60px]",
    render: () => (
      <div className="flex justify-center">
        <button className="inline-flex items-center justify-center">
          <Image src="/icons/eye.svg" alt="view" width={18} height={18} />
        </button>
      </div>
    ),
  },

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
    id: "qty",
    header: "Qty",
    accessorKey: "qty",
  },

  {
    id: "estFilledPrice",
    header: "Est. Filled Price",
    accessorKey: "estFilledPrice",
  },

  {
    id: "takeProfit",
    header: "Take Profit",
    render: (row) =>
      row.takeProfit ? (
        <div className="flex flex-col">
          {row.takeProfit.map((tp) => (
            <span key={tp.label} className="pr-2 pb-1">
              {tp.label}= {tp.value.toLocaleString()}
            </span>
          ))}
        </div>
      ) : (
        "-"
      ),
  },

  {
    id: "slTriggerPrice",
    header: "SL Trigger Price",
    accessorKey: "slTriggerPrice",
  },

  {
    id: "slLimit",
    header: "SL Limit",
    accessorKey: "slLimit",
  },

  {
    id: "stopLimit",
    header: "Stop Limit",
    accessorKey: "stopLimit",
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
    id: "currentPnl",
    header: "Current PnL(% or usd)",
    render: (row) => (
      <span
        className={cn(
          "font-medium",
          row.currentPnlUsd?.startsWith("+") ? "text-green-600" : "text-red-600"
        )}
      >
        {row.currentPnlUsd} ({row.currentPnlPct})
      </span>
    ),
  },

  {
    id: "status",
    header: "Status",
    accessorKey: "status",
  },

  {
    id: "actions",
    header: "Action Button",
    render: () => (
      <div className="flex items-center justify-center gap-1">
        <button className="inline-flex items-center justify-center rounded-md border border-[#E2E2E2] p-2 bg-white">
          <Image
            src="/icons/action-button.svg"
            alt="edit"
            width={16}
            height={16}
          />
        </button>
        <button className="inline-flex items-center justify-center rounded-md border border-[#E2E2E2] p-2 bg-white">
          <Image src="/icons/edit.svg" alt="edit" width={16} height={16} />
        </button>
        <button className="inline-flex items-center justify-center rounded-md border border-[#E2E2E2] p-2 bg-white">
          <Image src="/icons/delete.svg" alt="delete" width={16} height={16} />
        </button>
      </div>
    ),
  },
];

export default function ActivePositionsTable() {
  const { isDark } = useTheme();
  const activePositions = useSpotTradeStore((state) => state.activePositions);
  return (
    <div className={`p-2 rounded-lg border ${isDark ? "border-[#333333] bg-[#222222]" : "border-[#E2E2E2] bg-[#F7F7F7]"}`}>
      <Table
        columns={activePositionsColumns}
        data={activePositions}
        getRowKey={(row) => row.id}
      />
    </div>
  );
}
