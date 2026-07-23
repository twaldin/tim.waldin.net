import {
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  themes,
  type ThemeEntry,
} from '@/config/themes';

export type ThemeMode = 'dark' | 'light' | 'auto';
export type ResolvedThemeMode = Exclude<ThemeMode, 'auto'>;
export type ThemeSubscriber = (theme: ThemeEntry) => void;

const MODE_STORAGE_KEY = 'term-site:mode';
const DARK_THEME_STORAGE_KEY = 'term-site:theme-dark';
const LIGHT_THEME_STORAGE_KEY = 'term-site:theme-light';
// Full ThemeEntry JSON of the last PERSISTED selection. layout.tsx inlines
// a pre-paint script that reads this to set the CSS vars before first
// paint, so a saved theme never flashes the default on page load.
const PALETTE_SNAPSHOT_KEY = 'term-site:palette';
const LIGHT_MODE_QUERY = '(prefers-color-scheme: light)';

const subscribers = new Set<ThemeSubscriber>();
let activeTheme = themes[DEFAULT_DARK_THEME];
let initialized = false;
let colorSchemeQuery: MediaQueryList | null = null;

// Intro-animation theme flicker. The shell emits OSC 9996 'next' while an
// intro plays; we advance through these pairs. Every entry has a near-black
// (or near-white) background so the backdrop barely moves while the text
// colors visibly cycle, and every dark has a paired light variant so the
// flicker follows the visitor's resolved mode. Fire-style animations that
// depend on a stable 256-color palette simply never emit 'next'.
const FLICKER_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['iTerm2 Tango Dark', 'iTerm2 Tango Light'],
  ['Builtin Tango Dark', 'Builtin Tango Light'],
  ['GitHub Dark High Contrast', 'GitHub Light High Contrast'],
  ['Modus Vivendi', 'Modus Operandi'],
  ['Modus Vivendi Tinted', 'Modus Operandi Tinted'],
  ['Terminal Basic Dark', 'Terminal Basic'],
  ['Xcode Dark hc', 'Xcode Light hc'],
  ['iTerm2 Dark Background', 'iTerm2 Light Background'],
  ['Builtin Dark', 'Builtin Light'],
  ['Nvim Dark', 'Nvim Light'],
  ['Adwaita Dark', 'Adwaita'],
  ['Raycast Dark', 'Raycast Light'],
];
let flickerIndex = -1;

function readStorage(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // A blocked or full storage area should not prevent live theme changes.
  }
}

function readMode(): ThemeMode {
  const stored = readStorage(MODE_STORAGE_KEY);
  return stored === 'dark' || stored === 'light' || stored === 'auto'
    ? stored
    : 'auto';
}

function resolveMode(mode: ThemeMode): ResolvedThemeMode {
  if (mode !== 'auto') return mode;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'dark';
  }
  return window.matchMedia(LIGHT_MODE_QUERY).matches ? 'light' : 'dark';
}

function savedThemeName(mode: ResolvedThemeMode): string {
  const stored = readStorage(
    mode === 'dark' ? DARK_THEME_STORAGE_KEY : LIGHT_THEME_STORAGE_KEY,
  );
  if (stored && themes[stored]) return stored;
  return mode === 'dark' ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME;
}

function applyThemeEntry(theme: ThemeEntry): void {
  activeTheme = theme;
  if (typeof document !== 'undefined') {
    const style = document.documentElement.style;
    style.setProperty('--color-bg', theme.background);
    style.setProperty('--color-fg', theme.foreground);
    style.setProperty('--color-red', theme.red);
    style.setProperty('--color-green', theme.green);
    style.setProperty('--color-dim', theme.brightBlack);
    style.setProperty('--color-border', theme.brightBlack);
    style.setProperty('--color-primary', theme.green);
    style.setProperty('--color-black', theme.black);
    style.setProperty('--color-blue', theme.blue);
    style.setProperty('--color-yellow', theme.yellow);
    style.setProperty('--color-bright-yellow', theme.brightYellow);
    style.setProperty('--color-bright-white', theme.brightWhite);
    style.colorScheme = theme.mode;

    document
      .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      ?.setAttribute('content', theme.background);
  }
  for (const subscriber of subscribers) subscriber(theme);
}

function initialize(): void {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  if (typeof window.matchMedia === 'function') {
    colorSchemeQuery = window.matchMedia(LIGHT_MODE_QUERY);
    colorSchemeQuery.addEventListener('change', handleColorSchemeChange);
  }
  applyThemeEntry(themes[savedThemeName(resolveMode(readMode()))]);
}

function handleColorSchemeChange(): void {
  if (readMode() === 'auto') applySaved();
}

export function getMode(): ThemeMode {
  initialize();
  return readMode();
}

export function setMode(mode: ThemeMode): void {
  initialize();
  writeStorage(MODE_STORAGE_KEY, mode);
  applySaved();
  writeStorage(PALETTE_SNAPSHOT_KEY, JSON.stringify(getActiveTheme()));
}

export function resolvedMode(): ResolvedThemeMode {
  initialize();
  return resolveMode(readMode());
}

export function getThemeName(mode: ResolvedThemeMode = resolvedMode()): string {
  initialize();
  return savedThemeName(mode);
}

export function setThemeForMode(
  mode: ResolvedThemeMode,
  name: string,
): boolean {
  initialize();
  if (!themes[name]) return false;
  writeStorage(
    mode === 'dark' ? DARK_THEME_STORAGE_KEY : LIGHT_THEME_STORAGE_KEY,
    name,
  );
  return true;
}

export function applyTheme(name: string): boolean {
  initialize();
  const theme = themes[name];
  if (!theme) return false;
  applyThemeEntry(theme);
  return true;
}

export function applySaved(): boolean {
  initialize();
  return applyTheme(savedThemeName(resolveMode(readMode())));
}

export function setAndPersistTheme(
  name: string,
  mode: ResolvedThemeMode = resolvedMode(),
): boolean {
  initialize();
  if (!setThemeForMode(mode, name)) return false;
  if (!applyTheme(name)) return false;
  writeStorage(PALETTE_SNAPSHOT_KEY, JSON.stringify(getActiveTheme()));
  return true;
}

export function subscribe(subscriber: ThemeSubscriber): () => void {
  initialize();
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

export function resetThemeChoices(): void {
  initialize();
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(MODE_STORAGE_KEY);
      window.localStorage.removeItem(DARK_THEME_STORAGE_KEY);
      window.localStorage.removeItem(LIGHT_THEME_STORAGE_KEY);
      window.localStorage.removeItem(PALETTE_SNAPSHOT_KEY);
    } catch {
      // A blocked storage area still falls back to defaults below.
    }
  }
  applySaved();
  writeStorage(PALETTE_SNAPSHOT_KEY, JSON.stringify(getActiveTheme()));
}

export function getActiveTheme(): ThemeEntry {
  initialize();
  return activeTheme;
}

// Advance the intro flicker by one step (ephemeral — never persisted).
// Returns the applied theme name, or null if the list somehow misfires.
export function applyNextFlickerTheme(): string | null {
  initialize();
  const dark = resolvedMode() === 'dark';
  flickerIndex = (flickerIndex + 1) % FLICKER_PAIRS.length;
  const name = dark
    ? FLICKER_PAIRS[flickerIndex][0]
    : FLICKER_PAIRS[flickerIndex][1];
  return applyTheme(name) ? name : null;
}

// Reset the cycle so the next intro starts from the top of the list.
export function resetFlickerCycle(): void {
  flickerIndex = -1;
}
