import type { Metadata } from "next";
import "./globals.css";
import { THEME_INIT_SCRIPT } from "@/lib/theme";

// System font stack - avoids the Google Fonts fetch that blocks dev-server
// startup when egress to fonts.googleapis.com is slow or blocked. Modern OS
// UI fonts (SF Pro, Segoe UI Variable, Roboto) render the design well.
const SYSTEM_SANS =
  '-apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif';

export const metadata: Metadata = {
  title: "Cold Outreach Command Center - Developer outreach, from lead to reply",
  description:
    "Cold Outreach Command Center surfaces every contact for a developer profile - emails, phones, and links - then runs two-step outreach that lands in the inbox.",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/app-icon.png", type: "image/png" },
    ],
    apple: "/app-icon.png",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // data-theme is set by THEME_INIT_SCRIPT before React hydrates, so the
    // server markup can't match it — hence suppressHydrationWarning.
    <html
      lang="en"
      data-theme="dark"
      suppressHydrationWarning
      style={{ ["--font-sans" as string]: SYSTEM_SANS }}
    >
      <head>
        {/* Applies the saved (or OS) theme before first paint — no flash.
            A raw inline script runs while the HTML is parsed; next/script's
            beforeInteractive is deferred until Next's runtime boots in the
            App Router, which can paint the wrong theme first. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body
        className="h-screen w-screen font-sans antialiased"
        suppressHydrationWarning
        style={{ fontFamily: "var(--font-sans)" }}
      >
        {children}
      </body>
    </html>
  );
}
