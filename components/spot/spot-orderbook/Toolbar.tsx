import Image from "next/image";
import TimeframeSelector from "../../ui/TimeframeSelector";
import { useTheme } from "@/contexts/theme-context";

const Toolbar = () => {
  const { isDark } = useTheme();
  return (
    <div className="flex justify-between items-center rounded-t-lg gap-4">
      <div className="flex items-center justify-between gap-2">
        <TimeframeSelector />

        <div className="w-px h-4 border-r border-r-[#393F4F7A]"></div>

        <div className="flex justify-around item-center">
          <div className="py-1.5 px-2">
            <div className="w-4 h-4 items-center">
              <Image
                className="object-cover"
                width={100}
                height={100}
                alt="icons"
                src="/icons/candle.svg"
              />
            </div>
          </div>
          <div className="py-1.5 px-2">
            <div className="w-4 h-4 items-center">
              <Image
                className="object-cover"
                width={100}
                height={100}
                alt="icons"
                src="/icons/fx.svg"
              />
            </div>
          </div>
          <div className="py-1.5 px-2">
            <div className="w-4 h-4 items-center">
              <Image
                className="object-cover"
                width={100}
                height={100}
                alt="icons"
                src="/icons/edit.svg"
              />
            </div>
          </div>
          <div className="py-1.5 px-2">
            <div className="w-4 h-4 items-center">
              <Image
                className="object-cover"
                height={100}
                width={100}
                alt="icons"
                src="/icons/list.svg"
              />
            </div>
          </div>
          <div className="py-1.5 px-2">
            <div className="w-4 h-4 items-center">
              <Image
                className="object-cover"
                width={100}
                height={100}
                alt="icons"
                src="/icons/camera.svg"
              />
            </div>
          </div>
        </div>
      </div>
      <div className={`px-1 py-1 rounded-lg border flex items-center justify-around gap-1 text-sm leading-[18.86px] ${isDark ? "border-[#333333] bg-[#111111]" : "border-[#E2E2E2] bg-white"}`}>
        <button className="px-1  rounded-sm text-center bg-[#F1EBFD] text-[#703AE6] text-xs leading-[1.179rem]">
          Original
        </button>
        <button className="px-1 rounded-sm text-center text-[#6E7583] text-xs leading-[1.179rem]">
          TradingView
        </button>
        <button className="px-1 rounded-sm text-center text-[#6E7583] text-xs leading-[1.179rem]">
          Depth
        </button>
      </div>
    </div>
  );
};

export default Toolbar;
