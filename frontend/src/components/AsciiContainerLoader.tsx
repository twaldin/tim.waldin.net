'use client';

import { useEffect, useRef } from 'react';
import { animate } from 'animejs';
import { terminalTheme } from '@/config/terminal-theme';
import {
  buildScrambleDecodeFrame,
  getLoaderHoldText,
  MAX_LOADER_TEXT_LENGTH,
  selectLoaderText,
} from '@/lib/ascii-loader';

export default function AsciiContainerLoader() {
  const textRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const text = selectLoaderText();
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reducedMotion) {
      if (textRef.current) textRef.current.textContent = getLoaderHoldText(text, 3);
      return;
    }

    const state = { phase: 0, tick: 0 };
    let dotCount = 0;
    let ellipsisInterval: number | undefined;

    const decodeAnimation = animate(state, {
      phase: 1,
      duration: 1800,
      loop: false,
      ease: 'linear',
      onUpdate: () => {
        state.tick += 1;
        if (textRef.current) {
          textRef.current.textContent = buildScrambleDecodeFrame(
            text,
            state.phase,
            state.tick,
          );
        }
      },
      onComplete: () => {
        if (!textRef.current) return;
        textRef.current.textContent = getLoaderHoldText(text, 0);
        ellipsisInterval = window.setInterval(() => {
          dotCount = (dotCount + 1) % 4;
          if (textRef.current) {
            textRef.current.textContent = getLoaderHoldText(text, dotCount);
          }
        }, 420);
      },
    });

    return () => {
      decodeAnimation.cancel();
      if (ellipsisInterval !== undefined) {
        window.clearInterval(ellipsisInterval);
      }
    };
  }, []);

  const initialText = buildScrambleDecodeFrame('CONNECTING TO CONTAINER', 0);

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
      <span
        ref={textRef}
        style={{
          display: 'inline-block',
          minWidth: `${MAX_LOADER_TEXT_LENGTH + 3}ch`,
          color: terminalTheme.primary,
          textShadow: `0 0 14px ${terminalTheme.primary}44`,
          whiteSpace: 'pre',
        }}
      >
        {initialText.padEnd(MAX_LOADER_TEXT_LENGTH + 3, ' ')}
      </span>
    </div>
  );
}
