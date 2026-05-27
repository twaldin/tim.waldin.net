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
  CATEGORIES,
  ENTRIES,
  MODULES,
  formatValue,
  roundForFmt,
  stepForFmt,
  type CategoryId,
  type Entry,
  type SliderFmt,
} from './jasper-data';

const DISCORD = 'https://discord.gg/jasperclient';
const SITE = 'https://jasperclient.com';

/* ── Inline icon set (no icon-font / lib dependency) ────────────────── */
type IconProps = { size?: number };
const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function PickaxeIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden>
      <path d="M14 10 4 20M3.5 13.5C7 10 10 9 14.5 9.5M10.5 3.5C14 7 15 10 14.5 14.5M9 9l6 6" />
    </svg>
  );
}
function SwordIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden>
      <path d="M14.5 17.5 3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2M14.5 6.5 18 3h3v3l-3.5 3.5" />
    </svg>
  );
}
function SlidersIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden>
      <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" />
      <circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" />
    </svg>
  );
}
function RouteIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden>
      <circle cx="6" cy="19" r="2.4" /><circle cx="18" cy="5" r="2.4" />
      <path d="M8.5 19H14a3.5 3.5 0 0 0 0-7H9.5a3.5 3.5 0 0 1 0-7H15.5" />
    </svg>
  );
}
function SparkIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden>
      <path d="M12 3v6M12 15v6M3 12h6M15 12h6M5.6 5.6l3 3M15.4 15.4l3 3M18.4 5.6l-3 3M8.6 15.4l-3 3" />
    </svg>
  );
}
const CAT_ICONS: Record<CategoryId, (p: IconProps) => ReactNode> = {
  mining: PickaxeIcon,
  combat: SwordIcon,
  misc: SlidersIcon,
  routes: RouteIcon,
  galatea: SparkIcon,
};

