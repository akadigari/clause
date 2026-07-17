import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Clause: read the fine print for you",
  description:
    "Upload a confusing document, ask questions in plain English, and get answers with receipts: the exact clause and page every answer came from.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
