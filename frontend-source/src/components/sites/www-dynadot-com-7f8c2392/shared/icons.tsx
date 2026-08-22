import { cn } from "@/lib/utils";

type IconProps = {
  className?: string;
};

export function ChevronDownIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={cn("h-4 w-4", className)}
    >
      <path
        d="M4 6l4 4 4-4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SearchIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn("h-6 w-6", className)}
    >
      <circle
        cx="11"
        cy="11"
        r="7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M16.5 16.5L21 21"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ArrowRightIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn("h-4 w-4", className)}
    >
      <path
        d="M5 12h14m0 0l-5.5-5.5M19 12l-5.5 5.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function UserIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn("h-4 w-4", className)}
    >
      <circle cx="12" cy="8" r="3.6" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M4.8 20a7.2 7.2 0 0114.4 0"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function CartIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn("h-4 w-4", className)}
    >
      <path
        d="M3 4h2.2l2.1 10.2h9.8l1.9-7.2H6.4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="9.5" cy="18.5" r="1.5" fill="currentColor" />
      <circle cx="16.5" cy="18.5" r="1.5" fill="currentColor" />
    </svg>
  );
}

export function CloseIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn("h-4 w-4", className)}
    >
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function MenuIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn("h-6 w-6", className)}
    >
      <path
        d="M4 7h16M4 12h16M4 17h16"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** `fa fa-angle-right` — the chevron used inside every CTA on the source. */
export function AngleRightIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn("h-5 w-5", className)}
    >
      <path
        d="M9 5l7 7-7 7"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function AlarmClockIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn("h-2.5 w-2.5", className)}
    >
      <circle cx="12" cy="13" r="8" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M12 9.5V13l2.5 1.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4.5 4.5l2.5-2M19.5 4.5L17 2.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ChevronLeftIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn("h-5 w-5", className)}
    >
      <path
        d="M15 5l-7 7 7 7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ChevronRightIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn("h-5 w-5", className)}
    >
      <path
        d="M9 5l7 7-7 7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function GoogleIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={cn("h-5 w-5", className)}>
      <path fill="#4285F4" d="M22.5 12.2c0-.7-.1-1.4-.2-2.1H12v4h5.9a5 5 0 01-2.2 3.3v2.7h3.6c2.1-2 3.2-4.9 3.2-8z" />
      <path fill="#34A853" d="M12 23c2.9 0 5.4-1 7.2-2.6l-3.6-2.7c-1 .7-2.2 1-3.6 1-2.8 0-5.1-1.9-6-4.4H2.3v2.8A11 11 0 0012 23z" />
      <path fill="#FBBC05" d="M6 14.3a6.6 6.6 0 010-4.2V7.3H2.3a11 11 0 000 9.8L6 14.3z" />
      <path fill="#EA4335" d="M12 5.4c1.6 0 3 .5 4.1 1.6l3.1-3.1A11 11 0 002.3 7.3L6 10.1c.9-2.6 3.2-4.5 6-4.5z" />
    </svg>
  );
}

/**
 * WeChat mark. WeChat/Tencent's logo is a trademark; this is a simplified,
 * recognisable two-bubble glyph in WeChat green used as a social-login
 * affordance, not the exact brand vector.
 */
export function WeChatIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={cn("h-5 w-5", className)}>
      <path
        fill="#07C160"
        d="M8.7 3C4.6 3 1.3 5.8 1.3 9.3c0 2 1.1 3.8 2.8 5L3.2 17l2.9-1.5c.6.2 1.2.3 1.9.4a5 5 0 01-.2-1.4c0-3.2 3-5.7 6.8-5.7l.7.0C14.6 5.2 12 3 8.7 3zM6.3 8.1a.9.9 0 110-1.8.9.9 0 010 1.8zm4.9 0a.9.9 0 110-1.8.9.9 0 010 1.8z"
      />
      <path
        fill="#07C160"
        d="M22.7 14c0-2.9-2.8-5.2-6.2-5.2s-6.2 2.3-6.2 5.2 2.8 5.2 6.2 5.2c.7 0 1.4-.1 2-.3l2.2 1.2-.6-2c1.6-1 2.6-2.5 2.6-4.1zm-8.2-.9a.75.75 0 110-1.5.75.75 0 010 1.5zm4.1 0a.75.75 0 110-1.5.75.75 0 010 1.5z"
      />
    </svg>
  );
}

