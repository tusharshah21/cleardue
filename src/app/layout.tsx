import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { isMockMode } from "@/paypal/client";
import "./globals.css";

const geistSans = Geist({ variable: "--font-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "ClearDue",
  description: "An AI collections agent for solo freelancers who bill through PayPal.",
  openGraph: { title: "ClearDue", description: "Get paid without chasing. An AI collections agent for freelancers, built on PayPal.", images: [{ url: "/brand/og.png", width: 1200, height: 630, alt: "ClearDue: get paid without chasing" }] },
  twitter: { card: "summary_large_image", title: "ClearDue", description: "Get paid without chasing.", images: ["/brand/og.png"] },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-background text-foreground">
        {/* isMockMode() throws in production (unless ALLOW_MOCK_IN_PROD=true), so a mock-mode deploy fails loudly on its first render. */}
        {isMockMode() && (
          <div role="status" className="bg-amber-100 px-4 py-1.5 text-center text-xs font-medium text-amber-900">
            PayPal mock mode: no PayPal calls are made. Invoices and payments are simulated locally.
          </div>
        )}
        {children}
      </body>
    </html>
  );
}
