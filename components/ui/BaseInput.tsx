interface BaseInputProps {
  label?: string;
  children: React.ReactNode;
  disabled?: boolean;
}

export function BaseInput({ label, children, disabled }: BaseInputProps) {
  return (
    <div className="flex flex-col gap-1 min-w-0">
      {label && (
        <label className="text-[10px] leading-[15px] text-[#111111] font-medium">
          {label}
        </label>
      )}

      <div
        className={`h-9 flex items-center rounded-lg border border-[#E2E2E2]  px-2  ${
          disabled ? "bg-[#F4F4F4] " : "bg-white "
        }`}
      >
        {children}
      </div>
    </div>
  );
}
