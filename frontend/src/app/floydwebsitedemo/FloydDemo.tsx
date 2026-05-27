'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import {
  AGENT_STEPS,
  CATEGORIES,
  ENTRIES,
  MODULES,
  formatValue,
  roundForFmt,
  stepForFmt,
  type CategoryId,
  type Entry,
  type SliderFmt,
} from './floyd-data';

type IconProps = { size?: number };
const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function BoxIcon({ size = 14 }: IconProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden><path d="m3 7 9-4 9 4-9 4-9-4Z" /><path d="M3 7v10l9 4 9-4V7" /><path d="M12 11v10" /></svg>;
}
function EyeIcon({ size = 14 }: IconProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.7" /></svg>;
}
function UserIcon({ size = 14 }: IconProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden><path d="M20 21a8 8 0 0 0-16 0" /><circle cx="12" cy="7" r="4" /></svg>;
}
function CameraIcon({ size = 14 }: IconProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden><path d="M4 8h3l2-3h6l2 3h3v11H4V8Z" /><circle cx="12" cy="13" r="3.4" /></svg>;
}
function ShirtIcon({ size = 14 }: IconProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden><path d="m8 4 4 2 4-2 4 3-3 4v9H7v-9L4 7l4-3Z" /><path d="M8 4c.7 2 2 3 4 3s3.3-1 4-3" /></svg>;
}
function BotIcon({ size = 14 }: IconProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden><rect x="5" y="7" width="14" height="11" rx="3" /><path d="M12 7V3M8.5 12h0M15.5 12h0M9 16h6" /></svg>;
}
function ArrowRight({ size = 16 }: IconProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
}

const CAT_ICONS: Record<CategoryId, (p: IconProps) => ReactNode> = {
  render: BoxIcon,
  hiders: EyeIcon,
  player: UserIcon,
  camera: CameraIcon,
  cosmetic: ShirtIcon,
  agent: BotIcon,
};

type KeyedEntry = { entry: Entry; key: string };

function initToggles(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  (Object.keys(ENTRIES) as CategoryId[]).forEach((cat) =>
    ENTRIES[cat].forEach((entry, i) => {
      if (entry.kind === 'toggle') out[`${cat}:${i}`] = entry.value;
    }),
  );
  return out;
}

function initSliders(): Record<string, number> {
  const out: Record<string, number> = {};
  (Object.keys(ENTRIES) as CategoryId[]).forEach((cat) =>
    ENTRIES[cat].forEach((entry, i) => {
      if (entry.kind === 'slider') out[`${cat}:${i}`] = entry.value;
    }),
  );
  return out;
}

function GuiSlider({
  name,
  min,
  max,
  fmt,
  value,
  onChange,
}: {
  name: string;
  min: number;
  max: number;
  fmt: SliderFmt;
  value: number;
  onChange: (v: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const pct = ((value - min) / (max - min)) * 100;

  const fromClientX = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el) return value;
      const rect = el.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return roundForFmt(min + ratio * (max - min), fmt);
    },
    [min, max, fmt, value],
  );

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    onChange(fromClientX(e.clientX));
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    onChange(fromClientX(e.clientX));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = stepForFmt(fmt);
    let next = value;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = value + step;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = value - step;
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    else return;
    e.preventDefault();
    onChange(roundForFmt(Math.max(min, Math.min(max, next)), fmt));
  };

  return (
    <div className="fw-row static">
      <span className="fw-row-name">{name}</span>
      <div className="fw-slider-right">
        <span className="fw-slider-val">{formatValue(value, fmt)}</span>
        <div
          ref={trackRef}
          className="fw-track"
          role="slider"
          tabIndex={0}
          aria-label={name}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          aria-valuetext={formatValue(value, fmt)}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onKeyDown={onKeyDown}
        >
          <span className="fill" style={{ width: `${pct}%` }} />
          <span className="thumb" style={{ left: `${pct}%` }} />
        </div>
      </div>
    </div>
  );
}

