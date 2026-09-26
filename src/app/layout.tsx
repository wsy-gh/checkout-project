import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Checkout Continuity",
  description: "Resume a ticket checkout across web and mobile without duplicate orders.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
