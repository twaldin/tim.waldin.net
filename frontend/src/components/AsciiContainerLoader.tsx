'use client';

import { useEffect, useRef } from 'react';
import { terminalTheme } from '@/config/terminal-theme';
import {
  buildLoadingScrambleFrame,
  getLoaderHoldText,
  LOADER_EXIT_HOLD_MS,
  MAX_LOADER_TEXT_LENGTH,
  selectLoaderText,
} from '@/lib/ascii-loader';

type AsciiContainerLoaderProps = {
  ready: boolean;
  onFinished: () => void;
};

export default function AsciiContainerLoader({
  ready,
  onFinished,
}: AsciiContainerLoaderProps) {
  const textRef = useRef<HTMLSpanElement>(null);
  const textRefValue = useRef('CONNECTING TO CONTAINER');
  const tickRef = useRef(0);

  useEffect(() => {
    textRefValue.current = selectLoaderText();
    if (textRef.current) {
      textRef.current.textContent = getLoaderHoldText(textRefValue.current, 0);
    }
  }, []);

  useEffect(() => {
    const text = textRefValue.current;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (ready || reducedMotion) {
      if (textRef.current) {
        textRef.current.textContent = getLoaderHoldText(text, 0);
      }
      const finishTimer = window.setTimeout(onFinished, LOADER_EXIT_HOLD_MS);
      return () => window.clearTimeout(finishTimer);
    }

    const scrambleTimer = window.setInterval(() => {
      tickRef.current += 1;
      if (textRef.current) {
        const dotCount = tickRef.current % 4;
        textRef.current.textContent = getLoaderHoldText(
          buildLoadingScrambleFrame(text, tickRef.current),
          dotCount,
        );
      }
    }, 70);

    return () => window.clearInterval(scrambleTimer);
  }, [ready, onFinished]);

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
        {getLoaderHoldText('CONNECTING TO CONTAINER', 0).padEnd(MAX_LOADER_TEXT_LENGTH + 3, ' ')}
      </span>
    </div>
  );
}
