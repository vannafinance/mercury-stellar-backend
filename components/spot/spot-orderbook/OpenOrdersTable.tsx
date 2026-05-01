import Image from "next/image";
import { Column, Table } from "../../ui/Table";
import { OpenOrderType } from "@/lib/types";
import { useSpotTradeStore } from "@/store/spot-trade-store";
import { useState } from "react";
import { Modal } from "../../ui/modal";
import { LimitBracketModal } from "./LimitBracketModal";
import { EditBracketModal } from "./EditBracketModal";
import { useTheme } from "@/contexts/theme-context";

export default function OpenOrdersTable() {
  const { isDark } = useTheme();
  const openOrders = useSpotTradeStore((state) => state.openOrders);
  const [openLimitBracket, setOpenLimitBracket] = useState(false);
  const [openEditBracket, setOpenEditBracket] = useState(false);
  const openOrderColumns: Column<OpenOrderType>[] = [
    {
      id: "view",
      header: "View",
      className: "w-[60px]",
      render: () => (
        <div className="flex justify-center">
          <button
            className="cursor-pointer inline-flex  items-center justify-center "
            onClick={() => setOpenLimitBracket(true)}
          >
            <Image width={18} height={18} alt="icons" src="/icons/eye.svg" />
          </button>
        </div>
      ),
    },

    /* Date / Time */
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

    /* Pair */
    {
      id: "pair",
      header: "Pair",
      accessorKey: "pair",
    },

    /* Type */
    {
      id: "type",
      header: "Type",
      accessorKey: "type",
    },

    /* Side */
    {
      id: "side",
      header: "Side",
      accessorKey: "side",
    },

    /* Qty */
    {
      id: "qty",
      header: "Qty",
      accessorKey: "qty",
    },

    /* Price */
    {
      id: "price",
      header: "Price",
      accessorKey: "price",
      render: (row) => row.price.toLocaleString(),
    },

    /*  Take Profit */
    {
      id: "takeProfit",
      header: "Take Profit",
      render: (row) => (
        <div className="flex  flex-col ">
          {row.takeProfit.map((tp) => (
            <span key={tp.label} className="pr-2 py-1 ">
              {tp.label}= {tp.value.toLocaleString()}
            </span>
          ))}
        </div>
      ),
    },

    /* SL Trigger Price */
    {
      id: "slTriggerPrice",
      header: "SL Trigger Price",
      accessorKey: "slTriggerPrice",
    },

    /* SL Limit */
    {
      id: "slLimit",
      header: "SL Limit",
      accessorKey: "slLimit",
    },

    /* Trail */
    {
      id: "trail",
      header: "Trail (% or usd)",
      accessorKey: "trail",
    },

    /* Loop */
    {
      id: "loop",
      header: "Loop",
      accessorKey: "loop",
    },

    /* Trigger Conditions */
    {
      id: "triggerCondition",
      header: "Trigger Conditions",
      accessorKey: "triggerCondition",
    },

    /* Total */
    {
      id: "total",
      header: "Total",
      accessorKey: "total",
    },

    /* Actions */
    {
      id: "actions",
      header: "Action Button",
      render: () => (
        <div className="flex items-center justify-center gap-2">
          <button
            onClick={() => setOpenEditBracket(true)}
            className={`cursor-pointer inline-flex items-center justify-center rounded-md border-[0.75px] p-2 ${isDark ? "border-[#333333] bg-[#111111]" : "border-[#E2E2E2] bg-white"}`}
          >
            <Image
              className="object-cover"
              width={16}
              height={16}
              alt="icons"
              src="/icons/edit.svg"
            />
          </button>
          <button className={`cursor-pointer inline-flex items-center justify-center rounded-md border-[0.75px] p-2 ${isDark ? "border-[#333333] bg-[#111111]" : "border-[#E2E2E2] bg-white"}`}>
            <Image
              className="object-cover"
              width={16}
              height={16}
              alt="icons"
              src="/icons/delete.svg"
            />
          </button>
        </div>
      ),
    },
  ];
  return (
    <>
      <div className={`p-2 rounded-lg border ${isDark ? "border-[#333333] bg-[#222222]" : "border-[#E2E2E2] bg-[#F7F7F7]"}`}>
        <Table
          columns={openOrderColumns}
          data={openOrders}
          getRowKey={(row) => row.id}
        />
      </div>
      <Modal open={openLimitBracket} onClose={() => setOpenLimitBracket(false)}>
        <LimitBracketModal
          onEdit={() => {
            setOpenLimitBracket(false);
            setOpenEditBracket(true);
          }}
        />
      </Modal>
      <Modal open={openEditBracket} onClose={() => setOpenEditBracket(false)}>
        <EditBracketModal onClose={() => setOpenEditBracket(false)} />
      </Modal>
    </>
  );
}
