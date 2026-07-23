import { readFileSync } from 'fs';
import { join } from 'path';
import { ImageResponse } from 'next/og';
import { DEFAULT_DARK_THEME, themes } from '@/config/themes';
import { getPost, listPostSlugs, postExcerpt } from '@/lib/blog-posts';

// Per-post share card in the same terminal-window style as the root
// opengraph-image and /repo-card/<name>: post title in the accent instead of
// a figlet (titles are prose-length), date eyebrow, first-paragraph excerpt.
// Generated at build for every post via the segment's static params — new
// posts get a card for free. scripts/gen-blog-cards.sh dumps them as PNGs.
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
const defaultTheme = themes[DEFAULT_DARK_THEME];


export function generateStaticParams() {
  return listPostSlugs().map((slug) => ({ slug }));
}

export default async function OgImage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = getPost(slug);
  const title = post?.meta.title || slug;
  const date = post?.meta.date || '';
  const excerpt = post ? postExcerpt(post.body, 150) : '';
  const fontData = readFileSync(
    join(process.cwd(), 'public/fonts/JetBrainsMonoNerdFontMono-Regular.ttf'),
  );

  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: defaultTheme.background, fontFamily: 'JetBrainsMono Nerd Font Mono' }}>
        <div style={{ display: 'flex', flexDirection: 'column', width: 1080, border: `1px solid ${defaultTheme.brightBlack}`, borderRadius: 12, backgroundColor: defaultTheme.background }}>
          <div style={{ display: 'flex', alignItems: 'center', padding: '14px 20px', borderBottom: `1px solid ${defaultTheme.brightBlack}` }}>
            <div style={{ display: 'flex', width: 14, height: 14, borderRadius: 7, backgroundColor: defaultTheme.red, marginRight: 10 }} />
            <div style={{ display: 'flex', width: 14, height: 14, borderRadius: 7, backgroundColor: defaultTheme.yellow, marginRight: 10 }} />
            <div style={{ display: 'flex', width: 14, height: 14, borderRadius: 7, backgroundColor: defaultTheme.green, marginRight: 16 }} />
            <div style={{ display: 'flex', color: defaultTheme.brightBlack, fontSize: 18 }}>
              tim.waldin.net/blog — zsh
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', padding: '38px 44px 42px' }}>
            <div style={{ display: 'flex', color: defaultTheme.brightBlack, fontSize: 22 }}>
              ❯ blog{date ? ` · ${date}` : ''}
            </div>
            <div style={{ display: 'flex', color: defaultTheme.green, fontSize: 44, lineHeight: 1.25, marginTop: 20, textWrap: 'balance' }}>
              {title}
            </div>
            {excerpt ? (
              <div style={{ display: 'flex', color: defaultTheme.foreground, fontSize: 22, lineHeight: 1.5, marginTop: 26 }}>
                {excerpt}
              </div>
            ) : null}
            <div style={{ display: 'flex', color: defaultTheme.brightBlack, fontSize: 20, marginTop: 24 }}>
              tim.waldin.net/blog/{slug}
            </div>
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: 'JetBrainsMono Nerd Font Mono', data: fontData, style: 'normal', weight: 400 },
      ],
    },
  );
}
