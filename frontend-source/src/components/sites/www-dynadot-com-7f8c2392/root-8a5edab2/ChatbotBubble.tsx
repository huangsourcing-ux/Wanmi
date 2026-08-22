import { ASSETS } from "./site-data";

/** Fixed overlay in the bottom-right corner of the viewport. */
export function ChatbotBubble() {
  return (
    <button
      type="button"
      aria-label="Open chat"
      className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-[#0A3D9A] shadow-[0_6px_24px_0_rgba(3,18,66,0.28)] transition-transform duration-300 hover:scale-105"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`${ASSETS}/images/chatbot-bubble.webp`}
        alt=""
        aria-hidden="true"
        width={28}
        height={26}
        className="h-[26px] w-auto select-none"
      />
    </button>
  );
}
