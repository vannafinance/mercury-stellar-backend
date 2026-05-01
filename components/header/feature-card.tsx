"use client";

import Image from "next/image";

interface FeatureCardProps {
  icon: string;
  title: string;
  subtitle: string;
  isSoon?: boolean;
}

const FeatureCard: React.FC<FeatureCardProps> = ({
  icon,
  title,
  subtitle,
  isSoon,
}) => {
  return (
    <div className="bg-white dark:bg-[#111111] rounded-lg px-2 py-3 flex items-start space-x-2 hover:bg-neutral-100 dark:hover:bg-[#1E1E1E] transition-colors">
      <Image
        width={24}
        height={24}
        src={icon}
        alt={title + " menu icon"}
        className="mt-1"
      />
      <div>
        <h3 className="text-sm text-[#111111] dark:text-[#F1EBFD]">
          {title}{" "}
          {isSoon && (
            <span className="py-0.5 px-1 bg-gradient-to-r from-[#FF007A] to-[#703AE6] text-xs rounded-md text-white">
              soon
            </span>
          )}
        </h3>
        <p className="text-xs text-neutral-500">{subtitle}</p>
      </div>
    </div>
  );
};

export default FeatureCard;