export function EyeIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={cn("h-[18px] w-[18px]", className)}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

export function EyeOffIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={cn("h-[18px] w-[18px]", className)}>
      <path d="M4 4l16 16M10.6 10.7a3 3 0 004.2 4.2M9.4 5.3A9.8 9.8 0 0112 5c6.5 0 10 7 10 7a17 17 0 01-3.3 4M6.2 7.3A17 17 0 002 12s3.5 7 10 7c1 0 2-.2 2.8-.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function QrCodeIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={cn("h-4 w-4", className)}>
      <path d="M3 3h8v8H3V3zm2 2v4h4V5H5zm-2 8h8v8H3v-8zm2 2v4h4v-4H5zM13 3h8v8h-8V3zm2 2v4h4V5h-4zm-2 8h2v2h-2v-2zm0 4h2v2h-2v-2zm4-4h2v2h-2v-2zm2 2h2v2h-2v-2zm-2 2h2v2h-2v-2zm2 2h2v2h-2v-2z" />
    </svg>
  );
}

/** `fa-regular fa-circle-plus` — the FAQ accordion toggle, 20px. */
export function CirclePlusIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn("h-5 w-5", className)}
    >
      <circle cx="12" cy="12" r="9.25" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M12 7.75v8.5M7.75 12h8.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Footer social row — 16px glyphs at a 30px pitch. */
export function FacebookIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={cn("h-4 w-4", className)}>
      <path d="M14 8.5V6.8c0-.7.2-1.1 1.2-1.1H16V3.1c-.3 0-1-.1-1.9-.1-2 0-3.3 1.2-3.3 3.4v2.1H8.6V11H10.8v8h2.6v-8h2.2l.3-2.5H14z" />
    </svg>
  );
}

export function LinkedInIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={cn("h-4 w-4", className)}>
      <path d="M6.2 8.6H3.6V19h2.6V8.6zM4.9 4.2a1.6 1.6 0 100 3.2 1.6 1.6 0 000-3.2zM19 19h-2.6v-5.3c0-1.4-.6-2.1-1.6-2.1-1 0-1.6.7-1.6 2.1V19h-2.6V8.6h2.5v1.1c.5-.8 1.4-1.4 2.6-1.4 2 0 3.3 1.3 3.3 3.9V19z" />
    </svg>
  );
}

export function XIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={cn("h-4 w-4", className)}>
      <path d="M17.5 3h3l-6.6 7.5L21.5 21h-5.8l-4.5-5.9L5.9 21H2.8l7-8L2.2 3H8l4.1 5.4L17.5 3zm-1 16h1.7L7.6 4.7H5.8L16.5 19z" />
    </svg>
  );
}

export function YoutubeIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={cn("h-4 w-4", className)}>
      <path d="M21.6 7.2c-.2-.9-.9-1.6-1.8-1.8C18.2 5 12 5 12 5s-6.2 0-7.8.4c-.9.2-1.6.9-1.8 1.8C2 8.8 2 12 2 12s0 3.2.4 4.8c.2.9.9 1.6 1.8 1.8C5.8 19 12 19 12 19s6.2 0 7.8-.4c.9-.2 1.6-.9 1.8-1.8.4-1.6.4-4.8.4-4.8s0-3.2-.4-4.8zM10 15.1V8.9l5.2 3.1L10 15.1z" />
    </svg>
  );
}

export function ChatIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={cn("h-4 w-4", className)}>
      <path d="M12 3C6.9 3 3 6.6 3 11c0 2.5 1.3 4.7 3.3 6.1V21l3.1-1.7c.8.2 1.7.3 2.6.3 5.1 0 9-3.6 9-8s-3.9-8.6-9-8.6z" />
    </svg>
  );
}

