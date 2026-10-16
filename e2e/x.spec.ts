import { test, expect } from '@playwright/test';
import { serveImmutableAssetsFromCache } from './immutable-assets';

test.describe('/x Player Card', () => {
  test.describe.configure({ retries: 1 });

  test.beforeEach(async ({ page }) => {
    await serveImmutableAssetsFromCache(page);
  });

  test('publishes Player Card metadata and permits only the embed to be framed', async ({ page, request }) => {
    const response = await page.goto('/x');
    expect(response?.status()).toBe(200);
    expect(response?.headers()['x-frame-options']).toBeUndefined();
    const csp = response?.headers()['content-security-policy'] ?? '';
    const ancestors = csp.split(';').find((directive) => directive.trim().startsWith('frame-ancestors ')) ?? '';
    expect(ancestors.trim().split(/\s+/).slice(1).sort()).toEqual([
      "'self'",
      'https://*.twitter.com',
      'https://*.x.com',
      'https://twitter.com',
      'https://x.com',
    ]);

    await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute('content', 'player');
    await expect(page.locator('meta[name="twitter:player"]')).toHaveAttribute('content', 'https://tim.waldin.net/x');
    await expect(page.locator('meta[name="twitter:player:width"]')).toHaveAttribute('content', '480');
    await expect(page.locator('meta[name="twitter:player:height"]')).toHaveAttribute('content', '480');
    const image = page.locator('meta[name="twitter:image"]');
    await expect(image).toHaveAttribute('content', /\/x\/twitter-image(?:\?|$)/);
    const imageResponse = await request.get((await image.getAttribute('content'))!);
    expect(imageResponse.status()).toBe(200);
    expect(imageResponse.headers()['content-type']).toMatch(/^image\//);

    const home = await request.get('/');
    expect(home.status()).toBe(200);
    expect(home.headers()['x-frame-options']).toBe('SAMEORIGIN');
  });

  test('waits for a keypress before opening a usable live shell', async ({ page }) => {
    const socketRequests: string[] = [];
    let output = '';
    const sockets: string[] = [];
    let sessionEnded = false;
    let socketClosed = false;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/socket.io/')) socketRequests.push(request.url());
    });
    page.on('websocket', (socket) => {
      if (!new URL(socket.url()).pathname.startsWith('/socket.io/')) return;
      sockets.push(socket.url());
      socketClosed = false;
      socket.on('close', () => { socketClosed = true; });
      socket.on('framereceived', ({ payload }) => {
        if (typeof payload !== 'string' || !payload.startsWith('42[')) return;
        const [event, data] = JSON.parse(payload.slice(2));
        if (event === 'output') output += data;
        if (event === 'session_end') sessionEnded = true;
      });
    });

    await page.goto('/x');
    await expect(page.locator('.xterm')).toBeVisible();
    await expect(page.getByRole('status')).toHaveText('▶ tap or press any key for a live shell');
    await page.waitForTimeout(3000);
    expect(socketRequests).toEqual([]);
    expect(sockets).toEqual([]);

    await page.keyboard.press('Enter');
    try {
      await expect(page.getByRole('status')).toHaveText('● live shell');
      await expect.poll(() => output).toContain('❯');
      await page.keyboard.press('Control+u');
      await page.keyboard.type('printf "embed-%s\\n" "$((6 * 7))"');
      await page.keyboard.press('Enter');
      await expect.poll(() => output).toContain('embed-42');
      expect(sockets).toHaveLength(1);
    } finally {
      if (await page.getByRole('status').textContent() === '● live shell') {
        sessionEnded = false;
        await page.keyboard.press('Control+c');
        await page.keyboard.press('Control+u');
        await page.keyboard.type('exit');
        await page.keyboard.press('Enter');
        await expect.soft.poll(() => sessionEnded, { timeout: 5000 }).toBe(true);
        await expect.soft(page.getByRole('status')).toHaveText(
          'session ended · press any key for a new shell', { timeout: 5000 },
        );
        await expect.soft.poll(() => socketClosed, { timeout: 5000 }).toBe(true);
      }
    }
  });
});
