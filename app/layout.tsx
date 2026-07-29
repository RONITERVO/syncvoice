import type { Metadata } from "next";
import { headers } from "next/headers";
import { DM_Sans, Manrope } from "next/font/google";
import "./globals.css";

const dmSans = DM_Sans({ variable: "--font-dm-sans", subsets: ["latin"] });
const manrope = Manrope({ variable: "--font-manrope", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const metadataBase = new URL(`${protocol}://${host}`);
  const socialImage = new URL("/og.png", metadataBase).toString();

  return {
    metadataBase,
    title: "SyncVoice — TTS, in perfect time",
    description: "Create natural Gemini speech with a transcript that follows every word.",
    icons: { icon: "/og.png", shortcut: "/og.png" },
    openGraph: {
      title: "SyncVoice",
      description: "TTS, in perfect time.",
      type: "website",
      images: [{ url: socialImage, width: 1200, height: 630, alt: "SyncVoice audio waveform and synchronized transcript" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "SyncVoice",
      description: "TTS, in perfect time.",
      images: [socialImage],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${dmSans.variable} ${manrope.variable}`}>{children}</body>
    </html>
  );
}
