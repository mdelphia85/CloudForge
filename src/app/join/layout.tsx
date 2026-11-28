import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Join CloudForge Organization",
  robots: { index:false, follow:false },
};

export default function InviteLayout({children}:{children:React.ReactNode}) {
  return children;
}
