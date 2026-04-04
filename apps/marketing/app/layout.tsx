import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AAC Marketing Engine",
  description: "Attack A Crack content production & campaign management",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
