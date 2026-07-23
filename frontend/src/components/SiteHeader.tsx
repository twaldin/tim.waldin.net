'use client';

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from 'react';
import Link from 'next/link';
import {
  applySaved,
  resolvedMode,
  setMode,
  subscribe,
  type ResolvedThemeMode,
} from '@/lib/theme-manager';

const BG = 'var(--color-bg)';
const BORDER = 'var(--color-border)';
const BRAND = 'var(--color-primary)';
const LINK = 'var(--color-green)';
const DIM = 'var(--color-dim)';

const NAV_ITEMS = [
  { href: '/', label: 'home' },
  { href: '/t/blog', label: 'blog' },
  { href: '/t/projects', label: 'projects' },
  { href: '/t/resume', label: 'resume' },
  { href: '/t/about', label: 'about' },
  { href: '/t/contact', label: 'contact' },
] as const;

// Force a full page reload so nav always gets a fresh session + initCommand.
function hardNav(href: string, beforeNavigate?: () => void) {
  return (event: MouseEvent) => {
    event.preventDefault();
    beforeNavigate?.();
    window.location.href = href;
  };
}

export default function SiteHeader() {
  const menuRef = useRef<HTMLDetailsElement>(null);
  const [currentMode, setCurrentMode] = useState<ResolvedThemeMode>('dark');
  const linkStyle: CSSProperties = {
    color: LINK,
    textDecoration: 'none',
  };

  useEffect(() => {
    applySaved();
    setCurrentMode(resolvedMode());

    const unsubscribe = subscribe(() => setCurrentMode(resolvedMode()));
    const closeOnOutsideClick = (event: PointerEvent) => {
      const menu = menuRef.current;
      if (menu && event.target instanceof Node && !menu.contains(event.target)) {
        menu.removeAttribute('open');
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !menuRef.current?.open) return;
      menuRef.current.removeAttribute('open');
      menuRef.current.querySelector('summary')?.focus();
    };

    document.addEventListener('pointerdown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      unsubscribe();
      document.removeEventListener('pointerdown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, []);

  const closeMenu = () => menuRef.current?.removeAttribute('open');
  const toggleMode = () => {
    const nextMode = currentMode === 'dark' ? 'light' : 'dark';
    setMode(nextMode);
    setCurrentMode(nextMode);
  };

  return (
    <header
      className="site-header"
      style={{
        background: BG,
        borderBottom: `1px solid ${BORDER}`,
        padding: '6px 14px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: '12px',
        fontSize: '13px',
        fontFamily:
          '"JetBrainsMono Nerd Font Mono", "JetBrainsMono Nerd Font", "JetBrains Mono", ui-monospace, monospace',
        flexShrink: 0,
        position: 'relative',
        whiteSpace: 'nowrap',
      }}
    >
      <Link href="/" onClick={hardNav('/')} style={{ color: BRAND, textDecoration: 'none', fontWeight: 'bold' }}>
        tim.waldin.net
      </Link>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '12px', minWidth: 0 }}>
        <nav className="hidden items-center gap-x-3 sm:flex" style={{ color: DIM }}>
          <span>navigation —</span>
          {NAV_ITEMS.map(({ href, label }) => (
            <Link key={href} href={href} onClick={hardNav(href)} style={linkStyle}>
              {label}
            </Link>
          ))}
        </nav>

        <details ref={menuRef} className="relative sm:hidden">
          <summary
            className="site-menu-summary cursor-pointer list-none"
            style={{ color: LINK }}
          >
            menu ▾
          </summary>
          <nav
            aria-label="Mobile navigation"
            style={{
              position: 'absolute',
              top: 'calc(100% + 8px)',
              right: 0,
              zIndex: 30,
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              minWidth: '150px',
              padding: '12px 14px',
              background: BG,
              border: `1px solid ${BORDER}`,
              boxShadow: `0 8px 24px color-mix(in srgb, ${BG} 78%, transparent)`,
            }}
          >
            {NAV_ITEMS.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                onClick={hardNav(href, closeMenu)}
                style={linkStyle}
              >
                {label}
              </Link>
            ))}
          </nav>
        </details>

        <button
          type="button"
          aria-label={`Switch to ${currentMode === 'dark' ? 'light' : 'dark'} mode`}
          onClick={toggleMode}
          style={{
            appearance: 'none',
            border: 0,
            padding: 0,
            background: 'transparent',
            color: LINK,
            cursor: 'pointer',
            font: 'inherit',
          }}
        >
          {currentMode}
        </button>
      </div>
    </header>
  );
}
