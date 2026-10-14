"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { Terminal as XTermTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { terminalConfig } from "../config/terminal-theme";
import type { ThemeEntry } from "../config/themes";
import {
  applyNextFlickerTheme,
  applySaved,
  applyTheme,
  getActiveTheme,
  resetFlickerCycle,
  resetThemeChoices,
  resolvedMode,
  setAndPersistTheme,
  setMode,
  subscribe,
} from "../lib/theme-manager";
import {
  getPromptVisibleScrollTarget,
  getScrollDeltaToKeepElementVisible,
  shouldEmitTerminalResize,
  type TerminalDimensions,
} from "../lib/mobile-viewport";
import { attachTouchScroll } from "../lib/xterm-touch";
import { isSafeExternalUrl } from "../lib/safe-url";
import {
  embedLiveFontSize,
  embedMinCols,
  MIN_EMBED_FONT_SIZE,
  gridFontSize,
  viewportFontSize,
  type TerminalGrid,
} from "../lib/terminal-sizing";

const KEYBOARD_UPDATE_DELAYS_MS = [0, 80, 160, 260, 400, 650] as const;
const PROMPT_BOTTOM_MARGIN_ROWS = 3;
const PROMPT_BROWSER_BOTTOM_MARGIN_PX = 36;
const PROMPT_BROWSER_TOP_MARGIN_PX = 48;

function toXtermTheme(theme: ThemeEntry): Partial<ThemeEntry> {
  const xtermTheme: Partial<ThemeEntry> = { ...theme };
  delete xtermTheme.mode;
  return xtermTheme;
}

interface TerminalProps {
  onData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  // Inside a third-party frame (/x): no URL or navigation OSC, no focus on
  // mount, and the embed's font rule.
  embedded?: boolean;
}

export type TerminalKey = "escape" | "tab" | "enter" | "up" | "down" | "right" | "left";

const KEY_SEQUENCES: Record<TerminalKey, string> = {
  escape: "\x1b",
  tab: "\t",
  enter: "\r",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
};

export interface TerminalRef {
  writeToTerminal: (data: string) => void;
  clearTerminal: () => void;
  fitTerminal: () => void;
  // A fixed grid with the font scaled to fit, or null to fit the host. Always
  // reports the resulting size through onResize.
  setGrid: (grid: TerminalGrid | null) => void;
  // Types a key as if pressed, honouring application cursor mode.
  pressKey: (key: TerminalKey) => void;
  focus: () => void;
}

