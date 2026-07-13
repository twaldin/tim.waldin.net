import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { notFound } from 'next/navigation';
import BlogUnifiedPage from '@/components/BlogUnifiedPage';

const POSTS_DIR = join(process.cwd(), 'blog-posts');

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { meta, body: match[2] };
}

export async function generateStaticParams() {
  if (!existsSync(POSTS_DIR)) return [];
  return readdirSync(POSTS_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => ({ slug: f.slice(0, -3) }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const filePath = join(POSTS_DIR, `${slug}.md`);
  if (!existsSync(filePath)) return { title: 'Post not found' };
  const { meta, body } = parseFrontmatter(readFileSync(filePath, 'utf-8'));
  const title = meta.title || slug;
  // First paragraph, markdown links flattened to their text, clipped for OG.
  const firstParagraph = body.trim().split(/\r?\n\r?\n/)[0]
    .replace(/\r?\n/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  const description = firstParagraph.length > 200
    ? `${firstParagraph.slice(0, 197)}...`
    : firstParagraph;
  return {
    title,
    description,
    openGraph: { title, description, url: `https://tim.waldin.net/blog/${slug}`, siteName: 'twaldin', type: 'article', images: ['/opengraph-image'] },
    twitter: { card: 'summary_large_image', title, description, images: ['/opengraph-image'] },
  };
}

export default async function BlogPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const filePath = join(POSTS_DIR, `${slug}.md`);
  if (!existsSync(filePath)) notFound();
  const { meta, body } = parseFrontmatter(readFileSync(filePath, 'utf-8'));

  return (
    <BlogUnifiedPage
      slug={slug}
      title={meta.title || slug}
      date={meta.date}
      body={body}
    />
  );
}
