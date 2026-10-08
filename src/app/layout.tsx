import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "SOE Diagnostics",
  description: "Managed Safe Exam Browser diagnostics for school IT",
  robots: { index: false, follow: false },
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
