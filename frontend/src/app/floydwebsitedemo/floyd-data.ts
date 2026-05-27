export type SliderFmt = 'int' | '1f' | '2f';

export type Entry =
  | { kind: 'header'; name: string; action?: boolean }
  | { kind: 'toggle'; name: string; value: boolean }
  | { kind: 'slider'; name: string; min: number; max: number; value: number; fmt: SliderFmt }
  | { kind: 'select'; name: string; value: string };

export type CategoryId = 'render' | 'hiders' | 'player' | 'camera' | 'cosmetic' | 'agent';

export const CATEGORIES: { id: CategoryId; label: string }[] = [
  { id: 'render', label: 'Render' },
  { id: 'hiders', label: 'Hiders' },
  { id: 'player', label: 'Player' },
  { id: 'camera', label: 'Camera' },
  { id: 'cosmetic', label: 'Cosmetic' },
  { id: 'agent', label: 'Agent' },
];

export const ENTRIES: Record<CategoryId, Entry[]> = {
  render: [
    { kind: 'header', name: 'Render', action: true },
    { kind: 'toggle', name: 'Time Changer', value: false },
    { kind: 'slider', name: 'Time', min: 0, max: 100, value: 50, fmt: 'int' },
    { kind: 'toggle', name: 'Custom Scoreboard', value: true },
    { kind: 'toggle', name: 'Borderless Window', value: false },
    { kind: 'header', name: 'X-Ray' },
    { kind: 'toggle', name: 'Enabled', value: false },
    { kind: 'slider', name: 'Opacity', min: 0.05, max: 1, value: 0.3, fmt: '2f' },
    { kind: 'select', name: 'Opaque Block', value: 'minecraft:glass' },
    { kind: 'header', name: 'HUD' },
    { kind: 'slider', name: 'Inventory HUD Scale', min: 0.5, max: 2, value: 1.1, fmt: '2f' },
    { kind: 'slider', name: 'HUD Corner Radius', min: 0, max: 12, value: 0, fmt: 'int' },
  ],
  hiders: [
    { kind: 'header', name: 'Hiders', action: true },
    { kind: 'toggle', name: 'No Hurt Camera', value: true },
    { kind: 'toggle', name: 'Remove Fire Overlay', value: true },
    { kind: 'toggle', name: 'Disable Hunger Bar', value: false },
    { kind: 'toggle', name: 'Hide Potion Effects', value: false },
    { kind: 'toggle', name: '3rd Person Crosshair', value: true },
    { kind: 'toggle', name: 'Hide Entity Fire', value: false },
    { kind: 'toggle', name: 'Disable Arrows', value: true },
    { kind: 'toggle', name: 'No Explosion Particles', value: false },
    { kind: 'toggle', name: 'Remove Tab Ping', value: true },
    { kind: 'toggle', name: 'Server ID Hider', value: false },
    { kind: 'toggle', name: 'Profile ID Hider', value: true },
    { kind: 'select', name: 'Armor Target', value: 'Others' },
  ],
  player: [
    { kind: 'header', name: 'Neck Hider', action: true },
    { kind: 'toggle', name: 'Enabled', value: false },
    { kind: 'select', name: 'Default Nick', value: 'George Floyd' },
    { kind: 'select', name: 'Name Mappings', value: '0 entries' },
    { kind: 'header', name: 'Player Size', action: true },
    { kind: 'slider', name: 'X', min: -1, max: 5, value: 1, fmt: '2f' },
    { kind: 'slider', name: 'Y', min: -1, max: 5, value: 1, fmt: '2f' },
    { kind: 'slider', name: 'Z', min: -1, max: 5, value: 1, fmt: '2f' },
    { kind: 'select', name: 'Target', value: 'Self' },
  ],
  camera: [
    { kind: 'header', name: 'Camera', action: true },
    { kind: 'toggle', name: 'Freecam', value: false },
    { kind: 'toggle', name: 'Freelook', value: true },
    { kind: 'slider', name: 'Speed', min: 0.1, max: 10, value: 1, fmt: '1f' },
    { kind: 'slider', name: 'Distance', min: 1, max: 20, value: 4, fmt: '1f' },
    { kind: 'toggle', name: 'Disable Front Cam', value: false },
    { kind: 'toggle', name: 'Disable Back Cam', value: false },
    { kind: 'toggle', name: 'No Third-Person Clipping', value: true },
    { kind: 'toggle', name: 'Scrolling Changes Distance', value: true },
  ],
  cosmetic: [
    { kind: 'header', name: 'Custom Skin', action: true },
    { kind: 'toggle', name: 'Enabled', value: true },
    { kind: 'select', name: 'Skin Asset', value: 'custom.png' },
    { kind: 'header', name: 'Custom Cape', action: true },
    { kind: 'toggle', name: 'Enabled', value: true },
    { kind: 'select', name: 'Cape Asset', value: 'default_cape.png' },
    { kind: 'header', name: 'Cone Hat', action: true },
    { kind: 'toggle', name: 'Enabled', value: false },
  ],
  agent: [
    { kind: 'header', name: 'Local Control', action: true },
    { kind: 'toggle', name: 'Bridge Enabled', value: true },
    { kind: 'slider', name: 'Port', min: 1024, max: 65535, value: 38765, fmt: 'int' },
    { kind: 'select', name: 'Endpoints', value: '/state /screen /screenshot' },
    { kind: 'header', name: 'Semantic Tools' },
    { kind: 'toggle', name: 'Baritone goto/mine/stop', value: true },
    { kind: 'toggle', name: 'Craft Item', value: true },
    { kind: 'toggle', name: 'Smelt Item', value: true },
    { kind: 'toggle', name: 'Read Screen', value: true },
    { kind: 'toggle', name: 'Click Slot Matching', value: true },
    { kind: 'select', name: 'Proof Suite', value: '3/3 vanilla long-chain' },
  ],
};

