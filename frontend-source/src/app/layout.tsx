import type { Metadata } from "next";
import "./globals.css";

const ASSETS = "/sites/www-dynadot-com-7f8c2392/root-8a5edab2";

export const metadata: Metadata = {
  title: "Register, Buy & Manage Domain Names Online | Dynadot",
  description:
    "Search 800+ domain extensions, register names at transparent prices, and manage DNS, privacy, email, transfers, renewals, and domain portfolios in Dynadot.",
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
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col bg-dyna-page font-sans text-dyna-navy">
        {children}
      </body>
    </html>
  );
}
