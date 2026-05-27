// Data model for the Jasper Client UI demo. The GUI entries mirror the real
// in-game client config tree (categories → modules → toggles/sliders) so the
// interactive panel feels authentic; the module manifest below drives the
// editorial capability section.

export type SliderFmt = 'int' | '0f' | '1f' | '2f';

export type Entry =
  | { kind: 'header'; name: string; action?: boolean }
  | { kind: 'toggle'; name: string; value: boolean }
  | { kind: 'slider'; name: string; min: number; max: number; value: number; fmt: SliderFmt }
  | { kind: 'keybind'; name: string };

export type CategoryId = 'mining' | 'combat' | 'misc' | 'routes' | 'galatea';

export const CATEGORIES: { id: CategoryId; label: string }[] = [
  { id: 'mining', label: 'Mining' },
  { id: 'combat', label: 'Combat' },
  { id: 'misc', label: 'Misc' },
  { id: 'routes', label: 'Routes' },
  { id: 'galatea', label: 'Galatea' },
];

export const ENTRIES: Record<CategoryId, Entry[]> = {
  mining: [
    { kind: 'header', name: 'Commission Macro', action: true },
    { kind: 'slider', name: 'Mining Speed', min: 100, max: 500, value: 250, fmt: 'int' },
    { kind: 'slider', name: 'Rotation Power', min: 10, max: 100, value: 60, fmt: '0f' },
    { kind: 'slider', name: 'Randomness', min: 0, max: 20, value: 5, fmt: '1f' },
    { kind: 'toggle', name: 'Commission Reader', value: true },
    { kind: 'toggle', name: 'Crouch Mining', value: false },
    { kind: 'toggle', name: 'Drill Reset Fix', value: true },
    { kind: 'toggle', name: 'Royal Pigeon', value: false },
    { kind: 'header', name: 'Mithril Priority' },
    { kind: 'toggle', name: 'Gray Mithril', value: false },
    { kind: 'toggle', name: 'Green Mithril', value: false },
    { kind: 'toggle', name: 'Blue Mithril', value: true },
    { kind: 'header', name: 'Commission HUD' },
    { kind: 'toggle', name: 'Enable HUD', value: true },
    { kind: 'toggle', name: 'ESP Outline', value: false },
    { kind: 'slider', name: 'HUD Scale', min: 0.6, max: 1.8, value: 1.0, fmt: '2f' },
    { kind: 'header', name: 'Mining Bot', action: true },
    { kind: 'slider', name: 'Tool Slot', min: 1, max: 8, value: 1, fmt: 'int' },
    { kind: 'slider', name: 'Ghost Weapon Slot', min: 1, max: 8, value: 1, fmt: 'int' },
    { kind: 'slider', name: 'Aim Radius', min: 1, max: 8, value: 3.5, fmt: '1f' },
    { kind: 'slider', name: 'Rotation Power', min: 10, max: 100, value: 60, fmt: '0f' },
    { kind: 'slider', name: 'Randomness', min: 0, max: 20, value: 5, fmt: '1f' },
    { kind: 'header', name: 'Gemstone Macro', action: true },
    { kind: 'toggle', name: 'Kill Enemies', value: false },
    { kind: 'toggle', name: 'Route Rendering', value: true },
    { kind: 'toggle', name: 'Route Index Numbers', value: false },
    { kind: 'header', name: 'Target Gems' },
    { kind: 'toggle', name: 'Ruby', value: true },
    { kind: 'toggle', name: 'Jade', value: true },
    { kind: 'toggle', name: 'Amber', value: false },
    { kind: 'toggle', name: 'Sapphire', value: true },
    { kind: 'toggle', name: 'Amethyst', value: false },
    { kind: 'toggle', name: 'Topaz', value: false },
    { kind: 'toggle', name: 'Opal', value: false },
    { kind: 'toggle', name: 'Jasper', value: true },
    { kind: 'header', name: 'Gemstone HUD' },
    { kind: 'slider', name: 'HUD Scale', min: 0.6, max: 1.8, value: 1.0, fmt: '2f' },
  ],
  combat: [
    { kind: 'header', name: 'Kill Bot', action: true },
    { kind: 'slider', name: 'Range', min: 1.5, max: 6.0, value: 4.0, fmt: '1f' },
    { kind: 'slider', name: 'FOV', min: 30, max: 180, value: 120, fmt: '0f' },
    { kind: 'header', name: 'Rotation' },
    { kind: 'slider', name: 'Yaw Speed', min: 0.5, max: 8.0, value: 2.5, fmt: '1f' },
    { kind: 'slider', name: 'Pitch Speed', min: 0.5, max: 8.0, value: 2.0, fmt: '1f' },
    { kind: 'toggle', name: 'Random Rotations', value: false },
    { kind: 'slider', name: 'Random Power', min: 0.1, max: 2.0, value: 0.6, fmt: '1f' },
    { kind: 'toggle', name: 'Legit Mode', value: false },
    { kind: 'header', name: 'Clicker' },
    { kind: 'toggle', name: 'Auto Clicker', value: false },
    { kind: 'slider', name: 'Clicker CPS', min: 1, max: 20, value: 8.0, fmt: '1f' },
    { kind: 'slider', name: 'CPS Min', min: 1, max: 20, value: 6.0, fmt: '1f' },
    { kind: 'slider', name: 'CPS Max', min: 1, max: 20, value: 12.0, fmt: '1f' },
    { kind: 'header', name: 'ESP & Misc' },
    { kind: 'toggle', name: 'Kill Bot ESP', value: false },
    { kind: 'toggle', name: 'ESP Chroma', value: false },
    { kind: 'slider', name: 'ESP Line Width', min: 1.0, max: 5.0, value: 2.0, fmt: '1f' },
    { kind: 'toggle', name: 'Kill Walk', value: false },
    { kind: 'toggle', name: 'Attack Players', value: false },
    { kind: 'toggle', name: 'Through Walls', value: false },
  ],
  misc: [
    { kind: 'header', name: 'Stash Crafter', action: true },
    { kind: 'slider', name: 'Click CPS', min: 1.0, max: 12.0, value: 5.0, fmt: '1f' },
    { kind: 'header', name: 'XRay' },
    { kind: 'toggle', name: 'Enable XRay', value: false },
    { kind: 'toggle', name: 'Hide Ores (Gem-Only)', value: false },
    { kind: 'header', name: 'Visible Gemstones' },
    { kind: 'toggle', name: 'Ruby', value: true },
    { kind: 'toggle', name: 'Jade', value: true },
    { kind: 'toggle', name: 'Amber', value: false },
    { kind: 'toggle', name: 'Sapphire', value: true },
    { kind: 'toggle', name: 'Amethyst', value: false },
    { kind: 'toggle', name: 'Topaz', value: false },
    { kind: 'toggle', name: 'Opal', value: false },
    { kind: 'toggle', name: 'Jasper', value: true },
    { kind: 'toggle', name: 'Onyx', value: false },
    { kind: 'toggle', name: 'Aquamarine', value: false },
    { kind: 'header', name: 'Lighting' },
    { kind: 'toggle', name: 'Full Bright', value: false },
    { kind: 'header', name: 'UI' },
    { kind: 'slider', name: 'Corner Radius', min: 4, max: 24, value: 12, fmt: 'int' },
    { kind: 'slider', name: 'Backdrop Opacity', min: 0, max: 220, value: 180, fmt: 'int' },
    { kind: 'header', name: 'Macro Scheduler' },
    { kind: 'slider', name: 'Commission Limit', min: 0, max: 500, value: 0, fmt: 'int' },
    { kind: 'slider', name: 'Time Limit (min)', min: 0, max: 1440, value: 0, fmt: 'int' },
    { kind: 'header', name: 'Nick Hider' },
    { kind: 'toggle', name: 'Enable Nick Hider', value: false },
    { kind: 'header', name: 'Spotify' },
    { kind: 'toggle', name: 'Spotify HUD', value: false },
    { kind: 'slider', name: 'HUD Scale', min: 0.6, max: 1.8, value: 1.0, fmt: '2f' },
  ],
  routes: [
    { kind: 'header', name: 'Routes' },
    { kind: 'toggle', name: 'Route Rendering', value: true },
    { kind: 'toggle', name: 'Etherwarp Route Rendering', value: false },
    { kind: 'toggle', name: 'Gemstone Route Rendering', value: false },
    { kind: 'toggle', name: 'Shard Route Rendering', value: false },
    { kind: 'header', name: 'Mining Rotations' },
    { kind: 'slider', name: 'Rotation Power', min: 10, max: 100, value: 60, fmt: '0f' },
    { kind: 'slider', name: 'Randomness', min: 0, max: 20, value: 5, fmt: '1f' },
    { kind: 'header', name: 'Combat Rotations' },
    { kind: 'slider', name: 'Yaw Speed', min: 0.5, max: 8.0, value: 2.5, fmt: '1f' },
    { kind: 'slider', name: 'Pitch Speed', min: 0.5, max: 8.0, value: 2.0, fmt: '1f' },
    { kind: 'slider', name: 'Random Power', min: 0.1, max: 2.0, value: 0.6, fmt: '1f' },
    { kind: 'toggle', name: 'Random Rotations', value: false },
    { kind: 'header', name: 'LineToWaypoint' },
    { kind: 'toggle', name: 'LineToWaypoint', value: false },
    { kind: 'slider', name: 'Line Width', min: 1.0, max: 5.0, value: 2.0, fmt: '1f' },
    { kind: 'slider', name: 'Line Red', min: 0, max: 255, value: 255, fmt: 'int' },
    { kind: 'slider', name: 'Line Green', min: 0, max: 255, value: 100, fmt: 'int' },
    { kind: 'slider', name: 'Line Blue', min: 0, max: 255, value: 50, fmt: 'int' },
    { kind: 'slider', name: 'Line Alpha', min: 0, max: 255, value: 200, fmt: 'int' },
  ],
  galatea: [
    { kind: 'header', name: 'Routes' },
    { kind: 'toggle', name: 'Shard Routes', value: false },
    { kind: 'toggle', name: 'Route Index Numbers', value: false },
    { kind: 'header', name: 'ESP' },
    { kind: 'toggle', name: 'Green Shulker ESP', value: false },
    { kind: 'toggle', name: 'Line To Shulker ESP', value: false },
    { kind: 'header', name: 'Automation' },
    { kind: 'toggle', name: 'Auto Shulker', value: false },
    { kind: 'header', name: 'Keybinds' },
    { kind: 'keybind', name: 'Add Waypoint' },
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
    cat: 'Mining',
    name: 'Commission Macro',
    desc: 'Reads the board, prioritises Mithril, handles crouch-mining and the drill reset bug — with a live HUD.',
    tags: ['Mithril priority', 'Crouch mining', 'Live HUD'],
  },
  {
    cat: 'Mining',
    name: 'Gemstone Macro',
    desc: 'Per-gem targeting across the full gemstone set, with on-floor route rendering.',
    tags: ['Per-gem targeting', 'Route rendering', 'Gemstone HUD'],
  },
  {
    cat: 'Combat',
    name: 'Kill Bot',
    desc: 'Tunable range, FOV and rotation curves, an auto-clicker and through-wall ESP.',
    tags: ['Range & FOV', 'Auto-clicker', 'ESP'],
  },
  {
    cat: 'Misc',
    name: 'Stash Crafter',
    desc: 'Hands-free stash crafting from an item-name filter at your chosen CPS.',
    tags: ['Item filter', 'Click CPS', 'Unattended'],
  },
  {
    cat: 'Misc',
    name: 'Spotify Integration',
    desc: 'A now-playing HUD with track and album art, rendered in-game — no alt-tabbing.',
    tags: ['Now-playing HUD', 'Album art'],
  },
  {
    cat: 'Utility',
    name: 'X-Ray & Utilities',
    desc: 'Gemstone X-Ray, Full Bright, Nick Hider, waypoints and route rendering.',
    tags: ['Per-gem X-Ray', 'Full Bright', 'LineToWaypoint'],
  },
];

export function formatValue(value: number, fmt: SliderFmt): string {
  if (fmt === 'int') return Math.round(value).toString();
  if (fmt === '0f') return value.toFixed(0);
  if (fmt === '1f') return value.toFixed(1);
  return value.toFixed(2);
}

export function roundForFmt(value: number, fmt: SliderFmt): number {
  if (fmt === 'int' || fmt === '0f') return Math.round(value);
  if (fmt === '1f') return Math.round(value * 10) / 10;
  return Math.round(value * 100) / 100;
}

export function stepForFmt(fmt: SliderFmt): number {
  if (fmt === 'int' || fmt === '0f') return 1;
  if (fmt === '1f') return 0.1;
  return 0.01;
}
