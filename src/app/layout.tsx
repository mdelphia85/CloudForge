import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cloud Forge | Inventory",
  description: "Inventory control for the work ahead.",
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"),
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: "Cloud Forge | Industrial Operations",
    description: "Inventory, engineering, production, and field service operations.",
    url: "/",
    siteName: "Cloud Forge",
    type: "website",
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