const Terminal = forwardRef<TerminalRef, TerminalProps>(
  ({ onData, onResize, embedded = false }, ref) => {
    const terminalRef = useRef<HTMLDivElement>(null);
    const xtermRef = useRef<XTermTerminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const outputBufferRef = useRef<string[]>([]);
    const dripTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const cancelDripRef = useRef(false);
    const dripRemainingRef = useRef('');
    const lastResizeSentRef = useRef<TerminalDimensions | null>(null);
    const gridRef = useRef<TerminalGrid | null>(null);
    const relayoutRef = useRef<(() => void) | null>(null);

    useEffect(() => {
      if (!terminalRef.current || typeof window === "undefined") return;

      if (xtermRef.current) {
        xtermRef.current.dispose();
        xtermRef.current = null;
        fitAddonRef.current = null;
      }

      let cleanupFunctions: (() => void)[] = [];

      // Init xterm immediately — don't gate on font download. The terminal
      // renders with a system fallback font first, then re-fits when the
      // Nerd Font finishes loading (preload in layout.tsx triggers the swap).
      if (!terminalRef.current) return;
      const currentTerminalElement = terminalRef.current;

      const layoutFontSize = () => {
        const grid = gridRef.current;
        const dpr = window.devicePixelRatio || 1;
        if (grid) return gridFontSize(currentTerminalElement.clientWidth, currentTerminalElement.clientHeight, grid, dpr);
        return embedded ? embedLiveFontSize(window.innerWidth, dpr) : viewportFontSize(window.innerWidth);
      };

      const dynamicFontSize = layoutFontSize();
      const activeXtermTheme = toXtermTheme(getActiveTheme());
      const dynamicConfig = {
        ...terminalConfig,
        fontSize: dynamicFontSize,
        theme: activeXtermTheme,
      };

      const xterm = new XTermTerminal(dynamicConfig);
      const fitAddon = new FitAddon();
      xterm.loadAddon(fitAddon);

      const handleLinkActivate = (_event: MouseEvent, text: string) => {
        if (!isSafeExternalUrl(text)) return;
        window.open(text, "_blank", "noopener,noreferrer");
      };
      xterm.options.linkHandler = {
        activate: handleLinkActivate,
        allowNonHttpProtocols: true,
      };

      xterm.open(currentTerminalElement);
      xtermRef.current = xterm;
      fitAddonRef.current = fitAddon;

      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        xterm.loadAddon(webgl);
      } catch { /* fall back to canvas */ }

      // An embedded terminal must never navigate or rewrite its frame's URL.
      const oscUrlDisposable = embedded ? null : xterm.parser.registerOscHandler(9999, (data) => {
        try {
          const path = '/' + data.replace(/^\/+/, '');
          if (typeof window !== 'undefined' && window.location.pathname !== path) {
            window.history.pushState(null, '', path);
          }
        } catch { return true; }
        return true;
      });

      const oscScrollTopDisposable = xterm.parser.registerOscHandler(9998, () => {
        try { xterm.scrollToTop(); } catch { /* best-effort */ }
        return true;
      });

      const oscNavigateDisposable = embedded ? null : xterm.parser.registerOscHandler(9997, (data) => {
        try {
          // Strip leading slashes then re-add exactly one, so //evil.com
          // becomes /evil.com (same-origin). Reject anything that still
          // looks like a URL scheme or protocol-relative path.
          if (data.includes('\\')) return true;
          const clean = data.replace(/^\/+/, '');
          if (/^[a-zA-Z][a-zA-Z0-9+.-]*:|^\//.test(clean)) return true; // reject scheme: or //
          const path = '/' + clean;
          if (typeof window !== 'undefined') {
            const u = new URL(path, window.location.origin);
            if (u.origin !== window.location.origin) return true;
            window.location.assign(u.pathname + u.search + u.hash);
          }
        } catch { /* malformed */ }
        return true;
      });
      // Theme applications are queued out of the parser callback — mutating
      // xterm.options.theme synchronously inside an OSC parse can freeze the
      // renderer when previews arrive in rapid bursts (theme picker).
      const oscEphemeralThemeDisposable = xterm.parser.registerOscHandler(9996, (data) => {
        const arg = data.trim();
        setTimeout(() => {
          if (arg === "") {
            resetFlickerCycle();
            applySaved();
          } else if (arg === "next") {
            applyNextFlickerTheme();
          } else {
            applyTheme(arg);
          }
        }, 0);
        return true;
      });

      const oscPersistentThemeDisposable = xterm.parser.registerOscHandler(9995, (data) => {
        const arg = data.trim();
        setTimeout(() => {
          if (arg === "dark" || arg === "light") setMode(arg);
          else if (arg === "reset") resetThemeChoices();
          else if (arg) setAndPersistTheme(arg, resolvedMode());
        }, 0);
        return true;
      });

      const unsubscribeTheme = subscribe((entry) => {
        xterm.options.theme = toXtermTheme(entry);
      });


      // Flush buffered output that arrived before xterm was ready
      if (outputBufferRef.current.length > 0) {
        for (const chunk of outputBufferRef.current) {
          xterm.write(chunk);
        }
        outputBufferRef.current = [];
      }

      const emitResizeIfNeeded = (force = false) => {
        const currentXterm = xtermRef.current;
        if (!currentXterm) return;
        const next = { cols: currentXterm.cols, rows: currentXterm.rows };
        if (!force && !shouldEmitTerminalResize(lastResizeSentRef.current, next)) return;
        lastResizeSentRef.current = next;
        onResize(next.cols, next.rows);
      };

      const fitLayout = () => {
        const grid = gridRef.current;
        if (grid) {
          // Whole-pixel cells skew a fixed grid's shape at small fonts and
          // leave it short of the box. Keep the nearby font whose grid fills
          // the most, then scale the rendered grid the rest of the way.
          const boxWidth = currentTerminalElement.clientWidth;
          const boxHeight = currentTerminalElement.clientHeight;
          const screen = currentTerminalElement.querySelector<HTMLElement>(".xterm-screen");
          const base = layoutFontSize();
          let best = { fontSize: base, scale: 1, filled: -1 };
          for (let fontSize = base; fontSize <= base + 3; fontSize++) {
            xterm.options.fontSize = fontSize;
            xterm.resize(grid.cols, grid.rows);
            if (!screen?.offsetWidth || !screen.offsetHeight) return;
            const scale = Math.min(boxWidth / screen.offsetWidth, boxHeight / screen.offsetHeight);
            const filled = screen.offsetWidth * screen.offsetHeight * scale * scale;
            if (filled > best.filled) best = { fontSize, scale, filled };
          }
          xterm.options.fontSize = best.fontSize;
          currentTerminalElement.style.transformOrigin = "0 0";
          currentTerminalElement.style.transform = `scale(${best.scale})`;
          return;
        }
        currentTerminalElement.style.transform = "";
        fitAddon.fit();
        if (!embedded) return;
        // Glyph advances snap differently per platform and renderer (Linux
        // hinting rounds 6.6 px up to 7), so check the fitted grid itself.
        const minCols = embedMinCols(window.innerWidth);
        let fontSize = xterm.options.fontSize ?? MIN_EMBED_FONT_SIZE;
        while (xterm.cols < minCols && fontSize > MIN_EMBED_FONT_SIZE) {
          fontSize -= 1;
          xterm.options.fontSize = fontSize;
          fitAddon.fit();
        }
      };

      relayoutRef.current = () => {
        xterm.options.fontSize = layoutFontSize();
        requestAnimationFrame(() => {
          if (xtermRef.current !== xterm) return;
          fitLayout();
          emitResizeIfNeeded(true);
        });
      };

      const dataDisposable = xterm.onData((data) => {
        cancelDripRef.current = true;
        if (dripTimerRef.current) {
          clearTimeout(dripTimerRef.current);
          dripTimerRef.current = null;
        }
        if (dripRemainingRef.current && xtermRef.current) {
          xtermRef.current.write(dripRemainingRef.current);
          dripRemainingRef.current = '';
        }
        onData(data);
      });
      const resizeDisposable = xterm.onResize(() => emitResizeIfNeeded());

      let fitFrame: number | null = null;
      const scheduleFitAndKeepPromptVisible = (scrollPrompt = false) => {
        if (fitFrame !== null) cancelAnimationFrame(fitFrame);
        fitFrame = requestAnimationFrame(() => {
          fitFrame = null;
          fitAndKeepPromptVisible(scrollPrompt);
        });
      };

      // Fit after one frame for DOM layout
      requestAnimationFrame(() => {
        fitLayout();
        emitResizeIfNeeded();
      });

      // Re-fit when Nerd Font finishes loading — glyph widths change.
      document.fonts.ready.then(() => {
        if (xtermRef.current === xterm) {
          fitLayout();
          emitResizeIfNeeded();
        }
      });

      // Focusing a third-party frame on load can scroll the host page to it.
      if (!embedded) xterm.focus();

      const handleClick = () => xterm.focus();
      currentTerminalElement.addEventListener("click", handleClick);

      const loadWebLinks = () => xterm.loadAddon(new WebLinksAddon(handleLinkActivate));
      currentTerminalElement.addEventListener("mouseover", loadWebLinks, { once: true });

      const detachTouch = attachTouchScroll(xterm, currentTerminalElement);

      const scrollPromptIntoBrowserViewport = () => {
        const cursor = currentTerminalElement.querySelector(".xterm-cursor") as HTMLElement | null;
        const targetElement = cursor ?? currentTerminalElement.querySelector(".xterm-screen") as HTMLElement | null;
        if (!targetElement) return;

        const rect = targetElement.getBoundingClientRect();
        const viewport = window.visualViewport;
        const visibleTop = viewport?.offsetTop ?? 0;
        const visibleBottom = visibleTop + (viewport?.height ?? window.innerHeight);
        const delta = getScrollDeltaToKeepElementVisible({
          elementTop: rect.top,
          elementBottom: rect.bottom,
          visibleTop,
          visibleBottom,
          topMargin: PROMPT_BROWSER_TOP_MARGIN_PX,
          bottomMargin: PROMPT_BROWSER_BOTTOM_MARGIN_PX,
        });
        if (delta === 0) return;

        const scrollContainer = currentTerminalElement.closest(".terminal-page") as HTMLElement | null;
        if (scrollContainer) {
          scrollContainer.scrollBy({ top: delta, behavior: "auto" });
        } else {
          window.scrollBy({ top: delta, behavior: "auto" });
        }
      };

      const fitAndKeepPromptVisible = (scrollPrompt = false) => {
        const currentXterm = xtermRef.current;
        if (!currentXterm) return;

        const previousViewportTop = currentXterm.buffer.active.viewportY;
        fitLayout();

        const targetViewportTop = getPromptVisibleScrollTarget({
          cursorLine: currentXterm.buffer.active.baseY + currentXterm.buffer.active.cursorY,
          viewportTop: previousViewportTop,
          rows: currentXterm.rows,
          bottomMarginRows: PROMPT_BOTTOM_MARGIN_ROWS,
        });
        const deltaRows = targetViewportTop - currentXterm.buffer.active.viewportY;
        if (deltaRows !== 0) currentXterm.scrollLines(deltaRows);
        emitResizeIfNeeded();

        if (scrollPrompt) requestAnimationFrame(scrollPromptIntoBrowserViewport);
      };

      let keyboardUpdateTimers: ReturnType<typeof setTimeout>[] = [];

      const applyViewportHeightVars = () => {
        const viewport = window.visualViewport;
        const visibleHeight = viewport?.height ?? window.innerHeight;
        document.documentElement.style.setProperty("--app-visual-viewport-height", `${Math.round(visibleHeight)}px`);
      };

      const updateVisibleViewportFit = () => {
        applyViewportHeightVars();
        scheduleFitAndKeepPromptVisible(false);
      };

      const updateVisibleViewportFitFromInput = () => {
        keyboardUpdateTimers.forEach(clearTimeout);
        keyboardUpdateTimers = KEYBOARD_UPDATE_DELAYS_MS.map((delay) =>
          setTimeout(() => {
            updateVisibleViewportFit();
            scheduleFitAndKeepPromptVisible(true);
          }, delay),
        );
      };

      updateVisibleViewportFit();
      window.visualViewport?.addEventListener("resize", updateVisibleViewportFit);
      window.visualViewport?.addEventListener("scroll", updateVisibleViewportFit);
      currentTerminalElement.addEventListener("focusin", updateVisibleViewportFitFromInput);
      currentTerminalElement.addEventListener("input", updateVisibleViewportFitFromInput);

      const handlePaste = async (event: ClipboardEvent) => {
        event.preventDefault();
        try {
          xterm.paste(await navigator.clipboard.readText());
        } catch (err) {
          console.warn("Failed to read clipboard:", err);
        }
      };

      const handleCopy = async () => {
        try {
          const selection = xterm.getSelection();
          if (selection) {
            await navigator.clipboard.writeText(selection);
          }
        } catch (err) {
          console.warn("Failed to write to clipboard:", err);
        }
      };

      const handleKeyDown = async (event: KeyboardEvent) => {
        if ((event.ctrlKey || event.metaKey) && event.key === "v") {
          event.preventDefault();
          try {
            xterm.paste(await navigator.clipboard.readText());
          } catch (err) {
            console.warn("Failed to read clipboard:", err);
          }
        } else if ((event.ctrlKey || event.metaKey) && event.key === "c") {
          const selection = xterm.getSelection();
          if (selection) {
            event.preventDefault();
            handleCopy();
          }
        }
      };

      currentTerminalElement.addEventListener("paste", handlePaste);
      currentTerminalElement.addEventListener("keydown", handleKeyDown);

      let resizeTimeout: NodeJS.Timeout;
      const handleResize = () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
          if (terminalRef.current && xterm && fitAddon) {
            const newFontSize = layoutFontSize();
            const currentFontSize =
              xterm.options.fontSize || dynamicConfig.fontSize;
            if (Math.abs(currentFontSize - newFontSize) > 1) {
              xterm.options.fontSize = newFontSize;
            }
          }
          updateVisibleViewportFit();
        }, 150);
      };

      window.addEventListener("resize", handleResize);

      cleanupFunctions = [
        () => {
          if (dripTimerRef.current) clearTimeout(dripTimerRef.current);
        },
        detachTouch,
        () => {
          keyboardUpdateTimers.forEach(clearTimeout);
          if (fitFrame !== null) cancelAnimationFrame(fitFrame);
          window.visualViewport?.removeEventListener("resize", updateVisibleViewportFit);
          window.visualViewport?.removeEventListener("scroll", updateVisibleViewportFit);
          currentTerminalElement.removeEventListener("focusin", updateVisibleViewportFitFromInput);
          currentTerminalElement.removeEventListener("input", updateVisibleViewportFitFromInput);
          document.documentElement.style.removeProperty("--app-visual-viewport-height");
        },
        () => {
          clearTimeout(resizeTimeout);
          window.removeEventListener("resize", handleResize);
        },
        () =>
          currentTerminalElement.removeEventListener("click", handleClick),
        () =>
          currentTerminalElement.removeEventListener("mouseover", loadWebLinks),
        () =>
          currentTerminalElement.removeEventListener("paste", handlePaste),
        () =>
          currentTerminalElement.removeEventListener(
            "keydown",
            handleKeyDown,
          ),
        () => dataDisposable.dispose(),
        () => resizeDisposable.dispose(),
        () => oscUrlDisposable?.dispose(),
        () => oscScrollTopDisposable.dispose(),
        () => oscNavigateDisposable?.dispose(),
        () => oscEphemeralThemeDisposable.dispose(),
        () => oscPersistentThemeDisposable.dispose(),
        unsubscribeTheme,
        () => xterm.dispose(),
      ];

      // Return cleanup function
      return () => {
        cleanupFunctions.forEach((cleanup) => {
          try {
            cleanup();
          } catch {
            // Cleanup errors are expected during unmount
          }
        });
        xtermRef.current = null;
        fitAddonRef.current = null;
        relayoutRef.current = null;
      };
    }, [onData, onResize, embedded]);

    const writeToTerminal = (data: string) => {
      if (!xtermRef.current) {
        outputBufferRef.current.push(data);
        return;
      }
      // Write immediately. The previous "drip" (split large chunks into
      // line-by-line writes with 20ms setTimeout between each) was the
      // source of the prompt-mid-output race: if a big chunk was dripping
      // and a small chunk arrived, the small chunk bypassed the drip and
      // wrote immediately, stitching the shell's next-prompt escape into
      // the middle of the projects.sh output. xterm has its own internal
      // write buffer that handles throughput fine.
      xtermRef.current.write(data);
    };

    const clearTerminal = () => {
      if (xtermRef.current) {
        xtermRef.current.clear();
      }
    };

    useImperativeHandle(ref, () => ({
      writeToTerminal,
      clearTerminal,
      fitTerminal: () => {
        if (fitAddonRef.current && xtermRef.current) {
          fitAddonRef.current.fit();
          const next = { cols: xtermRef.current.cols, rows: xtermRef.current.rows };
          if (shouldEmitTerminalResize(lastResizeSentRef.current, next)) {
            lastResizeSentRef.current = next;
            onResize(next.cols, next.rows);
          }
        }
      },
      setGrid: (grid) => {
        gridRef.current = grid;
        relayoutRef.current?.();
      },
      focus: () => xtermRef.current?.focus(),
      pressKey: (key) => {
        const xterm = xtermRef.current;
        if (!xterm) return;
        const sequence = KEY_SEQUENCES[key];
        // Arrows switch from CSI to SS3 in application cursor mode, as xterm's own keyboard does.
        xterm.input(xterm.modes.applicationCursorKeysMode ? sequence.replace("\x1b[", "\x1bO") : sequence);
      },
    }), [onResize]);

    return (
      <div
        className="terminal-host"
        style={{
          width: "100%",
          height: "100%",
          margin: 0,
          // padding-bottom is overridden to ~25vh on mobile via globals.css —
          // gives the cursor + last output line breathing room above the
          // hard-to-read lower thumb zone of phones (where iOS URL bar +
          // home indicator land). FitAddon sizes rows from the inner
          // content area, so xterm's grid honors the reduced height.
          padding: "6px 14px",
          boxSizing: "border-box",
          backgroundColor: "var(--color-bg)",
          position: "relative",
        }}
      >
        <div
          ref={terminalRef}
          className="w-full h-full"
          style={{
            width: "100%",
            height: "100%",
            margin: 0,
            padding: 0,
            boxSizing: "border-box",
            backgroundColor: "var(--color-bg)",
          }}
        />
      </div>
    );
  },
);

Terminal.displayName = "Terminal";
export default Terminal;
