"use client";

import { AddressBadge } from "@/components/ui/address-badge";

interface MarginAccountAddressProps {
  /** Margin account contract address. When null, the component renders nothing. */
  address: string | null;
  className?: string;
  /** Explorer network the copyable badge links into. Defaults to testnet. */
  network?: "testnet" | "public";
}

/**
 * Thin label wrapper around {@link AddressBadge} for a margin account address.
 * Renders an "Account:"-prefixed, copyable badge with an explorer link, and
 * short-circuits to null when no address is available so callers can mount it
 * unconditionally.
 */
export const MarginAccountAddress = ({
  address,
  className = "",
  network = "public",
}: MarginAccountAddressProps) => {
  if (!address) return null;

  return (
    <AddressBadge
      address={address}
      label="Account:"
      network={network}
      className={className}
    />
  );
};
