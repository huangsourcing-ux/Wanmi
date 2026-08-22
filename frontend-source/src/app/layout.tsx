import type { Metadata } from "next";
import "./globals.css";

const ASSETS = "/sites/www-dynadot-com-7f8c2392/root-8a5edab2";

export const metadata: Metadata = {
  title: "Wanmi.net｜中文域名工具与服务入口",
  description:
    "面向中文用户的域名查询、WHOIS、DNS、SSL、IDN 与 TLD 价格工具入口。",
  icons: {
    icon: [
      { url: `${ASSETS}/seo/favicon.svg`, type: "image/svg+xml" },
      { url: `${ASSETS}/seo/favicon-96x96.png`, sizes: "96x96" },
    ],
    apple: `${ASSETS}/seo/apple-touch-icon.png`,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="flex min-h-full flex-col bg-dyna-page font-sans text-dyna-navy">
        {children}
      </body>
    </html>
  );
}
