export const KNOWN_COMMANDS = new Set([
  'welcome', 'about', 'contact', 'blog', 'projects', 'resume', 'help',
  'flt', 'agentelo', 'trade-up-bot', 'term-site',
  'stm32-games', 'dotfiles', 'hone', 'harness',
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

export function getPageMetadata(pathname: string): { title: string; description: string } {
  if (pathname === '/' || pathname === '') {
    return {
      title: 'twaldin — interactive terminal portfolio',
      description: "Timothy Waldin's portfolio: live terminal, blog, projects.",
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

  const projectAliases = new Set([
    'flt', 'agentelo', 'trade-up-bot', 'term-site',
    'stm32-games', 'dotfiles', 'hone', 'harness',
  ]);
  if (projectAliases.has(cmd)) {
    return { title: `${cmd} — twaldin`, description: `Project: ${cmd}.` };
  }

  return { title: `${cmd} — twaldin`, description: `twaldin terminal — ${cmd}.` };
}
