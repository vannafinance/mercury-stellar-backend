import { useTheme } from "@/contexts/theme-context";

const rewardsHeading = [
  "Reward Name",
  "Points",
  "USD",
  "",
];

const rewardsData = [
  { id: 1, name: "2k Assets", points: "100", rewards: "100" },
  { id: 2, name: "2k Assets", points: "100", rewards: "100" },
  { id: 3, name: "5k Assets", points: "100", rewards: "100" },
];

export const RewardsTable = () => {
  const { isDark } = useTheme();

  return (
    <section
      className={`w-full h-full rounded-[16px] border overflow-hidden flex flex-col ${
        isDark ? "bg-[#222222] border-[#333333]" : "bg-[#F7F7F7] border-[#E5E7EB]"
      }`}
      aria-label="Rewards Summary"
    >
      <div className={`px-5 pt-5 pb-4 border-b shrink-0 ${isDark ? "border-[#333333]" : "border-[#e5e7eb]"}`}>
        <h2 className={`text-[16px] font-bold ${isDark ? "text-white" : "text-[#0f172a]"}`}>
          Rewards
        </h2>
      </div>

      <table className="w-full flex-1 min-h-0 flex flex-col px-5 pb-4" aria-label="Claimable Rewards">
        <thead className="shrink-0">
          <tr className="w-full flex items-center pt-3 pb-1">
            {rewardsHeading.map((heading) => (
              <th
                key={heading}
                className={`w-full flex items-center whitespace-nowrap justify-start text-[12px] font-medium ${
                  isDark ? "text-[#919191]" : "text-[#6b7280]"
                }`}
              >
                {heading}
              </th>
            ))}
          </tr>
        </thead>

        <tbody className="flex-1 flex flex-col justify-between min-h-0">
          {rewardsData.map((reward, idx) => (
            <tr
              key={idx}
              className="cursor-pointer w-full flex hover:bg-[#F1EBFD] rounded-[8px] items-center group py-[7px]"
            >
              <td className={`w-full text-[14px] font-medium flex items-center ${
                isDark ? "text-white group-hover:text-[#090909]" : "text-[#111]"
              }`}>
                {reward.name}
              </td>
              <td className={`w-full text-[14px] font-medium flex items-center ${
                isDark ? "text-white group-hover:text-[#090909]" : "text-[#111]"
              }`}>
                {reward.points}
              </td>
              <td className={`w-full text-[14px] font-medium flex items-center ${
                isDark ? "text-white group-hover:text-[#090909]" : "text-[#111]"
              }`}>
                {reward.rewards}
              </td>
              <td className="w-full text-[14px] font-medium flex items-center justify-end">
                <button
                  type="button"
                  className="px-4 py-[5px] rounded-[8px] text-[12px] font-semibold bg-[#703AE6] text-white hover:bg-[#6635D1] transition cursor-pointer whitespace-nowrap"
                >
                  Claim
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
};
