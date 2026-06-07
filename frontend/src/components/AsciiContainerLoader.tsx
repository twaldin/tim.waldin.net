'use client';

import { useEffect, useRef } from 'react';
import { terminalTheme } from '@/config/terminal-theme';
import {
  buildScrambleDecodeFrame,
  getLoaderConfig,
  getLoaderHoldText,
  LOADER_EXIT_HOLD_MS,
  MAX_LOADER_TEXT_LENGTH,
  selectLoaderText,
  type LoaderMode,
} from '@/lib/ascii-loader';

type AsciiContainerLoaderProps = {
  mode: LoaderMode;
  ready: boolean;
  onFinished: () => void;
};

const FRAME_MS = 50;

export default function AsciiContainerLoader({
  mode,
  ready,
  onFinished,
}: AsciiContainerLoaderProps) {
  const textRef = useRef<HTMLSpanElement>(null);
  const textRefValue = useRef('CONNECTING TO CONTAINER');
  const readyRef = useRef(false);
  const finishedRef = useRef(false);
  const tickRef = useRef(0);

  useEffect(() => {
    textRefValue.current = selectLoaderText(mode);
  }, [mode]);

  useEffect(() => {
    readyRef.current = ready;
  }, [ready]);

  useEffect(() => {
    const text = textRefValue.current;
    const { minDecodeMs } = getLoaderConfig(mode);
    const startedAt = performance.now();
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let finishTimer: number | undefined;

    const finish = () => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      if (textRef.current) {
        textRef.current.textContent = getLoaderHoldText(text, 0);
      }
      finishTimer = window.setTimeout(onFinished, LOADER_EXIT_HOLD_MS);
    };

    if (reducedMotion) {
      finish();
      return undefined;
    }

    const render = () => {
      if (finishedRef.current) return;

      tickRef.current += 1;
      const elapsed = performance.now() - startedAt;
      const progress = Math.min(1, elapsed / minDecodeMs);

      if (textRef.current) {
        const frame = progress >= 1
          ? text
          : buildScrambleDecodeFrame(text, progress, tickRef.current);
        textRef.current.textContent = getLoaderHoldText(frame, 0);
      }

      if (progress >= 1 && readyRef.current) {
        finish();
      }
    };

    render();
    const frameTimer = window.setInterval(render, FRAME_MS);

    return () => {
      window.clearInterval(frameTimer);
      if (finishTimer !== undefined) {
        window.clearTimeout(finishTimer);
      }
    };
  }, [mode, onFinished]);

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
        {buildScrambleDecodeFrame('CONNECTING TO CONTAINER', 0).padEnd(MAX_LOADER_TEXT_LENGTH + 3, ' ')}
      </span>
    </div>
  );
}
