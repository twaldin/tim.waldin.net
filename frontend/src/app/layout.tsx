import type { Metadata, Viewport } from "next";
import "./globals.css";
import SiteHeader from "@/components/SiteHeader";
import PageviewBeacon from "@/components/PageviewBeacon";
import { DEFAULT_DARK_THEME, themes } from "@/config/themes";
import { getPageMetadata } from "@/lib/routes";
const defaultTheme = themes[DEFAULT_DARK_THEME];


export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "dark light",
  themeColor: defaultTheme.background,
  // Ask mobile browsers to resize the layout viewport when the virtual
  // keyboard opens instead of just overlaying the bottom of the terminal.
  interactiveWidget: "resizes-content",
};

export async function generateMetadata(): Promise<Metadata> {
  const m = getPageMetadata('/');
  return {
    metadataBase: new URL('https://tim.waldin.net'),
    title: m.title,
    description: m.description,
    openGraph: { title: m.title, description: m.description, url: 'https://tim.waldin.net', siteName: 'twaldin', type: 'website' },
    twitter: { card: 'summary_large_image', title: m.title, description: m.description },
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
            --color-bg: ${defaultTheme.background};
            --color-fg: ${defaultTheme.foreground};
            --color-red: ${defaultTheme.red};
            --color-green: ${defaultTheme.green};
            --color-dim: ${defaultTheme.brightBlack};
            --color-border: ${defaultTheme.brightBlack};
            --color-primary: ${defaultTheme.green};
            --color-black: ${defaultTheme.black};
            --color-blue: ${defaultTheme.blue};
            --color-yellow: ${defaultTheme.yellow};
            --color-bright-yellow: ${defaultTheme.brightYellow};
            --color-bright-white: ${defaultTheme.brightWhite};
          }
        `}</style>
        {/* Pre-paint saved-theme restore: theme-manager persists a palette
            snapshot to localStorage on every saved change; apply it before
            first paint so a visitor's theme never flashes the default on
            navigation. Keep the var list in sync with applyThemeEntry in
            src/lib/theme-manager.ts. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var p=JSON.parse(localStorage.getItem('term-site:palette'));if(p){var s=document.documentElement.style;s.setProperty('--color-bg',p.background);s.setProperty('--color-fg',p.foreground);s.setProperty('--color-red',p.red);s.setProperty('--color-green',p.green);s.setProperty('--color-dim',p.brightBlack);s.setProperty('--color-border',p.brightBlack);s.setProperty('--color-primary',p.green);s.setProperty('--color-black',p.black);s.setProperty('--color-blue',p.blue);s.setProperty('--color-yellow',p.yellow);s.setProperty('--color-bright-yellow',p.brightYellow);s.setProperty('--color-bright-white',p.brightWhite);s.colorScheme=p.mode;var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute('content',p.background);}}catch(e){}`,
          }}
        />
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
        <PageviewBeacon />
        <SiteHeader />
        <main style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--color-bg)' }}>
          {children}
        </main>
      </body>
    </html>
  );
}
