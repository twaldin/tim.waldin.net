// Shared xterm behavior and typography. Palettes come from theme-manager.

export const terminalConfig = {
  fontFamily: '"JetBrainsMono Nerd Font Mono", "JetBrainsMono Nerd Font", "JetBrains Mono", "Fira Code", "Monaco", "Consolas", monospace',
  fontSize: 12,
  fontWeight: 'normal' as const,
  fontWeightBold: 'bold' as const,
  lineHeight: 1.0,

  cursorBlink: true,
  cursorStyle: 'block' as const,
  bellStyle: 'none' as const,

  scrollback: 10000,
  fastScrollModifier: 'alt' as const,

  allowProposedApi: true,
  allowTransparency: false,
  macOptionIsMeta: true,

  cols: 120,
  rows: 30,

};