function ArrowRight({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} aria-hidden>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

/* ── Keyed entry helpers ────────────────────────────────────────────── */
type KeyedEntry = { entry: Entry; key: string };

function initToggles(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  (Object.keys(ENTRIES) as CategoryId[]).forEach((cat) =>
    ENTRIES[cat].forEach((e, i) => {
      if (e.kind === 'toggle') out[`${cat}:${i}`] = e.value;
    }),
  );
  return out;
}
function initSliders(): Record<string, number> {
  const out: Record<string, number> = {};
  (Object.keys(ENTRIES) as CategoryId[]).forEach((cat) =>
    ENTRIES[cat].forEach((e, i) => {
      if (e.kind === 'slider') out[`${cat}:${i}`] = e.value;
    }),
  );
  return out;
}

/* ── Slider row ─────────────────────────────────────────────────────── */
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
    else if (e.key === 'PageUp') next = value + step * 10;
    else if (e.key === 'PageDown') next = value - step * 10;
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    else return;
    e.preventDefault();
    onChange(roundForFmt(Math.max(min, Math.min(max, next)), fmt));
  };

  return (
    <div className="jc-row static">
      <span className="jc-row-name">{name}</span>
      <div className="jc-slider-right">
        <span className="jc-slider-val">{formatValue(value, fmt)}</span>
        <div
          ref={trackRef}
          className="jc-track"
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

/* ── GUI panel (the interactive client window) ──────────────────────── */
function GuiPanel() {
  const [activeCat, setActiveCat] = useState<CategoryId>('mining');
  const [query, setQuery] = useState('');
  const [toggles, setToggles] = useState<Record<string, boolean>>(initToggles);
  const [sliders, setSliders] = useState<Record<string, number>>(initSliders);
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [moveHuds, setMoveHuds] = useState(false);
  const [routeExch, setRouteExch] = useState(false);
  const [offset, setOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [open, setOpen] = useState(true);

  const windowRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const drag = useRef<{ active: boolean; sx: number; sy: number; ox: number; oy: number }>({
    active: false, sx: 0, sy: 0, ox: 0, oy: 0,
  });

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
      keyed[cat].forEach((ke) => {
        if (ke.entry.kind !== 'header' && ke.entry.name.toLowerCase().includes(q)) hits.push(ke);
      }),
    );
    return hits;
  }, [query, keyed]);

  const onHandleDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { active: true, sx: e.clientX, sy: e.clientY, ox: offset.x, oy: offset.y };
  };
  const onHandleMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current.active) return;
    const el = windowRef.current;
    const w = el?.offsetWidth ?? 700;
    const maxX = Math.max(40, (window.innerWidth - w) / 2);
    const maxY = 200;
    const nx = Math.max(-maxX, Math.min(maxX, drag.current.ox + e.clientX - drag.current.sx));
    const ny = Math.max(-maxY, Math.min(maxY, drag.current.oy + e.clientY - drag.current.sy));
    setOffset({ x: nx, y: ny });
  };
  const onHandleUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    drag.current.active = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const renderRow = ({ entry, key }: KeyedEntry): ReactNode => {
    if (entry.kind === 'header') {
      const isRunning = running[key] ?? false;
      return (
        <div className="jc-row-head" key={key}>
          <h5>{entry.name}</h5>
          {entry.action && (
            <button
              type="button"
              className={`jc-play${isRunning ? ' on' : ''}`}
              aria-pressed={isRunning}
              aria-label={`${isRunning ? 'Stop' : 'Start'} ${entry.name}`}
              onClick={() => setRunning((s) => ({ ...s, [key]: !isRunning }))}
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
          className="jc-row"
          role="switch"
          aria-checked={on}
          aria-label={entry.name}
          key={key}
          onClick={() => setToggles((s) => ({ ...s, [key]: !on }))}
        >
          <span className="jc-row-name">{entry.name}</span>
          <span className={`jc-tog${on ? ' on' : ''}`}>
            <i />
          </span>
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
          onChange={(v) => setSliders((s) => ({ ...s, [key]: v }))}
        />
      );
    }
    return (
      <div className="jc-row static" key={key}>
        <span className="jc-row-name">{entry.name}</span>
        <button type="button" className="jc-keycap">None</button>
      </div>
    );
  };

  const list = searchResults ?? keyed[activeCat];

  return (
    <div className="jc-stage">
      <div className="jc-tilt">
        <div
          className="jc-window"
          ref={windowRef}
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px)`,
            opacity: open ? 1 : 0,
            transition: 'opacity 0.3s ease, transform 0.18s ease',
            pointerEvents: open ? 'auto' : 'none',
          }}
          aria-hidden={!open}
        >
          <div
            className="jc-titlebar jc-gui-handle"
            onPointerDown={onHandleDown}
            onPointerMove={onHandleMove}
            onPointerUp={onHandleUp}
            style={{ height: 36 }}
          >
            <span className="jc-traffic" aria-hidden>
              <i /><i /><i />
            </span>
            <span className="jc-titlebar-name">
              <b>Jasper</b> Client · v1.4.2
            </span>
            <span className="jc-titlebar-status">
              <span className="jc-live" /> Hypixel SkyBlock
            </span>
          </div>

          <div className="jc-gui">
            <div className="jc-gui-side">
              <div className="jc-gui-search-wrap">
                <input
                  ref={searchRef}
                  className="jc-gui-search"
                  placeholder="Search…"
                  value={query}
                  spellCheck={false}
                  aria-label="Search client modules"
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <div className="jc-gui-cats" role="tablist" aria-label="Module categories">
                {CATEGORIES.map((c) => {
                  const Icon = CAT_ICONS[c.id];
                  const active = !query && c.id === activeCat;
                  return (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={active}
                      key={c.id}
                      className={`jc-cat${active ? ' active' : ''}`}
                      onClick={() => {
                        setActiveCat(c.id);
                        setQuery('');
                      }}
                    >
                      <Icon />
                      <span>{c.label}</span>
                    </button>
                  );
                })}
              </div>
              <div className="jc-gui-side-foot">
                <div className="jc-foot-row">
                  <button type="button" className="jc-foot-btn" onClick={() => searchRef.current?.focus()}>
                    Search
                  </button>
                  <button
                    type="button"
                    className={`jc-foot-btn${moveHuds ? ' active' : ''}`}
                    aria-pressed={moveHuds}
                    onClick={() => setMoveHuds((v) => !v)}
                  >
                    Move HUDs
                  </button>
                  <button
                    type="button"
                    className={`jc-foot-btn wide${routeExch ? ' active' : ''}`}
                    aria-pressed={routeExch}
                    onClick={() => setRouteExch((v) => !v)}
                  >
                    Route Exchanger
                  </button>
                </div>
                <button type="button" className="jc-foot-close" onClick={() => setOpen(false)}>
                  Close
                </button>
              </div>
            </div>

            <div className="jc-gui-content">
              {list.length === 0 ? (
                <div className="jc-empty">No results found.</div>
              ) : (
                list.map(renderRow)
              )}
            </div>
          </div>
        </div>
      </div>

      {!open && (
        <button
          type="button"
          className="jc-btn jc-btn-ghost"
          style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}
          onClick={() => {
            setOffset({ x: 0, y: 0 });
            setOpen(true);
          }}
        >
          Relaunch client
        </button>
      )}
    </div>
  );
}

/* ── Ambient starfield ──────────────────────────────────────────────── */
function StarField() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let w = 0;
    let h = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    type Star = { x: number; y: number; z: number; r: number; tw: number };
    let stars: Star[] = [];

    const resize = () => {
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.min(110, Math.floor((w * h) / 16000));
      stars = Array.from({ length: count }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        z: 0.3 + Math.random() * 0.7,
        r: 0.4 + Math.random() * 1.2,
        tw: Math.random() * Math.PI * 2,
      }));
    };

    const tick = () => {
      ctx.clearRect(0, 0, w, h);
      for (const s of stars) {
        s.y += s.z * 0.06;
        s.tw += 0.02;
        if (s.y > h + 2) s.y = -2;
        const a = 0.25 + Math.abs(Math.sin(s.tw)) * 0.5 * s.z;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(204, 170, 255, ${a.toFixed(3)})`;
        ctx.fill();
      }
      raf = requestAnimationFrame(tick);
    };

    resize();
    tick();
    window.addEventListener('resize', resize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, []);
  return <canvas className="jc-stars" ref={ref} aria-hidden />;
}