export function PlusIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cn("h-5 w-5", className)}
    >
      <path
        d="M12 5v14M5 12h14"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function HelpFilesIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      className={cn("h-11 w-11", className)}
    >
      <rect
        x="9"
        y="6"
        width="24"
        height="34"
        rx="3"
        stroke="currentColor"
        strokeWidth="2.6"
      />
      <path
        d="M16 16h10M16 23h10M16 30h6"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      <path
        d="M37 12v26a4 4 0 01-4 4H15"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function BlogIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      className={cn("h-11 w-11", className)}
    >
      <path
        d="M8 12a4 4 0 014-4h17l11 11v21a4 4 0 01-4 4H12a4 4 0 01-4-4V12z"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinejoin="round"
      />
      <path
        d="M28 8v12h12"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinejoin="round"
      />
      <path
        d="M16 28h16M16 35h11"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ForumIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      className={cn("h-11 w-11", className)}
    >
      <path
        d="M6 13a4 4 0 014-4h20a4 4 0 014 4v11a4 4 0 01-4 4H17l-8 6v-6a3 3 0 01-3-3V13z"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinejoin="round"
      />
      <path
        d="M38 18h1a3 3 0 013 3v11a3 3 0 01-3 3v6l-7-6h-8"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function AppleIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={cn("h-5 w-5", className)}
    >
      <path d="M16.4 12.6c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.9-1.4-.1-2.8.9-3.5.9s-1.8-.9-3-.8c-1.5 0-2.9.9-3.7 2.2-1.6 2.8-.4 6.9 1.1 9.1.8 1.1 1.7 2.3 2.9 2.3s1.6-.7 3.1-.7 1.9.7 3.1.7 2.1-1.1 2.9-2.2c.9-1.3 1.3-2.5 1.3-2.6 0 0-2.4-.9-2.4-3.6zM14.2 5.9c.6-.8 1.1-1.9 1-3-.9 0-2.1.6-2.8 1.4-.6.7-1.2 1.8-1 2.9 1 .1 2.1-.5 2.8-1.3z" />
    </svg>
  );
}

export function AndroidIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={cn("h-5 w-5", className)}
    >
      <path d="M3.6 20.5V9.9c0-.7.5-1.2 1.2-1.2s1.2.5 1.2 1.2v10.6c0 .7-.5 1.2-1.2 1.2s-1.2-.5-1.2-1.2zm15.6 0V9.9c0-.7.5-1.2 1.2-1.2s1.2.5 1.2 1.2v10.6c0 .7-.5 1.2-1.2 1.2s-1.2-.5-1.2-1.2zM7 8.4h10v10.9c0 .7-.5 1.2-1.2 1.2h-.9v2.3c0 .7-.5 1.2-1.2 1.2s-1.2-.5-1.2-1.2v-2.3h-1.2v2.3c0 .7-.5 1.2-1.2 1.2s-1.2-.5-1.2-1.2v-2.3h-.9c-.7 0-1.2-.5-1.2-1.2V8.4zM7.1 7.3c.1-1.7 1.1-3.1 2.6-3.9l-1-1.8c-.1-.2 0-.4.1-.5.2-.1.4 0 .5.1l1 1.9c.5-.2 1.1-.3 1.7-.3s1.2.1 1.7.3l1-1.9c.1-.2.3-.2.5-.1.2.1.2.3.1.5l-1 1.8c1.5.8 2.5 2.2 2.6 3.9H7.1zm2.8-2.1c0-.3-.3-.6-.6-.6s-.6.3-.6.6.3.6.6.6.6-.3.6-.6zm5 0c0-.3-.3-.6-.6-.6s-.6.3-.6.6.3.6.6.6.6-.3.6-.6z" />
    </svg>
  );
}

/**
 * Dynadot brand mark. The wordmark on the source page is a trademarked inline
 * SVG; here the downloaded favicon supplies the glyph and the wordmark is set
 * in the site's display face so the 146x34 navbar slot matches exactly.
 */
export function LogoIcon({ className }: IconProps) {
  return (
    // Source logo occupies exactly 146x34 in the navbar slot.
    <span
      className={cn(
        "inline-flex h-[34px] w-[146px] items-center gap-2 text-[#EBF3FF]",
        className,
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/sites/www-dynadot-com-7f8c2392/root-8a5edab2/seo/favicon.svg"
        alt=""
        aria-hidden="true"
        width={34}
        height={34}
        className="h-[34px] w-[34px] shrink-0"
      />
      <span className="font-heading text-[28px] leading-none tracking-[-0.5px]">
        dynadot
      </span>
    </span>
  );
}
