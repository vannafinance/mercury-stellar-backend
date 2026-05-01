import { Button } from "../ui/button";

const supplyApyPopupItem = [
  {
    title: "Organic APY",
    description: "Yield from lending funds",
    oneDay: "0.60%",
    sevenDay: "0.54%",
  },
  {
    title: "WMON Incentive",
    description: "Calculated at the current rate",
    oneDay: "9.48%",
    sevenDay: "0.54%",
  },
];

interface SupplyApyPopupProps {
  onClose?: () => void;
}

export const SupplyApyPopup = ({ onClose }: SupplyApyPopupProps) => {
  return (
    <article 
      className="shadow-md w-[349px] h-fit rounded-[12px] p-[16px] flex flex-col gap-[16px] bg-[#FFFFFF]"
      aria-label="Supply APY Breakdown"
    >
      <section className="w-full h-fit flex flex-col gap-[12px]">
        <header className="w-full h-fit flex justify-between items-center border-[1px] bg-[#F7F7F7] p-[12px] rounded-[8px]">
          <h2 className="text-[10px] font-medium w-full">APY TYPE</h2>
          <div className="w-[137.5px] h-fit flex justify-between items-center">
            <h3 className="text-[10px] font-medium w-full">1D</h3>
            <h3 className="text-[10px] font-medium w-full">7D</h3>
          </div>
        </header>
        <dl className="w-full h-fit flex flex-col gap-[4px]">
          {supplyApyPopupItem.map((item) => {
            return (
              <div
                key={item.title}
                className="w-full h-fit rounded-[8px] flex justify-between items-center py-[8px] px-[12px] bg-[#FBFBFB]"
              >
                <div className="w-full h-fit flex flex-col gap-[4px]">
                  <dt className="w-full text-[10px] font-semibold">
                    {item.title}
                  </dt>
                  <dd className="w-full text-[10px] font-medium text-[#5C5B5B]">
                    {item.description}
                  </dd>
                </div>
                <div className="flex justify-between items-center w-[137.5px] h-fit">
                  <dd className="text-[10px] font-semibold w-full">
                    {item.oneDay}
                  </dd>
                  <dd className="text-[10px] font-semibold w-full">
                    {item.sevenDay}
                  </dd>
                </div>
              </div>
            );
          })}
        </dl>
        <hr className="w-[317px] h-px bg-[#E2E2E2] border-0" />
        <div className="w-full h-fit flex justify-between items-center">
          <strong className="text-[10px] font-semibold w-full">Overall APY</strong>
          <div className="flex justify-between items-center w-[137.5px] h-fit">
            <strong className="text-[10px] font-semibold w-full">10.08%</strong>
            <strong className="text-[10px] font-semibold w-full">10.02%</strong>
          </div>
        </div>
      </section>
      <footer>
        <Button
          text="Close"
          size="small"
          type="ghost"
          disabled={false}
          onClick={onClose || (() => {})}
        />
      </footer>
    </article>
  );
};
