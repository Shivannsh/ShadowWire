import type { Metadata } from "next";
import { Inter_Tight, IBM_Plex_Mono, Fraunces } from "next/font/google";
import { Providers } from "./providers";
import { Header } from "@/components/Header";
import "./globals.css";

const sans = Inter_Tight({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const display = Fraunces({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
  axes: ["opsz", "SOFT", "WONK"],
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "ShadowWire: ZK-Shielded Cross-Border Remittance",
  description:
    "Real banks in, real banks out, zero visibility in between. ShadowWire is a shielded remittance corridor on Stellar, SEP-24 fiat anchors, Groth16 zero-knowledge proofs, and AttestProtocol KYC on every transaction.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${display.variable} ${mono.variable}`}
    >
      <body className="font-sans antialiased">
        <Providers>
          <div className="app-canvas">
            <Header />
            <main>{children}</main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
