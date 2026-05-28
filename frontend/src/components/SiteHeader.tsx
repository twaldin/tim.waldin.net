'use client';

import type { CSSProperties, MouseEvent } from 'react';
import Link from 'next/link';
import { terminalTheme } from '@/config/terminal-theme';

function lightenHex(hex: string, amount: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = Math.min(255, (n >> 16) + amount);
  const g = Math.min(255, ((n >> 8) & 0xff) + amount);
  const b = Math.min(255, (n & 0xff) + amount);
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

const BG     = terminalTheme.background;
const BORDER = terminalTheme.brightBlack;
const BRAND  = terminalTheme.brightMagenta;
const LINK   = lightenHex(terminalTheme.brightMagenta, 50);
const DIM    = terminalTheme.brightBlack;

// Force a full page reload so nav always gets a fresh session + initCommand.
function hardNav(href: string) {
  return (e: MouseEvent) => { e.preventDefault(); window.location.href = href; };
}

export default function SiteHeader() {
  const linkStyle: CSSProperties = {
    color: LINK,
    textDecoration: 'none',
  };

  return (
    <header
      style={{
        background: BG,
        borderBottom: `1px solid ${BORDER}`,
        padding: '6px 14px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexWrap: 'wrap',
        rowGap: '4px',
        columnGap: '12px',
        fontSize: '13px',
        fontFamily:
          '"JetBrainsMono Nerd Font Mono", "JetBrainsMono Nerd Font", "JetBrains Mono", ui-monospace, monospace',
        flexShrink: 0,
      }}
    >
      <Link href="/" onClick={hardNav('/')} style={{ color: BRAND, textDecoration: 'none', fontWeight: 'bold' }}>
        tim.waldin.net
      </Link>
      <nav style={{ display: 'flex', gap: '12px', alignItems: 'center', color: DIM }}>
        <span>navigation —</span>
        <Link href="/" onClick={hardNav('/')} style={linkStyle}>home</Link>
        <Link href="/t/blog" onClick={hardNav('/t/blog')} style={linkStyle}>blog</Link>
        <Link href="/t/projects" onClick={hardNav('/t/projects')} style={linkStyle}>projects</Link>
        <Link href="/t/resume" onClick={hardNav('/t/resume')} style={linkStyle}>resume</Link>
        <Link href="/t/about" onClick={hardNav('/t/about')} style={linkStyle}>about</Link>
        <Link href="/t/contact" onClick={hardNav('/t/contact')} style={linkStyle}>contact</Link>
      </nav>
    </header>
  );
}
