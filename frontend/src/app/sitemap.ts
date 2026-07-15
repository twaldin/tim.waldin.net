import type { MetadataRoute } from 'next';
import { PROJECT_ALIASES } from '@/lib/routes';
import { listPostSlugs } from '@/lib/blog-posts';

const BASE_URL = 'https://tim.waldin.net';

export default function sitemap(): MetadataRoute.Sitemap {
  const slugs = listPostSlugs();

  return [
    { url: `${BASE_URL}/` },
    { url: `${BASE_URL}/gui` },
    { url: `${BASE_URL}/blog` },
    ...slugs.map(slug => ({ url: `${BASE_URL}/blog/${slug}` })),
    ...[...PROJECT_ALIASES].map(alias => ({ url: `${BASE_URL}/projects/${alias}` })),
  ];
}
