'use client';

import { useEffect } from 'react';

// First-party pageview beacon: fire-and-forget POST to /pv (nginx proxies it
// to the backend) once per page load. No cookies, no user IDs, nothing stored
// client-side. Skipped when the browser asks not to be tracked.
export default function PageviewBeacon() {
  useEffect(() => {
    const nav: Navigator & { doNotTrack?: string | null } = navigator;
    if (nav.doNotTrack === '1') return;
    if (typeof nav.sendBeacon !== 'function') return;
    try {
      nav.sendBeacon('/pv', JSON.stringify({ path: location.pathname }));
    } catch { /* ignore — analytics must never break the page */ }
  }, []);

  return null;
}
