export const KNOWN_COMMANDS = new Set([
  'welcome', 'about', 'contact', 'blog', 'projects', 'resume', 'help',
  'flt', 'agentelo', 'trade-up-bot', 'term-site',
  'stm32-games', 'dotfiles', 'hone', 'harness', 'studyspot',
]);

export const PROJECT_ALIASES = new Set([
  'flt', 'agentelo', 'trade-up-bot', 'term-site',
  'stm32-games', 'dotfiles', 'hone', 'harness', 'studyspot',
]);

export const BLOG_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function isValidPath(pathname: string): boolean {
  if (pathname === '/' || pathname === '') return true;

  let p = pathname.startsWith('/') ? pathname.slice(1) : pathname;

  if (p.startsWith('t/')) p = p.slice(2);
  else if (p.startsWith('projects/')) p = p.slice('projects/'.length);

  const parts = p.split('/');
  if (parts.length > 2) return false;

  const [first, second] = parts;
  if (!KNOWN_COMMANDS.has(first)) return false;

  if (second !== undefined) {
    if (first === 'blog') return BLOG_SLUG_PATTERN.test(second);
    if (first === 'projects') return KNOWN_COMMANDS.has(second);
    return false;
  }

  return true;
}

// Social-preview image for a URL path. Project pages reuse the pre-rendered
// /repo-card/<name> PNGs (1280×640, same cards GitHub shows); everything else
// falls back to the root terminal card from app/opengraph-image.tsx (1200×630).
export function getOgImage(pathname: string): { url: string; width: number; height: number } {
  let p = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  if (p.startsWith('t/')) p = p.slice(2);
  else if (p.startsWith('projects/')) p = p.slice('projects/'.length);
  const cmd = p.split('/')[0];
  if (PROJECT_ALIASES.has(cmd)) {
    const card = cmd === 'term-site' ? 'tim.waldin.net' : cmd;
    return { url: `/repo-card/${card}`, width: 1280, height: 640 };
  }
  return { url: '/opengraph-image', width: 1200, height: 630 };
}

export function getPageMetadata(pathname: string): { title: string; description: string } {
  if (pathname === '/' || pathname === '') {
    return {
      title: 'twaldin — interactive terminal portfolio',
      description: "Timothy Waldin's interactive terminal portfolio — every visitor gets their own isolated Docker container to explore. Projects, blog, and resume in a live zsh terminal.",
    };
  }

  let p = pathname.startsWith('/') ? pathname.slice(1) : pathname;

  if (p.startsWith('t/')) p = p.slice(2);

  const parts = p.split('/');
  const [cmd, sub] = parts;

  if (cmd === 'blog') {
    if (sub) {
      return { title: `${sub} — twaldin blog`, description: `Blog post: ${sub}.` };
    }
    return { title: 'blog — twaldin', description: 'Posts from Timothy Waldin.' };
  }

  if (cmd === 'about') {
    return { title: 'about — twaldin', description: 'About Timothy Waldin.' };
  }

  if (cmd === 'projects') {
    if (sub) {
      return { title: `${sub} — twaldin`, description: `Project: ${sub}.` };
    }
    return { title: 'projects — twaldin', description: 'Projects by Timothy Waldin.' };
  }

  if (PROJECT_ALIASES.has(cmd)) {
    return { title: `${cmd} — twaldin`, description: `Project: ${cmd}.` };
  }

  return { title: `${cmd} — twaldin`, description: `twaldin terminal — ${cmd}.` };
}
