import { PillButton } from "../shared/PillButton";
import { SECTION_CTAS } from "./site-data";

export function ContactCta() {
  return (
    <div className="inline-flex w-full items-center justify-center bg-[radial-gradient(48.77%_100%_at_50%_0%,#C5DDFF_0%,#EBF3FF_100%)]">
      {/* Source inner container: padding 80px 120px, gap 300px, height 245px */}
      <div className="flex w-full max-w-1440 flex-col items-center justify-center gap-7 px-7 py-16 text-center md:flex-row md:px-14 lg:gap-[300px] lg:px-[120px] lg:py-20">
        <p className="font-heading text-[24px] leading-[1.3] text-dyna-navy md:text-[28px]">
          有问题？联系我们，或提交反馈与需求。
        </p>
        <div className="group shrink-0">
          <PillButton href={SECTION_CTAS.contact.href}>
            {SECTION_CTAS.contact.label}
          </PillButton>
        </div>
      </div>
    </div>
  );
}
