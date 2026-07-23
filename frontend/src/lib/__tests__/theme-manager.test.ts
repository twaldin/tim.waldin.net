import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  themes,
} from '@/config/themes';

type MediaListener = (event: MediaQueryListEvent) => void;

function installBrowser(preferLight = false) {
  const storage = new Map<string, string>();
  const cssVars = new Map<string, string>();
  const mediaListeners = new Set<MediaListener>();
  let matches = preferLight;
  let themeColor = '';

  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() { return storage.size; },
  };
  const mediaQuery = {
    get matches() { return matches; },
    media: '(prefers-color-scheme: light)',
    onchange: null,
    addEventListener: (_type: string, listener: MediaListener) => mediaListeners.add(listener),
    removeEventListener: (_type: string, listener: MediaListener) => mediaListeners.delete(listener),
    addListener: (listener: MediaListener) => mediaListeners.add(listener),
    removeListener: (listener: MediaListener) => mediaListeners.delete(listener),
    dispatchEvent: () => true,
  };
  const style = {
    colorScheme: '',
    setProperty: (name: string, value: string) => cssVars.set(name, value),
  };
  const meta = {
    setAttribute: (name: string, value: string) => {
      if (name === 'content') themeColor = value;
    },
  };

  vi.stubGlobal('window', {
    localStorage,
    matchMedia: () => mediaQuery,
  });
  vi.stubGlobal('document', {
    documentElement: { style },
    querySelector: (selector: string) => selector === 'meta[name="theme-color"]' ? meta : null,
  });

  return {
    cssVars,
    storage,
    style,
    get themeColor() { return themeColor; },
    setPreferredLight(value: boolean) {
      matches = value;
      const event = { matches, media: mediaQuery.media } as MediaQueryListEvent;
      for (const listener of mediaListeners) listener(event);
    },
  };
}

