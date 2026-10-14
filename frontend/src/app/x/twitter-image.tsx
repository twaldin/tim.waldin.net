import { readFileSync } from 'fs';
import { join } from 'path';
import { ImageResponse } from 'next/og';
import { DEFAULT_DARK_THEME, themes } from '@/config/themes';

export const alt = 'twaldin — a live terminal you can play in the post';
export const size = { width: 1200, height: 1200 };
export const contentType = 'image/png';
const defaultTheme = themes[DEFAULT_DARK_THEME];

const FIGLET_TWALDIN = [
  '  █████                              ████      █████  ███            ',
  ' ░░███                              ░░███     ░░███  ░░░             ',
  ' ███████   █████ ███ █████  ██████   ░███   ███████  ████  ████████  ',
  '░░░███░   ░░███ ░███░░███  ░░░░░███  ░███  ███░░███ ░░███ ░░███░░███ ',
  '  ░███     ░███ ░███ ░███   ███████  ░███ ░███ ░███  ░███  ░███ ░███ ',
  '  ░███ ███ ░░███████████   ███░░███  ░███ ░███ ░███  ░███  ░███ ░███ ',
  '  ░░█████   ░░████░████   ░░████████ █████░░████████ █████ ████ █████',
  '   ░░░░░     ░░░░ ░░░░     ░░░░░░░░ ░░░░░  ░░░░░░░░ ░░░░░ ░░░░ ░░░░░',
];

export default function TwitterImage() {
  const fontData = readFileSync(
    join(process.cwd(), 'public/fonts/JetBrainsMonoNerdFontMono-Regular.ttf'),
  );

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: defaultTheme.background,
          fontFamily: 'JetBrainsMono Nerd Font Mono',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            width: 1100,
            height: 1100,
            border: `1px solid ${defaultTheme.brightBlack}`,
            borderRadius: 12,
            backgroundColor: defaultTheme.background,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '14px 20px',
              borderBottom: `1px solid ${defaultTheme.brightBlack}`,
            }}
          >
            <div style={{ display: 'flex', width: 14, height: 14, borderRadius: 7, backgroundColor: defaultTheme.red, marginRight: 10 }} />
            <div style={{ display: 'flex', width: 14, height: 14, borderRadius: 7, backgroundColor: defaultTheme.yellow, marginRight: 10 }} />
            <div style={{ display: 'flex', width: 14, height: 14, borderRadius: 7, backgroundColor: defaultTheme.green, marginRight: 16 }} />
            <div style={{ display: 'flex', color: defaultTheme.brightBlack, fontSize: 18 }}>
              tim.waldin.net — zsh
            </div>
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              flexGrow: 1,
              padding: '48px 48px 56px',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {FIGLET_TWALDIN.map((line, i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    whiteSpace: 'pre',
                    color: defaultTheme.green,
                    fontSize: 23,
                    lineHeight: 1.15,
                  }}
                >
                  {line}
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', color: defaultTheme.foreground, fontSize: 38 }}>
                ❯ a live terminal, right in the post
              </div>
              <div style={{ display: 'flex', color: defaultTheme.brightBlack, fontSize: 28, marginTop: 18 }}>
                every visitor gets their own Docker container
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', color: defaultTheme.green, fontSize: 52 }}>
                ▶ tap for a live shell
              </div>
              <div style={{ display: 'flex', color: defaultTheme.brightBlack, fontSize: 28, marginTop: 18 }}>
                try: projects · about · blog
              </div>
            </div>
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        {
          name: 'JetBrainsMono Nerd Font Mono',
          data: fontData,
          style: 'normal',
          weight: 400,
        },
      ],
    },
  );
}
