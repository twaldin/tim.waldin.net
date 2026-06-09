import type { Metadata, Viewport } from "next";
import "./globals.css";
import SiteHeader from "@/components/SiteHeader";
import { terminalTheme } from "@/config/terminal-theme";
import { getPageMetadata } from "@/lib/routes";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "dark",
  themeColor: terminalTheme.background,
  // Ask mobile browsers to resize the layout viewport when the virtual
  // keyboard opens instead of just overlaying the bottom of the terminal.
  interactiveWidget: "resizes-content",
};

export async function generateMetadata(): Promise<Metadata> {
  const m = getPageMetadata('/');
  return {
    title: m.title,
    description: m.description,
    openGraph: { title: m.title, description: m.description, url: 'https://tim.waldin.net', siteName: 'twaldin', type: 'website' },
    twitter: { card: 'summary', title: m.title, description: m.description },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <style>{`
          :root {
            --color-bg: ${terminalTheme.background};
            --color-fg: ${terminalTheme.foreground};
            --color-red: ${terminalTheme.red};
            --color-green: ${terminalTheme.green};
            --color-dim: ${terminalTheme.brightBlack};
            --color-border: ${terminalTheme.brightBlack};
          }
        `}</style>
        {/* Start the Nerd Font download with the HTML parse so xterm's
            FontFace call doesn't trigger a cold fetch. `crossorigin=anonymous`
            matches the fetch mode xterm/@font-face use — without it the
            browser keeps the preload and the real load as separate requests
            and emits "preloaded but not used" warnings. */}
        <link
          rel="preload"
          as="font"
          href="/fonts/JetBrainsMonoNerdFontMono-Regular.woff2"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        <link
          rel="preload"
          as="font"
          href="/fonts/JetBrainsMonoNerdFontMono-Bold.woff2"
          type="font/woff2"
          crossOrigin="anonymous"
        />
      </head>
      <body>
        <SiteHeader />
        <main style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', background: terminalTheme.background }}>
          {children}
        </main>
      </body>
    </html>
  );
}
