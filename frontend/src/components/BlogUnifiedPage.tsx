"use client";

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import {
  BlogMarkdown,
  BG,
  FG,
  DIM,
  BRAND,
  LINK,
  CODE_BORDER,
} from '@/lib/markdown-components';
import { terminalConfig, terminalTheme } from '@/config/terminal-theme';
import { isSafeExternalUrl } from '@/lib/safe-url';

function hexToAnsiRgb(hex: string): string {
  const n = parseInt(hex.replace('#', ''), 16);
  return `${(n >> 16) & 0xff};${(n >> 8) & 0xff};${n & 0xff}`;
}

const ANSI_PROMPT =
  `\x1b[38;2;${hexToAnsiRgb(terminalTheme.primary)}mtim.waldin.net ` +
  `\x1b[38;2;${hexToAnsiRgb(terminalTheme.foreground)}m~ \r\n` +
  `\x1b[38;2;${hexToAnsiRgb(terminalTheme.primary)}m❯ \x1b[0m`;

const CHAR_WIDTH_RATIO = 0.6;
const MOBILE_BREAKPOINT = 768;

async function loadNerdFont(): Promise<void> {
  try {
    const reg = new FontFace(
      'JetBrainsMono Nerd Font Mono',
      'url(/fonts/JetBrainsMonoNerdFontMono-Regular.woff2) format("woff2")',
      { weight: 'normal', style: 'normal' },
    );
    const bold = new FontFace(
      'JetBrainsMono Nerd Font Mono',
      'url(/fonts/JetBrainsMonoNerdFontMono-Bold.woff2) format("woff2")',
      { weight: 'bold', style: 'normal' },
    );
    await Promise.all([reg.load(), bold.load()]);
    document.fonts.add(reg);
    document.fonts.add(bold);
  } catch {
    /* fallback to system monospace */
  }
}

interface Props {
  slug: string;
  title: string;
  date?: string;
  body: string;
}

export default function BlogUnifiedPage({ slug, title, date, body }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const cmdBufRef = useRef('');

  useEffect(() => {
    if (!hostRef.current || typeof window === 'undefined') return;
    let disposed = false;
    const cleanups: Array<() => void> = [];

    Promise.all([
      loadNerdFont(),
      import('@xterm/xterm'),
      import('@xterm/addon-web-links'),
    ]).then(([, xtermMod, linksMod]) => {
      if (disposed || !hostRef.current) return;
      const { Terminal } = xtermMod;
      const { WebLinksAddon } = linksMod;

      const isMobile = window.innerWidth < MOBILE_BREAKPOINT;
      const fontSize = isMobile ? 13 : 14;

      const parentEl = hostRef.current.parentElement;
      const parentWidth = parentEl ? parentEl.clientWidth : window.innerWidth;
      const usableWidth = Math.max(200, parentWidth - 28 - 24);
      const cols = Math.max(40, Math.floor(usableWidth / (fontSize * CHAR_WIDTH_RATIO)));

      const xterm = new Terminal({
        ...terminalConfig,
        cols,
        rows: 3,
        fontSize,
        scrollback: 0,
        disableStdin: false,
      });

      const openLink = (_e: MouseEvent, href: string) => {
        if (!isSafeExternalUrl(href)) return;
        window.open(href, '_blank', 'noopener,noreferrer');
      };
      xterm.loadAddon(new WebLinksAddon(openLink));
      xterm.options.linkHandler = { activate: openLink, allowNonHttpProtocols: true };

      xterm.open(hostRef.current);
      xterm.write(ANSI_PROMPT);

      const dataDisposable = xterm.onData((data) => {
        if (data === '\r') {
          const cmd = cmdBufRef.current.trim();
          cmdBufRef.current = '';
          if (!cmd) {
            xterm.write('\r\n' + ANSI_PROMPT);
            return;
          }
          // Any command → navigate to live terminal at / with command auto-typed
          window.location.assign('/t/' + encodeURIComponent(cmd));
          return;
        }
        if (data === '\x7f' || data === '\x08') {
          if (cmdBufRef.current.length > 0) {
            cmdBufRef.current = cmdBufRef.current.slice(0, -1);
            xterm.write('\b \b');
          }
          return;
        }
        // Printable chars (handles single keystrokes + paste)
        for (const ch of data) {
          if (ch >= ' ' && ch <= '~') {
            cmdBufRef.current += ch;
            xterm.write(ch);
          }
        }
      });

      cleanups.push(() => dataDisposable.dispose());
      cleanups.push(() => xterm.dispose());
    });

    return () => {
      disposed = true;
      for (const fn of cleanups) {
        try { fn(); } catch { /* ignore */ }
      }
    };
  }, []);

  return (
    <div
      style={{
        minHeight: '100%',
        flex: 1,
        background: BG,
        color: FG,
        fontFamily:
          '"JetBrainsMono Nerd Font Mono", "JetBrainsMono Nerd Font", "JetBrains Mono", ui-monospace, monospace',
      }}
    >
      <div style={{ maxWidth: '768px', margin: '0 auto', padding: '24px 14px' }}>
        <BlogMarkdown slug={slug} title={title} date={date} body={body} />

        <div
          style={{
            borderTop: `1px solid ${CODE_BORDER}`,
            paddingTop: '1rem',
            marginTop: '1.5rem',
            fontSize: '0.85rem',
            color: DIM,
            marginBottom: '1.5rem',
          }}
        >
          <strong style={{ color: FG, fontWeight: 'bold' }}>navigation</strong>
          <span> — </span>
          <Link href="/" style={{ color: LINK, textDecoration: 'underline', marginRight: '1rem' }}>
            home
          </Link>
          <Link href="/t/blog" style={{ color: LINK, textDecoration: 'underline', marginRight: '1rem' }}>
            blog
          </Link>
          <Link href="/t/projects" style={{ color: LINK, textDecoration: 'underline', marginRight: '1rem' }}>
            projects
          </Link>
          <Link href="/t/resume" style={{ color: LINK, textDecoration: 'underline' }}>
            resume
          </Link>
        </div>

        <div
          ref={hostRef}
          style={{
            display: 'inline-block',
            padding: '8px 12px',
            minWidth: '100%',
            boxSizing: 'border-box',
          }}
        />
      </div>
    </div>
  );
}