describe('theme manager', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to auto mode and resolves the saved theme for the system preference', async () => {
    installBrowser(true);
    const manager = await import('../theme-manager');

    expect(manager.getMode()).toBe('auto');
    expect(manager.resolvedMode()).toBe('light');
    expect(manager.getThemeName()).toBe(DEFAULT_LIGHT_THEME);
    expect(manager.getActiveTheme()).toStrictEqual(themes[DEFAULT_LIGHT_THEME]);
  });

  it('round-trips an explicit mode through local storage', async () => {
    const browser = installBrowser();
    const manager = await import('../theme-manager');

    manager.setMode('light');

    expect(manager.getMode()).toBe('light');
    expect(manager.resolvedMode()).toBe('light');
    expect(browser.storage.get('term-site:mode')).toBe('light');
    expect(manager.getActiveTheme()).toStrictEqual(themes[DEFAULT_LIGHT_THEME]);
  });

  it('ignores an unknown theme without changing the active theme or CSS', async () => {
    const browser = installBrowser();
    const manager = await import('../theme-manager');
    const active = manager.getActiveTheme();
    const background = browser.cssVars.get('--color-bg');

    expect(manager.applyTheme('not a real theme')).toBe(false);
    expect(manager.getActiveTheme()).toBe(active);
    expect(browser.cssVars.get('--color-bg')).toBe(background);
  });

  it('keeps live theme changes ephemeral until a theme is explicitly persisted', async () => {
    const browser = installBrowser();
    const manager = await import('../theme-manager');

    expect(manager.applyTheme(DEFAULT_LIGHT_THEME)).toBe(true);
    expect(browser.storage.has('term-site:theme-dark')).toBe(false);
    expect(browser.storage.has('term-site:theme-light')).toBe(false);

    manager.applySaved();
    expect(manager.getActiveTheme()).toStrictEqual(themes[DEFAULT_DARK_THEME]);

    expect(manager.setAndPersistTheme(DEFAULT_LIGHT_THEME, 'light')).toBe(true);
    expect(browser.storage.get('term-site:theme-light')).toBe(DEFAULT_LIGHT_THEME);
    expect(manager.getActiveTheme()).toStrictEqual(themes[DEFAULT_LIGHT_THEME]);
  });

  it('notifies subscribers of palette changes and honors unsubscription', async () => {
    installBrowser();
    const manager = await import('../theme-manager');
    const subscriber = vi.fn();
    const unsubscribe = manager.subscribe(subscriber);

    manager.applyTheme(DEFAULT_LIGHT_THEME);
    expect(subscriber).toHaveBeenCalledTimes(1);
    expect(subscriber).toHaveBeenCalledWith(
      expect.objectContaining({ background: themes[DEFAULT_LIGHT_THEME].background }),
    );

    unsubscribe();
    manager.applyTheme(DEFAULT_DARK_THEME);
    expect(subscriber).toHaveBeenCalledTimes(1);
  });

  it('writes the active palette to CSS variables and the browser theme color', async () => {
    const browser = installBrowser();
    const manager = await import('../theme-manager');
    const theme = themes[DEFAULT_LIGHT_THEME];

    expect(manager.applyTheme(DEFAULT_LIGHT_THEME)).toBe(true);
    expect(browser.cssVars.get('--color-bg')).toBe(theme.background);
    expect(browser.cssVars.get('--color-fg')).toBe(theme.foreground);
    expect(browser.cssVars.get('--color-red')).toBe(theme.red);
    expect(browser.cssVars.get('--color-green')).toBe(theme.green);
    expect(browser.cssVars.get('--color-dim')).toBe(theme.brightBlack);
    expect(browser.cssVars.get('--color-border')).toBe(theme.brightBlack);
    expect(browser.cssVars.get('--color-primary')).toBe(theme.green);
    expect(browser.style.colorScheme).toBe('light');
    expect(browser.themeColor).toBe(theme.background);
  });

  it('re-applies the saved light theme when an auto-mode media query changes', async () => {
    const browser = installBrowser(false);
    const manager = await import('../theme-manager');

    expect(manager.getActiveTheme()).toStrictEqual(themes[DEFAULT_DARK_THEME]);
    browser.setPreferredLight(true);

    expect(manager.resolvedMode()).toBe('light');
    expect(manager.getActiveTheme()).toStrictEqual(themes[DEFAULT_LIGHT_THEME]);
    expect(browser.cssVars.get('--color-bg')).toBe(themes[DEFAULT_LIGHT_THEME].background);
  });

  it('is safe to call without browser globals', async () => {
    const manager = await import('../theme-manager');

    expect(() => manager.getMode()).not.toThrow();
    expect(() => manager.resolvedMode()).not.toThrow();
    expect(() => manager.applySaved()).not.toThrow();
    expect(manager.getActiveTheme()).toStrictEqual(themes[DEFAULT_DARK_THEME]);
  });

  it('flicker cycles dark themes in dark mode, light in light mode, ephemerally', async () => {
    const browser = installBrowser(false);
    const manager = await import('../theme-manager');
    manager.setMode('dark');

    const first = manager.applyNextFlickerTheme();
    const second = manager.applyNextFlickerTheme();
    expect(first).toBe('iTerm2 Tango Dark');
    expect(second).toBe('Builtin Tango Dark');
    expect(themes[first!].mode).toBe('dark');
    expect(themes[second!].mode).toBe('dark');
    // Ephemeral: flicker never persists a choice.
    expect(browser.storage.get('term-site:theme-dark')).toBeUndefined();

    manager.setMode('light');
    const light = manager.applyNextFlickerTheme();
    expect(light).not.toBeNull();
    expect(themes[light!].mode).toBe('light');
  });

  it('flicker covers the whole paired list without repeats, then resets', async () => {
    installBrowser(false);
    const manager = await import('../theme-manager');
    manager.setMode('dark');

    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const name = manager.applyNextFlickerTheme();
      expect(name).not.toBeNull();
      seen.add(name!);
      expect(themes[name!].mode).toBe('dark');
    }
    expect(seen.size).toBe(12);

    manager.resetFlickerCycle();
    expect(manager.applyNextFlickerTheme()).toBe('iTerm2 Tango Dark');
  });
});
