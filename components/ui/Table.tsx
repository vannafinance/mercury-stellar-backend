"use client";

import cn from "classnames";

export type Align = "left" | "center" | "right";

export type Column<T> = {
  // header label
  header: string;
  // unique id for each column
  id: string;
  // which field to show (optional if you use render)
  accessorKey?: keyof T;
  // custom cell rendering
  render?: (row: T) => React.ReactNode;
  className?: string;
  align?: Align;
};

export interface TableProps<T> {
  columns: Column<T>[];
  data: T[];
  // Unique key for each row
  getRowKey: (row: T, index: number) => string;
  className?: string;
  emptyText?: string;
}

export function Table<T>({
  columns,
  data,
  getRowKey,
  className,
  emptyText = "",
}: TableProps<T>) {
  return (
    <div
      className={cn(
        "w-full h-[340px]     overflow-x-auto overflow-y-auto scrollbar-hide ",
        className
      )}
    >
      <table className="min-w-full table-fixed border-separate border-spacing-y-2 ">
        {/* HEADER */}
        <thead className=" sticky top-0 z-20 bg-[#F7F7F7] ">
          <tr>
            {columns.map((col) => (
              <th
                key={col.id}
                className={cn(
                  "px-2 py-1 text-[12px] leading-[18px] h-8 font-medium text-[#919191] text-left whitespace-nowrap border-b border-[#E8E8E8]",
                  col.className ?? "min-w-[120px]",
                  col.align === "center" && "text-center",
                  col.align === "right" && "text-right"
                )}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>

        {/* BODY */}
        <tbody className="gap-2">
          {data.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                className="px-4 py-6 text-center text-xs text-[#919191]"
              >
                {emptyText}
              </td>
            </tr>
          ) : (
            data.map((row, index) => (
              <tr key={getRowKey ? getRowKey(row, index) : index}>
                {columns.map((col) => {
                  const content: React.ReactNode = col.render
                    ? col.render(row)
                    : col.accessorKey
                    ? String(row[col.accessorKey])
                    : null;

                  return (
                    <td
                      key={col.id}
                      className={cn(
                        "text-[12px] text-left leading-[18px] font-medium text-[#222222] px-2 py-1 align-top ",

                        col.className ?? "min-w-[120px]",
                        col.align === "center" && "text-center",
                        col.align === "right" && "text-right"
                      )}
                    >
                      {content}
                    </td>
                  );
                })}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
