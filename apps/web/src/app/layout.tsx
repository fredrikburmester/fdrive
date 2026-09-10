import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "fdrive",
  description: "fdrive",
  applicationName: "fdrive",
  manifest: "/manifest.webmanifest",
  // The label iOS prints under a home-screen shortcut. Without it Safari
  // guesses from the page, which is how an installed shortcut ended up with
  // the wrong letter on its icon.
  appleWebApp: { capable: true, title: "fdrive", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full flex flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
