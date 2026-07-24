import { test, expect, type Page } from '@playwright/test';

// E2E for the terminal portfolio. Targets the live site by default (BASE_URL)
// or a local/preview build in CI. Verifies the user-facing contract: terminal
// renders, commands produce output, every nav button navigates + re-runs, and
// refresh reattaches without starving output (regression for the stale-sink
// reattach bug).

const BASE = process.env.BASE_URL || 'https://tim.waldin.net';
const LOAD_BUDGET_MS = Number(process.env.LOAD_BUDGET_MS || 15000);
const ANSI_OR_OSC = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][0-9]+;[^\x07\x1b]*(\x07|\x1b\\)|\r/g;

// `as unknown as` is required: Playwright serializes this callback into the page,
// where the compiler cannot see the __ioFrames augmentation we install below.
type FrameSink = { __ioFrames: unknown[] };

async function captureFrames(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const sink = window as unknown as FrameSink;
    sink.__ioFrames = [];
    const NativeWebSocket = window.WebSocket;
    // Wrap the native WebSocket so every server->client frame is recorded,
    // without needing a test hook compiled into the app bundle.
    class CapturingWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener('message', (event: MessageEvent) => sink.__ioFrames.push(event.data));
      }
    }
    window.WebSocket = CapturingWebSocket;
  });
}

// Join all socket.io 'output' event payloads into one ANSI-stripped string.
// The durable assertion surface for "the terminal produced visible output".
async function outputText(page: Page): Promise<string> {
  const payloads = await page.evaluate(() => {
    const frames = (window as unknown as FrameSink).__ioFrames;
    return (Array.isArray(frames) ? frames : [])
      .filter((f): f is string => typeof f === 'string' && f.startsWith('42["output"'))
      .map((f) => {
        try { return (JSON.parse(f.slice(2))[1] as string) ?? ''; } catch { return ''; }
      });
  });
  return payloads.join('').replace(ANSI_OR_OSC, '');
}

test.describe('terminal portfolio e2e', () => {
  test.beforeEach(async ({ page }) => { await captureFrames(page); });

  test('homepage loads under budget and renders the terminal', async ({ page }) => {
    const start = Date.now();
    await page.goto(BASE);
    await expect(page.locator('.xterm')).toBeVisible({ timeout: LOAD_BUDGET_MS });
    expect(Date.now() - start).toBeLessThan(LOAD_BUDGET_MS);
  });

  test('typing a command produces terminal output', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('.xterm')).toBeVisible();
    // Wait for the boot intro + welcome to finish before typing — the
    // welcome box text is a deterministic end marker (a prompt-count race
    // can fire early when the initial prompt redraws after resize).
    await expect.poll(() => outputText(page), { timeout: 25000 }).toContain('portfolio terminal');
    await page.locator('.xterm').click();
    await page.keyboard.press('Control+u'); // clear any half-typed input
    await page.keyboard.type('help');
    await page.keyboard.press('Enter');
    await expect.poll(() => outputText(page), { timeout: 15000 }).toMatch(/figlet|nvim|grep|commands/);
  });

  test('refresh reattaches and keeps output flowing (reattach regression)', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('.xterm')).toBeVisible();
    // The boot intro animation must finish first — typing while it plays
    // gets eaten by its keypress-skip. Wait for the welcome box, the
    // deterministic end-of-boot marker.
    await expect.poll(() => outputText(page), { timeout: 25000 }).toContain('portfolio terminal');
    await page.locator('.xterm').click();
    await page.keyboard.type('about');
    await page.keyboard.press('Enter');
    await expect.poll(() => outputText(page), { timeout: 15000 }).toBeTruthy();

    // Reload is the user's trigger. Before the fix this resumed the session but
    // bound output to the dead previous socket — terminal stuck in "reattaching".
    // After the fix, output MUST keep flowing regardless of resume-vs-cold.
    await page.reload();
    await expect(page.locator('.xterm')).toBeVisible();
    await expect.poll(() => outputText(page), { timeout: 15000 }).toBeTruthy();
  });

  test('reload during the boot intro renders the terminal (/boot is a valid path)', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('.xterm')).toBeVisible();
    // The auto-typed initCommand makes preexec emit /boot while the intro
    // animation plays. Reloading in that window must not 404.
    await expect.poll(() => page.url(), { timeout: 10000 }).toContain('/boot');
    await page.reload();
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 10000 });
    await expect.poll(() => outputText(page), { timeout: 20000 }).toBeTruthy();
  });

  for (const target of ['blog', 'projects', 'resume', 'about', 'contact', 'home']) {
    test(`nav "${target}" navigates and the terminal responds`, async ({ page }) => {
      await page.goto(BASE);
      await expect(page.locator('.xterm')).toBeVisible();
      // SiteHeader links trigger a full page navigation that re-runs the command.
      await page.getByRole('link', { name: new RegExp(`^${target}$`, 'i') }).first().click();
      await page.waitForLoadState('networkidle');
      await expect(page.locator('.xterm')).toBeVisible();
      await expect.poll(() => outputText(page), { timeout: 15000 }).toBeTruthy();
    });
  }
});
