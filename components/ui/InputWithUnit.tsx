import { BaseInput } from "./BaseInput";
import { useTheme } from "@/contexts/theme-context";

interface InputWithUnitProps {
  label?: string;
  placeholder: string;
  register?: any;
  name?: string;
  disabled?: boolean;
  rules?: any;
  suffixMode?: "static" | "dropdown";
  selectedSuffix?: string;
  value?: string;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  showMax?: boolean;
  onMax?: () => void;
  type?: string;
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
  value,
  onChange,
  showMax,
  onMax,
  type = "number",
}: InputWithUnitProps) {
  const { isDark } = useTheme();

  const registerProps = register && name ? register(name, rules) : {};

  return (
    <BaseInput label={label} disabled={disabled}>
      <input
        type={type}
        disabled={disabled}
        placeholder={placeholder}
        className={`
          flex-1 min-w-0 bg-transparent text-[12px] leading-[18px] font-medium
          outline-none
          disabled:text-[#9CA3AF]
          ${isDark ? "text-[#FFFFFF] placeholder:text-[#333333]" : "placeholder:text-[#C6C6C6]"}
        `}
        value={value}
        onChange={onChange}
        {...registerProps}
      />

      {showMax && onMax && (
        <button
          type="button"
          onClick={onMax}
          disabled={disabled}
          className={`px-1.5 py-0.5 rounded text-[10px] font-semibold text-[#703AE6] hover:text-[#8D61EB] cursor-pointer transition-colors ${
            disabled ? "opacity-40 cursor-not-allowed" : ""
          }`}
        >
          MAX
        </button>
      )}

      {suffixMode === "static" && selectedSuffix && (
        <span className={`text-[8px] leading-3 font-medium ${isDark ? "text-[#FFFFFF]" : "text-[#111111]"}`}>
          {selectedSuffix}
        </span>
      )}
    </BaseInput>
  );
}
