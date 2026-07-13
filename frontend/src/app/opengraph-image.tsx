import { readFileSync } from 'fs';
import { join } from 'path';
import { ImageResponse } from 'next/og';
import { terminalTheme } from '@/config/terminal-theme';

export const alt = 'twaldin — interactive terminal portfolio';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

// figlet -f DOS_Rebel "twaldin" — the same banner the container's welcome
// script renders, baked in so the OG image doesn't need figlet at build time.
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

export default function OpenGraphImage() {
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
          backgroundColor: terminalTheme.background,
          fontFamily: 'JetBrainsMono Nerd Font Mono',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            width: 1080,
            border: `1px solid ${terminalTheme.brightBlack}`,
            borderRadius: 12,
            backgroundColor: terminalTheme.background,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '14px 20px',
              borderBottom: `1px solid ${terminalTheme.brightBlack}`,
            }}
          >
            <div style={{ display: 'flex', width: 14, height: 14, borderRadius: 7, backgroundColor: terminalTheme.red, marginRight: 10 }} />
            <div style={{ display: 'flex', width: 14, height: 14, borderRadius: 7, backgroundColor: terminalTheme.yellow, marginRight: 10 }} />
            <div style={{ display: 'flex', width: 14, height: 14, borderRadius: 7, backgroundColor: terminalTheme.green, marginRight: 16 }} />
            <div style={{ display: 'flex', color: terminalTheme.brightBlack, fontSize: 18 }}>
              tim.waldin.net — zsh
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', padding: '36px 40px 40px' }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {FIGLET_TWALDIN.map((line, i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    whiteSpace: 'pre',
                    color: terminalTheme.primary,
                    fontSize: 24,
                    lineHeight: 1.15,
                  }}
                >
                  {line}
                </div>
              ))}
            </div>
            <div
              style={{
                display: 'flex',
                color: terminalTheme.foreground,
                fontSize: 26,
                marginTop: 36,
              }}
            >
              ❯ interactive terminal portfolio — every visitor gets their own Docker container
            </div>
            <div
              style={{
                display: 'flex',
                color: terminalTheme.brightBlack,
                fontSize: 22,
                marginTop: 14,
              }}
            >
              tim.waldin.net
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
