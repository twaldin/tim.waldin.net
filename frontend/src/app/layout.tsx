import type { Metadata, Viewport } from "next";
import "./globals.css";
import SiteHeader from "@/components/SiteHeader";
import PageviewBeacon from "@/components/PageviewBeacon";
import { DEFAULT_DARK_THEME, DEFAULT_LIGHT_THEME, themes, type ThemeEntry } from "@/config/themes";
import { getPageMetadata } from "@/lib/routes";
const defaultTheme = themes[DEFAULT_DARK_THEME];
const defaultLightTheme = themes[DEFAULT_LIGHT_THEME];

// CSS custom property → ThemeEntry field, for the default palettes below and
// the pre-paint script. Keep in sync with applyThemeEntry in
// src/lib/theme-manager.ts.
const PALETTE_VARS: ReadonlyArray<readonly [string, keyof ThemeEntry]> = [
  ['--color-bg', 'background'],
  ['--color-fg', 'foreground'],
  ['--color-red', 'red'],
  ['--color-green', 'green'],
  ['--color-dim', 'brightBlack'],
  ['--color-border', 'brightBlack'],
  ['--color-primary', 'green'],
  ['--color-black', 'black'],
  ['--color-blue', 'blue'],
  ['--color-yellow', 'yellow'],
  ['--color-bright-yellow', 'brightYellow'],
  ['--color-bright-white', 'brightWhite'],
];

function paletteVars(theme: ThemeEntry): string {
  return PALETTE_VARS.map(([name, field]) => `\n            ${name}: ${theme[field]};`).join('');
}

// Pre-paint theme restore; mirrors theme-manager's resolution (mode from
// term-site:mode, else prefers-color-scheme). The term-site:palette snapshot
// is applied only when the visitor chose a theme for the resolved mode;
// otherwise that mode's default is, so a snapshot saved under an older site
// default, or for the other mode, never flashes before hydration.
const PRE_PAINT_SCRIPT = `try{var V=${JSON.stringify(PALETTE_VARS)},D=${JSON.stringify({
  dark: defaultTheme,
  light: defaultLightTheme,
})},l=localStorage,m=l.getItem('term-site:mode'),r=m==='dark'||m==='light'?m:matchMedia('(prefers-color-scheme: light)').matches?'light':'dark',p=null;try{p=JSON.parse(l.getItem('term-site:palette'))}catch(e){}if(!(p&&p.mode===r&&l.getItem('term-site:theme-'+r)))p=D[r];var s=document.documentElement.style;V.forEach(function(v){s.setProperty(v[0],p[v[1]])});s.colorScheme=r;document.querySelectorAll('meta[name="theme-color"]').forEach(function(t){t.setAttribute('content',p.background)})}catch(e){}`;

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "dark light",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: defaultLightTheme.background },
    { media: "(prefers-color-scheme: dark)", color: defaultTheme.background },
  ],
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
    // PRE_PAINT_SCRIPT sets <html style> before hydration; the mismatch is intended.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Default palettes before any script runs: a first visit gets the
            default for its prefers-color-scheme, matching what theme-manager
            resolves in 'auto' mode, so light-mode visitors never flash dark. */}
        <style>{`
          :root {${paletteVars(defaultTheme)}
          }
          @media (prefers-color-scheme: light) {
            :root {${paletteVars(defaultLightTheme)}
            }
          }
        `}</style>
        {/* Pre-paint saved-theme restore (PRE_PAINT_SCRIPT): a visitor's
            chosen theme never flashes the default on navigation. */}
        <script
          dangerouslySetInnerHTML={{
            __html: PRE_PAINT_SCRIPT,
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
