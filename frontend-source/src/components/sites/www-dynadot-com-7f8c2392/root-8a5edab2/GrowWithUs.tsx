import { PillButton } from "../shared/PillButton";
import { BlogIcon, ForumIcon, HelpFilesIcon } from "../shared/icons";
import { RESOURCE_CARDS } from "./site-data";

const ICONS = [HelpFilesIcon, BlogIcon, ForumIcon];

export function GrowWithUs() {
  return (
    <div className="inline-flex w-full flex-col items-center justify-center gap-10 bg-dyna-indigo-50 px-[30px] py-20 md:gap-14 md:px-[58px] md:py-[90px] xl:gap-[60px] xl:p-[120px]">
      <div className="flex max-w-[820px] flex-col items-center gap-5 text-center">
        <h2 className="font-heading text-[32px] leading-[1.2] tracking-[-0.4px] text-dyna-navy md:text-[48px] md:leading-[52.8px]">
          Grow With Us
        </h2>
        <p className="text-base leading-[26px] text-dyna-navy/80 md:text-lg">
          Learn how to register, manage, and grow your online presence with our
          expert resources.
        </p>
      </div>

      <div className="grid w-full max-w-1440 grid-cols-1 gap-6 md:grid-cols-3">
        {RESOURCE_CARDS.map((card, i) => {
          const Icon = ICONS[i];
          return (
            <div
              key={card.title}
              className="flex flex-col items-start gap-4 rounded-3xl bg-white p-8 shadow-[0_4px_24px_0_rgba(3,18,66,0.06)] lg:min-h-[446px] lg:p-10"
            >
              {/* Source icon plate: 64x64 rounded tile */}
              <span className="relative flex h-16 w-16 items-center justify-center overflow-hidden rounded-2xl bg-[#EBF3FF]">
                <Icon className="h-8 w-8 text-[#0A3D9A]" />
              </span>
              <h3 className="font-heading text-[24px] leading-[1.25] text-dyna-navy">
                {card.title}
              </h3>
              <p className="text-[15px] leading-[24px] text-dyna-navy/80">
                {card.body}
              </p>
              <div className="group mt-auto pt-2">
                <PillButton variant="link">
                  {card.cta}
                </PillButton>
              </div>
            </div>
          );
        })}
      </div>

      <div className="group">
        <PillButton>Discover Our Resources</PillButton>
      </div>
    </div>
  );
}
