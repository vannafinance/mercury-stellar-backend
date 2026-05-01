import OrderPlacementForm from "./OrderPlacementForm";
import { useTheme } from "@/contexts/theme-context";

interface EditBracketModalProps {
  onClose: () => void;
}
export const EditBracketModal = ({ onClose }: EditBracketModalProps) => {
  const { isDark } = useTheme();
  return (
    <div className={`flex flex-col gap-5 rounded-[20px] border max-h-[749px] ${isDark ? "bg-[#222222] border-[#333333]" : "bg-[#F7F7F7] border-[#E2E2E2]"}`}>
      <div className={`text-[24px] leading-9 font-bold px-5 pt-5 ${isDark ? "text-[#FFFFFF]" : "text-[#111111]"}`}>
        Edit Bracket
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-hide">
        <OrderPlacementForm mode="edit" onCancel={onClose} />
      </div>
    </div>
  );
};
