// app/layout.tsx
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

/* =========================================================
   FONTS
========================================================= */

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/* =========================================================
   METADATA
========================================================= */

export const metadata: Metadata = {
  title: {
    default: "QuizML.ai",
    template: "%s | QuizML.ai",
  },
  description:
    "Turn study PDFs into focused micro-lessons, mastery quizzes, and review prompts.",
  applicationName: "QuizML.ai",
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"
  ),
  openGraph: {
    title: "QuizML.ai",
    description:
      "Turn study PDFs into focused micro-lessons, mastery quizzes, and review prompts.",
    type: "website",
  },
};

/* =========================================================
   ROOT LAYOUT
========================================================= */

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  /* =========================================================
     RENDER
  ========================================================= */

  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}
