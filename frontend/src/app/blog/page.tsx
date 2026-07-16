import Link from 'next/link';
import type { Metadata } from 'next';
import { getPost, listPostSlugs, postExcerpt, type BlogPost } from '@/lib/blog-posts';
import { BG, FG, DIM, BRAND, LINK, CODE_BORDER } from '@/lib/markdown-components';
import { getPageMetadata } from '@/lib/routes';

// Static index for crawlers and skimmers. Typing `blog` in the live terminal
// pushes /blog via OSC 9999 without a reload, so this page only renders on
// cold loads — the intended cold/hot split.

export function generateMetadata(): Metadata {
  const m = getPageMetadata('/blog');
  return {
    title: m.title,
    description: m.description,
    openGraph: { title: m.title, description: m.description, url: 'https://tim.waldin.net/blog', siteName: 'twaldin', type: 'website', images: [{ url: '/opengraph-image', width: 1200, height: 630 }] },
    twitter: { card: 'summary_large_image', title: m.title, description: m.description, images: ['/opengraph-image'] },
  };
}

export default function BlogIndexPage() {
  const posts = listPostSlugs()
    .map((slug) => getPost(slug))
    .filter((post): post is BlogPost => post !== null)
    .sort((a, b) => (b.meta.date || b.slug).localeCompare(a.meta.date || a.slug));

  return (
    <div
      style={{
        minHeight: '100%',
        flex: 1,
        background: BG,
        color: FG,
        fontFamily:
          '"JetBrainsMono Nerd Font Mono", "JetBrainsMono Nerd Font", "JetBrains Mono", ui-monospace, monospace',
      }}
    >
      <div style={{ maxWidth: '768px', margin: '0 auto', padding: '24px 14px' }}>
        <div style={{ fontSize: '0.9rem', marginBottom: '1.25rem', userSelect: 'none' }}>
          <span style={{ color: BRAND }}>tim.waldin.net </span>
          <span style={{ color: FG }}>~ </span>
          <br />
          <span style={{ color: BRAND }}>❯ </span>
          <span style={{ color: FG }}>blog</span>
        </div>

        <h1 style={{ color: BRAND, fontWeight: 'bold', fontSize: '1.5rem', lineHeight: 1.25, marginBottom: '1.5rem' }}>
          blog
        </h1>

        {posts.map((post) => (
          <article key={post.slug} style={{ marginBottom: '2rem' }}>
            <h2 style={{ fontSize: '1.125rem', fontWeight: 'bold', lineHeight: 1.35, marginBottom: '0.25rem' }}>
              <Link
                href={`/blog/${post.slug}`}
                style={{ color: BRAND, textDecoration: 'underline', textUnderlineOffset: 2 }}
              >
                {post.meta.title || post.slug}
              </Link>
            </h2>
            {post.meta.date && (
              <div style={{ color: DIM, fontStyle: 'italic', fontSize: '0.9rem', marginBottom: '0.5rem' }}>
                {post.meta.date}
              </div>
            )}
            <p style={{ color: FG, lineHeight: 1.55, margin: 0 }}>{postExcerpt(post.body, 280)}</p>
          </article>
        ))}

        <div
          style={{
            borderTop: `1px solid ${CODE_BORDER}`,
            paddingTop: '1rem',
            marginTop: '1.5rem',
            fontSize: '0.85rem',
            color: DIM,
          }}
        >
          read in the terminal instead:{' '}
          <Link href="/t/blog" style={{ color: LINK, textDecoration: 'underline' }}>
            /t/blog
          </Link>
        </div>
      </div>
    </div>
  );
}
