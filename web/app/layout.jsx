import "./globals.css";
import { Archivo_Black, Hanken_Grotesk, IBM_Plex_Mono } from "next/font/google";

// Brutalist grotesque display — heavy, blunt, no nonsense.
const display = Archivo_Black({
  subsets: ["latin"],
  weight: ["400"],
  variable: "--font-display",
  display: "swap",
});

// Refined grotesque for UI/body (kept light: 3 weights only).
const sans = Hanken_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-sans",
  display: "swap",
});

// Darkroom-stamp monospace for technical annotations.
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata = {
  title: "Peek Remote",
  description: "Remote screen capture and control console.",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Peek Remote",
  },
  formatDetection: { telephone: false },
};

export const viewport = {
  themeColor: "#08080a",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${sans.variable} ${mono.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
