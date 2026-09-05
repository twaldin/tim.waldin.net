import { setTimeout as sleep } from 'node:timers/promises';
import type { APIResponse, Page, Route } from '@playwright/test';

// Replays the site's immutable build assets (content-hashed JS/CSS chunks
// under /_next/static and the fonts under /fonts, all served with
// `Cache-Control: immutable`) from a per-worker memory cache.
//
// Why: every Playwright test gets a fresh browser context with an empty HTTP
// cache, so each test re-downloads ~19 of these inside the first second of
// its page load. nginx limits every client IP to 10 requests/s with a burst
// of 20 and answers the excess with 503. The requests a cold load issues last
// are the dynamically imported Terminal/xterm chunks, so those are the ones
// rejected: React never mounts <Terminal>, `.xterm` never appears and the test
// times out. A real visitor keeps these assets in the browser cache across
// navigations; this restores that behaviour for the suite. Each asset is still
// downloaded from the site under test (once per worker, plus the bounded 503
// retries below), and every page load still spends live requests on the HTML,
// RSC prefetches, the pageview beacon and the socket, so a broken deploy is
// still caught.
const IMMUTABLE_PATH = /^\/(_next\/static|fonts)\//;

// The first page load of a worker is still one cold burst that can graze the
// limiter; a 503 from it is transient, so back off and refetch. Only 503 is
// retried: nginx answers limiter rejections with 503, while an unreachable or
// broken frontend surfaces as 502/504 and still fails the test.
const LIMITER_RETRY_DELAYS_MS = [500, 1000, 2000];

type CachedAsset = { contentType: string; body: Buffer };
const cache = new Map<string, CachedAsset>();

export async function serveImmutableAssetsFromCache(page: Page): Promise<void> {
  await page.route((url) => IMMUTABLE_PATH.test(url.pathname), async (route) => {
    const url = route.request().url();
    let asset = cache.get(url);
    if (!asset) {
      const response = await fetchThroughLimiter(route);
      if (response.status() !== 200) {
        await route.fulfill({ response });
        return;
      }
      asset = {
        contentType: response.headers()['content-type'] ?? 'application/octet-stream',
        body: await response.body(),
      };
      cache.set(url, asset);
    }
    await route.fulfill({ status: 200, contentType: asset.contentType, body: asset.body });
  });
}

async function fetchThroughLimiter(route: Route): Promise<APIResponse> {
  let response = await route.fetch();
  for (const delay of LIMITER_RETRY_DELAYS_MS) {
    if (response.status() !== 503) break;
    await sleep(delay);
    response = await route.fetch();
  }
  return response;
}