export interface ModuleSpec {
  cat: string;
  name: string;
  desc: string;
  tags: string[];
}

export const MODULES: ModuleSpec[] = [
  {
    cat: 'Fabric',
    name: 'Odin-backed FloydAddons',
    desc: 'Fabric 1.21.11 client mod mounted on Odin module, config, event, ClickGUI, HUD, and render scaffolding.',
    tags: ['floydaddons', 'Odin scaffold', 'Fabric 1.21.11'],
  },
  {
    cat: 'Render',
    name: 'HUD, X-Ray, ESP, Animations',
    desc: 'Custom scoreboard and inventory HUD, X-Ray opacity controls, mob ESP filters, tracers, hitboxes, and held-item animation tuning.',
    tags: ['Scoreboard HUD', 'Mob ESP', 'X-Ray'],
  },
  {
    cat: 'Privacy',
    name: 'Hiders and Nick Hider',
    desc: 'Overlay, particle, armor, arrow, tab-ping, server-ID, profile-ID, and nickname replacement paths are exposed as Floyd modules.',
    tags: ['Server ID Hider', 'Profile IDs', 'No armor modes'],
  },
  {
    cat: 'Camera',
    name: 'Freecam and Freelook',
    desc: 'Detached camera, orbit freelook, third-person distance, no-clip distance, and scroll-to-zoom controls.',
    tags: ['Freecam', 'Freelook', 'F5 controls'],
  },
  {
    cat: 'Cosmetic',
    name: 'Skin, Cape, Cone Hat',
    desc: 'Retained Floyd runtime assets drive the custom skin, cape, and cone-hat surfaces inside the active module registry.',
    tags: ['Custom skin', 'Cape asset', 'Cone model'],
  },
  {
    cat: 'Agent',
    name: 'Natural-language harness',
    desc: 'Loopback client bridge plus Baritone-backed semantic tools for observed, verified Minecraft actions and SkyBlock-specific state capture.',
    tags: ['Local Control', 'Baritone tools', 'SkyBlock GUI model'],
  },
];

export const AGENT_STEPS = [
  'observe_state: inventory, hotbar, scoreboard, tablist, entities, Baritone status',
  'execute_plan: make_iron_pickaxe -> equip iron -> mine diamonds -> craft diamond pickaxe',
  'verify: inventory_contains minecraft:diamond_pickaxe=1 with structured evidence',
];

export function formatValue(value: number, fmt: SliderFmt): string {
  if (fmt === 'int') return Math.round(value).toString();
  if (fmt === '1f') return value.toFixed(1);
  return value.toFixed(2);
}

export function roundForFmt(value: number, fmt: SliderFmt): number {
  if (fmt === 'int') return Math.round(value);
  if (fmt === '1f') return Math.round(value * 10) / 10;
  return Math.round(value * 100) / 100;
}

export function stepForFmt(fmt: SliderFmt): number {
  if (fmt === 'int') return 1;
  if (fmt === '1f') return 0.1;
  return 0.01;
}
