import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "bootstrap/dist/css/bootstrap.min.css";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Basic Scanner — CIS Auditing",
  description: "Scan assets against CIS benchmarks over SSH",
};

/**
 * No-flash theme bootstrap. Runs before hydration to set `data-bs-theme` on
 * <html> from the saved preference (defaulting to the OS color-scheme), so
 * Bootstrap and our CSS tokens resolve to the correct palette on the very
 * first paint. Kept as an inline string so it is a blocking, render-tier
 * script and never leaks server data.
 */
const themeInitScript = `(function(){try{var t=localStorage.getItem('theme');if(t!=='light'&&t!=='dark'){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.setAttribute('data-bs-theme',t);}catch(e){document.documentElement.setAttribute('data-bs-theme','light');}})();`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      data-bs-theme="light"
      className={`${geistSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

