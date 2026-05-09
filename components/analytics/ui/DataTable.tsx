"use client";

import { cn } from "@/lib/analytics/utils";

export interface Column<T> {
  key: string;
  header: string;
  render?: (row: T, index: number) => React.ReactNode;
  align?: "left" | "center" | "right";
  className?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  onRowClick?: (row: T, index: number) => void;
  className?: string;
  emptyMessage?: string;
}

export default function DataTable<T extends Record<string, unknown>>({
  columns,
  data,
  onRowClick,
  className,
  emptyMessage = "No data available",
}: DataTableProps<T>) {
  const alignClass = (align?: "left" | "center" | "right") => {
    if (align === "center") return "text-center";
    if (align === "right") return "text-right";
    return "text-left";
  };

  return (
    <div
      className={cn(
        "overflow-hidden rounded-r4 shadow-vanna border border-vgray-100",
        className
      )}
    >
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-vgray-50">
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={cn(
                    "whitespace-nowrap px-4 py-3 text-xs font-semibold uppercase tracking-wider text-vgray-500",
                    alignClass(col.align),
                    col.className
                  )}
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {data.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-4 py-8 text-center text-vgray-400"
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              data.map((row, rowIdx) => (
                <tr
                  key={rowIdx}
                  onClick={() => onRowClick?.(row, rowIdx)}
                  className={cn(
                    "border-b border-vgray-100 transition-colors",
                    rowIdx % 2 === 0 ? "bg-surface" : "bg-vgray-50",
                    onRowClick &&
                      "cursor-pointer hover:bg-surface-hover"
                  )}
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={cn(
                        "whitespace-nowrap px-4 py-3 text-vgray-700",
                        alignClass(col.align),
                        col.className
                      )}
                    >
                      {col.render
                        ? col.render(row, rowIdx)
                        : (row[col.key] as React.ReactNode) ?? "—"}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
