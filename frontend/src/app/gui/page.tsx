import { readFileSync } from 'fs';
import { join } from 'path';
import type { Metadata } from 'next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { parseFrontmatter } from '@/lib/blog-posts';
import { markdownComponents, BG, FG, BRAND } from '@/lib/markdown-components';

// /gui content is frontend-only (no shell script counterpart in container/),
// so it lives in frontend/content/ rather than the blog-posts symlink.
const GUI_PATH = join(process.cwd(), 'content', 'gui.md');

function loadGui() {
  return parseFrontmatter(readFileSync(GUI_PATH, 'utf-8'));
}

export function generateMetadata(): Metadata {
  const { meta } = loadGui();
  const title = `${meta.title || 'gui'} — twaldin`;
  const description = meta.description || 'The no-terminal version of tim.waldin.net.';
  return {
    title,
    description,
    openGraph: { title, description, url: 'https://tim.waldin.net/gui', siteName: 'twaldin', type: 'website', images: [{ url: '/opengraph-image', width: 1200, height: 630 }] },
    twitter: { card: 'summary_large_image', title, description, images: ['/opengraph-image'] },
  };
}

export default function GuiPage() {
  const { meta, body } = loadGui();

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
          <span style={{ color: FG }}>gui</span>
        </div>
        <h1 style={{ color: BRAND, fontWeight: 'bold', fontSize: '1.5rem', lineHeight: 1.25, marginBottom: '1.5rem' }}>
          {meta.title || 'gui'}
        </h1>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {body}
        </ReactMarkdown>
      </div>
    </div>
  );
}
