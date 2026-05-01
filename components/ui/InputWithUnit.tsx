import { BaseInput } from "./BaseInput";
import { useTheme } from "@/contexts/theme-context";

interface InputWithUnitProps {
  label?: string;
  placeholder: string;
  register: any;
  name: string;
  disabled?: boolean;
  rules?: any;
  suffixMode?: "static" | "dropdown";
  selectedSuffix?: string;
}

export function InputWithUnit({
  label,
  placeholder,
  register,
  name,
  disabled,
  rules,
  suffixMode = "static",
  selectedSuffix,
}: InputWithUnitProps) {
  const { isDark } = useTheme();

  return (
    <BaseInput label={label} disabled={disabled}>
      <input
        type="number"
        disabled={disabled}
        placeholder={placeholder}
        className={`
          flex-1 min-w-0 bg-transparent text-[12px] leading-[18px] font-medium
          outline-none
          disabled:text-[#9CA3AF]
          ${isDark ? "text-[#FFFFFF] placeholder:text-[#333333]" : "placeholder:text-[#C6C6C6]"}
        `}
        {...register(name, rules)}
      />

      {suffixMode === "static" && selectedSuffix && (
        <span className={`text-[8px] leading-3 font-medium ${isDark ? "text-[#FFFFFF]" : "text-[#111111]"}`}>
          {selectedSuffix}
        </span>
      )}
    </BaseInput>
  );
}
