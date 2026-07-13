// Social-preview card generator: /repo-card/<name> renders a 1280x640 PNG in
// the same terminal-window style as the root opengraph-image, one per GitHub
// repo. The per-repo data (baked figlet lines, tagline, accent) lives in
// ../cards.json — add a repo with scripts/add-repo-card.sh, which renders the
// figlet and computes the fontSize for you. Accent is a terminalTheme color
// name: 'primary' green is the default; use a project color only when it has
// a strong identity (CS2 orange for trade-up-bot, leaderboard gold for
// agentelo, the site scripts' own red/cyan picks for stm32-games/resume).
import { readFileSync } from 'fs';
import { join } from 'path';
import { ImageResponse } from 'next/og';
import { terminalTheme } from '@/config/terminal-theme';
import cardsJson from '../cards.json';

type Card = {
  lines: string[];
  tagline: string;
  fontSize: number;
  bar: string;
  url: string;
  accent: string;
};

const CARDS: Record<string, Card> = cardsJson;
const themeColors: Record<string, string> = terminalTheme;

export const dynamic = 'force-static';

export function generateStaticParams() {
  return Object.keys(CARDS).map((name) => ({ name }));
}

export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  const card = CARDS[name];
  if (!card) return new Response('not found', { status: 404 });
  const accent = themeColors[card.accent] ?? terminalTheme.primary;
  const fontData = readFileSync(
    join(process.cwd(), 'public/fonts/JetBrainsMonoNerdFontMono-Regular.ttf'),
  );
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: terminalTheme.background, fontFamily: 'JetBrainsMono Nerd Font Mono' }}>
        <div style={{ display: 'flex', flexDirection: 'column', width: 1160, border: `1px solid ${terminalTheme.brightBlack}`, borderRadius: 12, backgroundColor: terminalTheme.background }}>
          <div style={{ display: 'flex', alignItems: 'center', padding: '14px 20px', borderBottom: `1px solid ${terminalTheme.brightBlack}` }}>
            <div style={{ display: 'flex', width: 14, height: 14, borderRadius: 7, backgroundColor: terminalTheme.red, marginRight: 10 }} />
            <div style={{ display: 'flex', width: 14, height: 14, borderRadius: 7, backgroundColor: terminalTheme.yellow, marginRight: 10 }} />
            <div style={{ display: 'flex', width: 14, height: 14, borderRadius: 7, backgroundColor: terminalTheme.green, marginRight: 16 }} />
            <div style={{ display: 'flex', color: terminalTheme.brightBlack, fontSize: 18 }}>{card.bar}</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', padding: '36px 40px 40px' }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {card.lines.map((line, i) => (
                <div key={i} style={{ display: 'flex', whiteSpace: 'pre', color: accent, fontSize: card.fontSize, lineHeight: 1.15 }}>
                  {line}
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', color: terminalTheme.foreground, fontSize: 26, marginTop: 36 }}>{card.tagline}</div>
            <div style={{ display: 'flex', color: terminalTheme.brightBlack, fontSize: 22, marginTop: 14 }}>{card.url}</div>
          </div>
        </div>
      </div>
    ),
    { width: 1280, height: 640, fonts: [{ name: 'JetBrainsMono Nerd Font Mono', data: fontData, style: 'normal', weight: 400 }] },
  );
}
