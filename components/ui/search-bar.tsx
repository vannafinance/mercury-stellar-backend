import { useTheme } from "@/contexts/theme-context";
import { SearchIcon } from "@/components/icons";

export const SearchBar = ({
  placeholder,
  onChange,
  value,
  compact,
}: {
  placeholder: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  value: string;
  compact?: boolean;
}) => {
  const { isDark } = useTheme();

  return (
    <div className={`border-[1px] flex items-center rounded-[8px] min-w-0 ${
      compact
        ? "h-[34px] gap-[6px] pr-[10px] py-[6px] pl-[10px] w-full"
        : "h-[48px] gap-[9px] pr-[24px] py-[8px] pl-[16px] w-full"
    } ${
      isDark
        ? "bg-[#111111]"
        : "bg-white"
    }`}>
      <div className={`flex items-center justify-center shrink-0 ${compact ? "w-[16px] h-[16px]" : "w-[24px] h-[24px]"}`}>
        <SearchIcon />
      </div>
      <input
        onChange={onChange}
        type="text"
        value={value}
        placeholder={`Search for ${placeholder}`}
        className={`placeholder:text-[#A7A7A7] flex-1 min-w-0 outline-none font-medium leading-none bg-transparent ${
          compact ? "text-[13px]" : "text-[14px]"
        } ${
          isDark ? "text-white" : "text-black"
        }`}
      />
    </div>
  );
};
