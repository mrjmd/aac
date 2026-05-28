import type { Metadata, Viewport } from "next";
import "./globals.css";
import LocationPermissionPrimer from "./location-permission-primer";
import MobileActionBar from "./mobile-action-bar";
import SessionHeader from "./session-header";

export const metadata: Metadata = {
  title: "AAC Field",
  description: "Attack A Crack — tech-facing job completion app",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon.png", type: "image/png" },
    ],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#1e6fb8",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const bypass = process.env.FIELD_AUTH_BYPASS_EMAIL;
  return (
    <html lang="en">
      <body>
        {bypass ? (
          <div className="bg-aac-yellow text-aac-dark px-4 py-1.5 text-center text-xs font-semibold">
            ⚠️ PREVIEW MODE — auth bypassed; acting as {bypass}
          </div>
        ) : null}
        <LocationPermissionPrimer />
        <SessionHeader />
        {/* Reserve bottom space for the sticky MobileActionBar so the last
            row of any page isn't trapped beneath it. Matches bar height
            (~58px) + safe-area inset on iOS. */}
        <div className="pb-[calc(env(safe-area-inset-bottom)+4.5rem)]">
          {children}
        </div>
        <MobileActionBar />
      </body>
    </html>
  );
}