function FloydPanel() {
  const [activeCat, setActiveCat] = useState<CategoryId>('render');
  const [query, setQuery] = useState('');
  const [toggles, setToggles] = useState<Record<string, boolean>>(initToggles);
  const [sliders, setSliders] = useState<Record<string, number>>(initSliders);
  const [running, setRunning] = useState<Record<string, boolean>>({ 'agent:0': true });
  const [open, setOpen] = useState(true);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const panelRef = useRef<HTMLDivElement>(null);
  const drag = useRef({ active: false, sx: 0, sy: 0, ox: 0, oy: 0 });

  const keyed = useMemo(() => {
    const out = {} as Record<CategoryId, KeyedEntry[]>;
    (Object.keys(ENTRIES) as CategoryId[]).forEach((cat) => {
      out[cat] = ENTRIES[cat].map((entry, i) => ({ entry, key: `${cat}:${i}` }));
    });
    return out;
  }, []);

  const searchResults = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return null;
    const hits: KeyedEntry[] = [];
    (Object.keys(keyed) as CategoryId[]).forEach((cat) =>
      keyed[cat].forEach((item) => {
        if (item.entry.kind !== 'header' && item.entry.name.toLowerCase().includes(q)) hits.push(item);
      }),
    );
    return hits;
  }, [keyed, query]);

  const onHandleDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { active: true, sx: e.clientX, sy: e.clientY, ox: offset.x, oy: offset.y };
  };
  const onHandleMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current.active) return;
    const w = panelRef.current?.offsetWidth ?? 680;
    const maxX = Math.max(24, (window.innerWidth - w) / 2);
    setOffset({
      x: Math.max(-maxX, Math.min(maxX, drag.current.ox + e.clientX - drag.current.sx)),
      y: Math.max(-160, Math.min(160, drag.current.oy + e.clientY - drag.current.sy)),
    });
  };
  const onHandleUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    drag.current.active = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const renderRow = ({ entry, key }: KeyedEntry): ReactNode => {
    if (entry.kind === 'header') {
      const isRunning = running[key] ?? false;
      return (
        <div className="fw-row-head" key={key}>
          <h5>{entry.name}</h5>
          {entry.action && (
            <button
              type="button"
              className={`fw-play${isRunning ? ' on' : ''}`}
              aria-label={`${isRunning ? 'Stop' : 'Start'} ${entry.name}`}
              aria-pressed={isRunning}
              onClick={() => setRunning((state) => ({ ...state, [key]: !isRunning }))}
            >
              <span className={isRunning ? 'sq' : 'tri'} />
            </button>
          )}
        </div>
      );
    }
    if (entry.kind === 'toggle') {
      const on = toggles[key] ?? entry.value;
      return (
        <button
          type="button"
          className="fw-row"
          role="switch"
          aria-checked={on}
          aria-label={entry.name}
          key={key}
          onClick={() => setToggles((state) => ({ ...state, [key]: !on }))}
        >
          <span className="fw-row-name">{entry.name}</span>
          <span className={`fw-tog${on ? ' on' : ''}`}><i /></span>
        </button>
      );
    }
    if (entry.kind === 'slider') {
      return (
        <GuiSlider
          key={key}
          name={entry.name}
          min={entry.min}
          max={entry.max}
          fmt={entry.fmt}
          value={sliders[key] ?? entry.value}
          onChange={(v) => setSliders((state) => ({ ...state, [key]: v }))}
        />
      );
    }
    return (
      <div className="fw-row static" key={key}>
        <span className="fw-row-name">{entry.name}</span>
        <button type="button" className="fw-pill">{entry.value}</button>
      </div>
    );
  };

  const list = searchResults ?? keyed[activeCat];

  return (
    <div className="fw-stage">
      <div className="fw-product-card" aria-hidden>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/floyd/floydbg.png" alt="" />
        <span>runtime assets</span>
      </div>
      <div className="fw-tilt">
        <div
          className="fw-window"
          ref={panelRef}
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px)`,
            opacity: open ? 1 : 0,
            pointerEvents: open ? 'auto' : 'none',
          }}
          aria-hidden={!open}
        >
          <div
            className="fw-titlebar fw-handle"
            onPointerDown={onHandleDown}
            onPointerMove={onHandleMove}
            onPointerUp={onHandleUp}
          >
            <span className="fw-traffic" aria-hidden><i /><i /><i /></span>
            <span className="fw-titlebar-name"><b>FloydAddons</b> ClickGUI</span>
            <span className="fw-status"><i /> Fabric 1.21.11</span>
          </div>
          <div className="fw-gui">
            <aside className="fw-side">
              <div className="fw-search-wrap">
                <input
                  className="fw-search"
                  placeholder="Search settings..."
                  value={query}
                  spellCheck={false}
                  aria-label="Search Floyd settings"
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <div className="fw-cats" role="tablist" aria-label="Floyd module categories">
                {CATEGORIES.map((cat) => {
                  const Icon = CAT_ICONS[cat.id];
                  const active = !query && activeCat === cat.id;
                  return (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={active}
                      className={`fw-cat${active ? ' active' : ''}`}
                      key={cat.id}
                      onClick={() => {
                        setActiveCat(cat.id);
                        setQuery('');
                      }}
                    >
                      <Icon />
                      <span>{cat.label}</span>
                    </button>
                  );
                })}
              </div>
              <div className="fw-side-foot">
                <button type="button" className="fw-foot-btn active">Move HUDs</button>
                <button type="button" className="fw-foot-btn">Save Config</button>
                <button type="button" className="fw-close" onClick={() => setOpen(false)}>Close</button>
              </div>
            </aside>
            <main className="fw-content">
              {list.length === 0 ? <div className="fw-empty">No settings found.</div> : list.map(renderRow)}
            </main>
          </div>
        </div>
      </div>
      {!open && (
        <button type="button" className="fw-btn fw-btn-ghost fw-reopen" onClick={() => setOpen(true)}>
          Reopen ClickGUI
        </button>
      )}
      <div className="fw-agent-card">
        <div className="fw-agent-top">
          <span>agent harness</span>
          <b>3/3 long-chain proof</b>
        </div>
        <ol>
          {AGENT_STEPS.map((step) => <li key={step}>{step}</li>)}
        </ol>
      </div>
    </div>
  );
}

export default function FloydDemo() {
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > 18);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const goTo = (id: string) => (e: { preventDefault: () => void }) => {
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="fw-root" id="top">
      <div className="fw-bg" aria-hidden />
      <nav className={`fw-nav${stuck ? ' is-stuck' : ''}`}>
        <div className="fw-wrap fw-nav-inner">
          <a className="fw-brand" href="#top" onClick={goTo('top')}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/floyd/icon-128.png" alt="FloydAddons icon" />
            <span><b>Floyd</b>Addons</span>
          </a>
          <div className="fw-nav-links">
            <a href="#modules" onClick={goTo('modules')}>Modules</a>
            <a href="#agent" onClick={goTo('agent')}>Agent</a>
            <a className="fw-btn fw-btn-primary" href="#get" onClick={goTo('get')}>Get Floyd</a>
          </div>
        </div>
      </nav>

      <header className="fw-hero">
        <div className="fw-hero-grid">
          <div className="fw-hero-left">
            <p className="fw-eyebrow">Fabric client plus agent harness</p>
            <h1 className="fw-title">
              <span>Floyd</span>
              <span>Addons</span>
            </h1>
            <p className="fw-sub">
              A modern Minecraft Fabric client rebuilt on Odin&apos;s module system, with Floyd settings, HUD surfaces, local control, and a real-client agent path for verified actions.
            </p>
            <div className="fw-hero-btns">
              <a className="fw-btn fw-btn-primary fw-btn-lg" href="#modules" onClick={goTo('modules')}>
                Explore modules <ArrowRight />
              </a>
              <a className="fw-btn fw-btn-ghost fw-btn-lg" href="#agent" onClick={goTo('agent')}>
                Agent harness
              </a>
            </div>
            <div className="fw-trust">
              <span><b>Fabric</b> 1.21.11</span>
              <i />
              <span><b>Odin</b> ClickGUI</span>
              <i />
              <span>Local bridge <b>38765</b></span>
            </div>
          </div>
          <FloydPanel />
        </div>
      </header>

      <section className="fw-section" id="modules">
        <div className="fw-wrap">
          <div className="fw-section-head">
            <p className="fw-eyebrow">active surfaces</p>
            <h2>Compact module registry, grounded in the runtime.</h2>
          </div>
          <div className="fw-modules">
            {MODULES.map((module, i) => (
              <article className="fw-module" key={module.name}>
                <span className="fw-module-idx">{String(i + 1).padStart(2, '0')}</span>
                <div className="fw-module-body">
                  <div className="fw-module-top">
                    <h3>{module.name}</h3>
                    <span>{module.cat}</span>
                  </div>
                  <p>{module.desc}</p>
                  <div className="fw-tags">
                    {module.tags.map((tag) => <b key={tag}>{tag}</b>)}
                  </div>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="fw-section fw-agent-section" id="agent">
        <div className="fw-wrap fw-agent-grid">
          <div>
            <p className="fw-eyebrow">new Floyd agent feature</p>
            <h2>Natural-language control through the real client.</h2>
            <p>
              The harness keeps Mindcraft as a reference, but Floyd stays Fabric-native so it can observe client-only state: scoreboard, tablist, item lore, custom inventory screens, screenshots, entities, and SkyBlock GUI details.
            </p>
          </div>
          <div className="fw-agent-spec">
            <div><b>Tool contract</b><span>observe_state, craft_item, smelt_item, read_screen, click_slot_matching</span></div>
            <div><b>Movement</b><span>Native Baritone powers goto, mine, stop, and status while Floyd verifies inventory deltas.</span></div>
            <div><b>SkyBlock path</b><span>Public Bazaar scans are advisory until live GUI confirmation and explicit approval.</span></div>
          </div>
        </div>
      </section>

      <section className="fw-section" id="get">
        <div className="fw-wrap">
          <div className="fw-cta">
            <div>
              <p className="fw-eyebrow">get Floyd</p>
              <h2>Build the client, install the jar, then verify from the bridge.</h2>
              <p>Deployment remains a repo workflow: install the Fabric runtime deps, copy the FloydAddons jar into a Minecraft mods folder, and keep live Hypixel proof separate from offline build readiness.</p>
            </div>
            <div className="fw-command">
              <span>source commands</span>
              <code>./scripts/verify-floyd-in-odin.sh</code>
              <code>./scripts/install-built-jar.sh /path/to/.minecraft/mods</code>
              <code>python3 scripts/live-install-status.py --json</code>
            </div>
          </div>
        </div>
      </section>

      <footer className="fw-footer">
        <div className="fw-wrap fw-footer-inner">
          <span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/floyd/icon-128.png" alt="" aria-hidden /> FloydAddons
          </span>
          <span>Standalone UI study for <Link href="/">tim.waldin.net</Link></span>
        </div>
      </footer>
    </div>
  );
}
