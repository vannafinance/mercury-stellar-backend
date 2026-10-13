"use client";

/**
 * /farm — V3 Farm screen: Blend single-asset reserves and Aquarius / Soroswap LP pools supplied
 * from the margin account (live data), plus the account's farm positions and history.
 * See components/farm/farm-list.tsx.
 */
import { FarmList } from "@/components/farm/farm-list";

export default function FarmPage() {
  return <FarmList />;
}
