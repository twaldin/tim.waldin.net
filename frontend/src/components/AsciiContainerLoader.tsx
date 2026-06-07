'use client';

import { useEffect, useRef } from 'react';
import { animate } from 'animejs';
import { terminalTheme } from '@/config/terminal-theme';
import {
  ASCII_LOADER_TEXT,
  buildScrambleDecodeFrame,
} from '@/lib/ascii-loader';

export default function AsciiContainerLoader() {
  const textRef = useRef<HTMLSpanElement>(null);
  const cursorRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reducedMotion) {
      if (textRef.current) textRef.current.textContent = ASCII_LOADER_TEXT;
      return;
    }

    const state = { phase: 0, tick: 0 };
    const animation = animate(state, {
      phase: 1,
      duration: 760,
      loop: true,
      ease: 'linear',
      onUpdate: () => {
        state.tick += 1;
        if (textRef.current) {
          textRef.current.textContent = buildScrambleDecodeFrame(
            ASCII_LOADER_TEXT,
            state.phase,
            state.tick,
          );
        }
        if (cursorRef.current) {
          cursorRef.current.style.transform = `translateX(${Math.round(Math.sin(state.tick * 0.8) * 2)}px)`;
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
        fontSize: 'clamp(14px, 1.7vw, 22px)',
        lineHeight: 1,
        letterSpacing: '0.035em',
        textAlign: 'center',
        textTransform: 'uppercase',
        userSelect: 'none',
      }}
    >
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '0.45ch',
          whiteSpace: 'pre',
        }}
      >
        <span
          ref={cursorRef}
          aria-hidden="true"
          style={{
            display: 'inline-block',
            width: '1ch',
            height: '1.08em',
            background: `repeating-linear-gradient(135deg, ${terminalTheme.primary} 0 2px, transparent 2px 4px)`,
            boxShadow: `0 0 16px ${terminalTheme.primary}55`,
          }}
        />
        <span
          ref={textRef}
          style={{
            display: 'inline-block',
            minWidth: `${ASCII_LOADER_TEXT.length}ch`,
            color: terminalTheme.primary,
            textShadow: `0 0 14px ${terminalTheme.primary}44`,
            whiteSpace: 'pre',
          }}
        >
          {buildScrambleDecodeFrame(ASCII_LOADER_TEXT, 0)}
        </span>
        <span
          aria-hidden="true"
          style={{
            display: 'inline-block',
            width: '1ch',
            height: '1.08em',
            background: `repeating-linear-gradient(135deg, ${terminalTheme.primary} 0 2px, transparent 2px 4px)`,
            boxShadow: `0 0 16px ${terminalTheme.primary}55`,
          }}
        />
      </div>
    </div>
  );
}