/* ── Page ───────────────────────────────────────────────────────────── */
export default function JasperDemo() {
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > 20);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const goTo = (id: string) => (e: { preventDefault: () => void }) => {
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="jc-root" id="top">
      <div className="jc-bg" aria-hidden />
      <StarField />

      {/* NAV */}
      <nav className={`jc-nav${stuck ? ' is-stuck' : ''}`}>
        <div className="jc-wrap jc-nav-inner">
          <a className="jc-brand" href="#top" onClick={goTo('top')}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/jasper/logo.png" alt="Jasper Client logo" />
            <span className="jc-brand-text"><b>Jasper</b> Client</span>
          </a>
          <div className="jc-nav-links">
            <a className="jc-nav-link" href="#modules" onClick={goTo('modules')}>Modules</a>
            <a className="jc-nav-link" href={DISCORD} target="_blank" rel="noreferrer noopener">Discord</a>
            <a className="jc-btn jc-btn-primary" href={SITE} target="_blank" rel="noreferrer noopener">Get Jasper</a>
          </div>
        </div>
      </nav>

      {/* HERO — copy left, live client GUI right */}
      <header className="jc-hero">
        <div className="jc-hero-grid">
          <div className="jc-hero-left">
            <h1 className="jc-title">
              <span className="l1">Jasper</span>
              <span className="l2">Client</span>
            </h1>
            <p className="jc-hero-sub">
              The ultimate Hypixel SkyBlock mod. Automation, precision and control — in one client.
            </p>
            <div className="jc-hero-btns">
              <a className="jc-btn jc-btn-primary jc-btn-lg" href={SITE} target="_blank" rel="noreferrer noopener">
                Get Jasper Client <ArrowRight />
              </a>
              <a className="jc-btn jc-btn-ghost jc-btn-lg" href={DISCORD} target="_blank" rel="noreferrer noopener">
                Join Discord
              </a>
            </div>
            <div className="jc-trust">
              <span><b>v1.4.2</b></span>
              <span className="jc-sep" />
              <span>Forge <b>1.8.9</b></span>
              <span className="jc-sep" />
              <span>Hypixel SkyBlock</span>
            </div>
          </div>

          <GuiPanel />
        </div>
      </header>

      {/* MODULES — compact editorial manifest */}
      <section className="jc-section" id="modules" style={{ scrollMarginTop: 80 }}>
        <div className="jc-wrap">
          <div className="jc-section-head">
            <span className="jc-eyebrow">Modules</span>
            <h2 className="jc-h2">Built for <span className="jc-accent">the grind.</span></h2>
          </div>
          <div className="jc-modules">
            {MODULES.map((m, i) => (
              <article className="jc-module" key={m.name}>
                <div className="jc-module-idx">{String(i + 1).padStart(2, '0')}</div>
                <div className="jc-module-body">
                  <div className="jc-module-top">
                    <h3 className="jc-module-name">{m.name}</h3>
                    <span className="jc-module-cat">{m.cat}</span>
                  </div>
                  <p className="jc-module-desc">{m.desc}</p>
                  <div className="jc-module-chips">
                    {m.tags.map((t) => (
                      <span className="jc-tag" key={t}>{t}</span>
                    ))}
                  </div>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* COMMUNITY + GET — compact band */}
      <section className="jc-section" id="get" style={{ paddingTop: 0 }}>
        <div className="jc-wrap">
          <div className="jc-cta">
            <div className="jc-cta-text">
              <h2>Ready to play?</h2>
              <p>Get the client and join the community.</p>
            </div>
            <div className="jc-cta-btns">
              <a className="jc-btn jc-btn-primary jc-btn-lg" href={SITE} target="_blank" rel="noreferrer noopener">
                Get Jasper Client <ArrowRight />
              </a>
              <a className="jc-btn jc-btn-ghost jc-btn-lg" href={DISCORD} target="_blank" rel="noreferrer noopener">
                Join Discord
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="jc-footer">
        <div className="jc-wrap jc-footer-inner">
          <span className="jc-footer-brand">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/jasper/logo.png" alt="" aria-hidden />
            Jasper Client
          </span>
          <span className="jc-footer-note">
            Independent UI study · not affiliated with Mojang or Hypixel · <Link href="/">tim.waldin.net</Link>
          </span>
        </div>
      </footer>
    </div>
  );
}
