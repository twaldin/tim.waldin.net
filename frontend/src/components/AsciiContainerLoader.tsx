'use client';

import { useEffect, useRef } from 'react';
import { animate } from 'animejs';
import { terminalTheme } from '@/config/terminal-theme';
import {
  ASCII_LOADER_TEXT,
  buildDensityTextFrame,
  getLoaderStatusLabel,
} from '@/lib/ascii-loader';

export default function AsciiContainerLoader() {
  const textRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reducedMotion) {
      if (textRef.current) textRef.current.textContent = ASCII_LOADER_TEXT;
      if (labelRef.current) labelRef.current.textContent = 'connecting to container';
      return;
    }

    const state = { phase: 0 };
    const animation = animate(state, {
      phase: 1,
      duration: 1800,
      loop: true,
      ease: 'linear',
      onUpdate: () => {
        if (textRef.current) {
          textRef.current.textContent = buildDensityTextFrame(
            ASCII_LOADER_TEXT,
            state.phase,
          );
        }
        if (labelRef.current) {
          labelRef.current.textContent = getLoaderStatusLabel(state.phase);
        }
      },
    });

    return () => {
      animation.cancel();
    };
  }, []);

  return (
    <div
      aria-label="Connecting to container"
      aria-live="polite"
      style={{
        color: terminalTheme.primary,
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 'clamp(13px, 1.4vw, 18px)',
        lineHeight: 1.55,
        letterSpacing: '0.045em',
        textAlign: 'left',
        textTransform: 'uppercase',
        userSelect: 'none',
      }}
    >
      <div
        ref={textRef}
        style={{
          minWidth: `${ASCII_LOADER_TEXT.length}ch`,
          color: terminalTheme.primary,
          textShadow: `0 0 14px ${terminalTheme.primary}44`,
          whiteSpace: 'pre',
        }}
      >
        {buildDensityTextFrame(ASCII_LOADER_TEXT, 0)}
      </div>
      <div
        style={{
          marginTop: '0.6rem',
          color: terminalTheme.brightBlack,
          fontSize: '0.72em',
          letterSpacing: '0.12em',
        }}
      >
        <span style={{ color: terminalTheme.brightBlack }}>[</span>
        <span ref={labelRef}>allocating sandbox</span>
        <span style={{ color: terminalTheme.brightBlack }}>]</span>
      </div>
    </div>
  );
}
