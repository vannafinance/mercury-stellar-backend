import { BaseInput } from "./BaseInput";

interface InputWithoutUnitProps {
  label: string;
  placeholder: string;
  register: any;
  name: string;
  disabled?: boolean;
  rules?: any;
}

export function InputWithoutUnit({
  label,
  placeholder,
  register,
  name,
  disabled,
  rules,
}: InputWithoutUnitProps) {
  return (
    <BaseInput label={label} disabled={disabled}>
      <input
        type="number"
        disabled={disabled}
        placeholder={placeholder}
        className="
          w-full bg-transparent text-[12px] leading-[18px] font-medium
          outline-none placeholder:text-[#C6C6C6]
          disabled:text-[#9CA3AF]
        "
        {...register(name, rules)}
      />
    </BaseInput>
  );
}
