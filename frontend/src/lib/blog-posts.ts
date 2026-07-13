import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

// Markdown posts live in container/blog/posts (the shell blog reads them
// there); the frontend sees them as ./blog-posts — a symlink in dev, a COPY
// in Dockerfile.production.
export const POSTS_DIR = join(process.cwd(), 'blog-posts');

export type BlogPost = {
  slug: string;
  meta: Record<string, string>;
  body: string;
};

export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { meta, body: match[2] };
}

export function listPostSlugs(): string[] {
  if (!existsSync(POSTS_DIR)) return [];
  return readdirSync(POSTS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3));
}

export function getPost(slug: string): BlogPost | null {
  const filePath = join(POSTS_DIR, `${slug}.md`);
  if (!existsSync(filePath)) return null;
  const { meta, body } = parseFrontmatter(readFileSync(filePath, 'utf-8'));
  return { slug, meta, body };
}

// First paragraph, markdown links flattened to their text, clipped for OG
// descriptions and card excerpts.
export function postExcerpt(body: string, maxLength = 200): string {
  const firstParagraph = body
    .trim()
    .split(/\r?\n\r?\n/)[0]
    .replace(/\r?\n/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  return firstParagraph.length > maxLength
    ? `${firstParagraph.slice(0, maxLength - 3)}...`
    : firstParagraph;
}

// Old links in the wild (tweets, aggregators) sometimes carry a slug variant —
// missing date prefix, extra suffix, truncation. Resolve to a real post iff
// the match is unambiguous so /blog/hone-haiku-20pp can 301 to the canonical
// /blog/2026-04-19-hone-haiku-20pp instead of 404ing.
export function resolveSlugAlias(requested: string): string | null {
  const slugs = listPostSlugs();
  if (slugs.includes(requested)) return requested;
  const needle = requested.toLowerCase().replace(/\/+$/, '');
  if (needle.length < 4) return null;
  const matches = slugs.filter((s) => {
    const undated = s.replace(/^\d{4}-\d{2}-\d{2}-/, '');
    return s.includes(needle) || needle.includes(undated) || undated.includes(needle);
  });
  return matches.length === 1 ? matches[0] : null;
}
