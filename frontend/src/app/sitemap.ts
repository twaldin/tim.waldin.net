import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import type { MetadataRoute } from 'next';
import { PROJECT_ALIASES } from '@/lib/routes';

const BASE_URL = 'https://tim.waldin.net';
const POSTS_DIR = join(process.cwd(), 'blog-posts');

export default function sitemap(): MetadataRoute.Sitemap {
  const slugs = existsSync(POSTS_DIR)
    ? readdirSync(POSTS_DIR).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3))
    : [];

  return [
    { url: `${BASE_URL}/` },
    { url: `${BASE_URL}/blog` },
    ...slugs.map(slug => ({ url: `${BASE_URL}/blog/${slug}` })),
    ...[...PROJECT_ALIASES].map(alias => ({ url: `${BASE_URL}/projects/${alias}` })),
  ];
}
