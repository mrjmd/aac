import type { Metadata, Viewport } from "next";
import "./globals.css";
import LocationPermissionPrimer from "./location-permission-primer";
import SessionHeader from "./session-header";

export const metadata: Metadata = {
  title: "AAC Field",
  description: "Attack A Crack — tech-facing job completion app",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#facc15",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <LocationPermissionPrimer />
        <SessionHeader />
        {children}
      </body>
    </html>
  );
}
