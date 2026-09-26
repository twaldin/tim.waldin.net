// Room sound, synthesised with Web Audio (no sample files): a thocky
// mechanical keyboard with per-key variation, rain on the window and a low
// room tone, all through a short room reverb. Starts muted; the context is
// only created after a user gesture.

export interface RoomAudio {
  readonly enabled: boolean;
  setEnabled(enabled: boolean): void;
  keyDown(code: string, width: number): void;
  keyUp(code: string, width: number): void;
  // 0 = night (rain on the window), 1 = day (dry, a little more city).
  setDay(day: number): void;
  dispose(): void;
}

function noiseBuffer(context: AudioContext, seconds: number, pink: boolean) {
  const length = Math.floor(context.sampleRate * seconds);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  // Paul Kellet's economy pink filter.
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1;
    if (!pink) {
      data[i] = white;
      continue;
    }
    b0 = 0.99765 * b0 + white * 0.099046;
    b1 = 0.963 * b1 + white * 0.2965164;
    b2 = 0.57 * b2 + white * 1.0526913;
    data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.2;
  }
  return buffer;
}

function impulseResponse(context: AudioContext, seconds: number, decay: number) {
  const length = Math.floor(context.sampleRate * seconds);
  const buffer = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return buffer;
}

interface Graph {
  context: AudioContext;
  master: GainNode;
  keys: GainNode;
  rain: GainNode;
  hum: GainNode;
  white: AudioBuffer;
  stopAmbience: () => void;
}

function buildGraph(): Graph {
  const context = new AudioContext();
  const master = context.createGain();
  master.gain.value = 0;
  master.connect(context.destination);

  const reverb = context.createConvolver();
  reverb.buffer = impulseResponse(context, 0.9, 3.2);
  const wet = context.createGain();
  wet.gain.value = 0.16;
  reverb.connect(wet).connect(master);

  const keys = context.createGain();
  keys.gain.value = 0.55;
  keys.connect(master);
  keys.connect(reverb);

  const white = noiseBuffer(context, 1, false);
  const pinkLoop = noiseBuffer(context, 6, true);

  // Rain on glass: pink-noise hiss band-limited like water on a window,
  // slowly swelling, plus sparse droplet ticks.
  const rain = context.createBufferSource();
  rain.buffer = pinkLoop;
  rain.loop = true;
  const rainFilter = context.createBiquadFilter();
  rainFilter.type = 'bandpass';
  rainFilter.frequency.value = 1400;
  rainFilter.Q.value = 0.35;
  const rainGain = context.createGain();
  rainGain.gain.value = 0.2;
  const swell = context.createOscillator();
  swell.frequency.value = 0.07;
  const swellDepth = context.createGain();
  swellDepth.gain.value = 0.05;
  swell.connect(swellDepth).connect(rainGain.gain);
  rain.connect(rainFilter).connect(rainGain).connect(master);
  rainGain.connect(reverb);

  // Room tone: very low rumble (distant traffic, the PC's fans).
  const hum = context.createBufferSource();
  hum.buffer = pinkLoop;
  hum.loop = true;
  hum.playbackRate.value = 0.5;
  const humFilter = context.createBiquadFilter();
  humFilter.type = 'lowpass';
  humFilter.frequency.value = 180;
  const humGain = context.createGain();
  humGain.gain.value = 0.22;
  hum.connect(humFilter).connect(humGain).connect(master);

  rain.start();
  hum.start();
  swell.start();

  let dropTimer: ReturnType<typeof setTimeout>;
  const drop = () => {
    // A suspended context (no user gesture yet) freezes currentTime: drops
    // scheduled meanwhile would all fire at once when it resumes.
    if (context.state !== 'running' || rainGain.gain.value < 0.02) {
      dropTimer = setTimeout(drop, 400);
      return;
    }
    const source = context.createBufferSource();
    source.buffer = white;
    const filter = context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 2500 + Math.random() * 3500;
    filter.Q.value = 6;
    const gain = context.createGain();
    const t = context.currentTime;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.05 + Math.random() * 0.07, t + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    source.connect(filter).connect(gain).connect(master);
    source.start(t, Math.random() * 0.9, 0.05);
    dropTimer = setTimeout(drop, 40 + Math.random() * 260);
  };
  drop();

  return {
    context,
    master,
    keys,
    rain: rainGain,
    hum: humGain,
    white,
    stopAmbience: () => {
      clearTimeout(dropTimer);
      rain.stop();
      hum.stop();
      swell.stop();
    },
  };
}

// One keystroke: plastic clack + switch click, the case "thock", and on
// long keys a stabiliser rattle. `release` is the quieter upstroke.
function strike(graph: Graph, width: number, release: boolean) {
  const { context, keys, white } = graph;
  const t = context.currentTime + 0.001;
  const size = Math.min(1, (width - 1) / 5.25); // 0 for 1u, 1 for the space bar
  const vary = () => 0.9 + Math.random() * 0.2;
  const level = (release ? 0.35 : 1) * vary();

  const click = context.createBufferSource();
  click.buffer = white;
  const clickFilter = context.createBiquadFilter();
  clickFilter.type = 'bandpass';
  clickFilter.frequency.value = (release ? 4200 : 3000) * vary() * (1 - size * 0.35);
  clickFilter.Q.value = 1.4;
  const clickGain = context.createGain();
  clickGain.gain.setValueAtTime(0.0001, t);
  clickGain.gain.exponentialRampToValueAtTime(0.5 * level, t + 0.0012);
  clickGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.018);
  click.connect(clickFilter).connect(clickGain).connect(keys);
  click.start(t, Math.random() * 0.8, 0.04);

  if (!release) {
    const body = context.createOscillator();
    body.type = 'sine';
    const pitch = (260 - size * 110) * vary();
    body.frequency.setValueAtTime(pitch * 1.6, t);
    body.frequency.exponentialRampToValueAtTime(pitch, t + 0.012);
    const bodyGain = context.createGain();
    bodyGain.gain.setValueAtTime(0.0001, t);
    bodyGain.gain.exponentialRampToValueAtTime(0.42 * level, t + 0.003);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.07 + size * 0.05);
    body.connect(bodyGain).connect(keys);
    body.start(t);
    body.stop(t + 0.16);

    const thud = context.createBufferSource();
    thud.buffer = white;
    const thudFilter = context.createBiquadFilter();
    thudFilter.type = 'lowpass';
    thudFilter.frequency.value = (900 - size * 350) * vary();
    thudFilter.Q.value = 3;
    const thudGain = context.createGain();
    thudGain.gain.setValueAtTime(0.0001, t);
    thudGain.gain.exponentialRampToValueAtTime(0.6 * level, t + 0.002);
    thudGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
    thud.connect(thudFilter).connect(thudGain).connect(keys);
    thud.start(t, Math.random() * 0.8, 0.06);
  }

  if (size > 0) {
    const rattle = context.createBufferSource();
    rattle.buffer = white;
    const rattleFilter = context.createBiquadFilter();
    rattleFilter.type = 'bandpass';
    rattleFilter.frequency.value = 1800 * vary();
    rattleFilter.Q.value = 2.5;
    const rattleGain = context.createGain();
    const r = t + 0.006;
    rattleGain.gain.setValueAtTime(0.0001, r);
    rattleGain.gain.exponentialRampToValueAtTime(0.18 * level * size, r + 0.002);
    rattleGain.gain.exponentialRampToValueAtTime(0.0001, r + 0.03);
    rattle.connect(rattleFilter).connect(rattleGain).connect(keys);
    rattle.start(r, Math.random() * 0.8, 0.04);
  }
}

export function createRoomAudio(initiallyEnabled: boolean): RoomAudio {
  let graph: Graph | null = null;
  let enabled = initiallyEnabled;
  let dayLevel = 0;
  const applyDay = () => {
    if (!graph) return;
    const t = graph.context.currentTime;
    graph.rain.gain.setTargetAtTime(0.2 * (1 - dayLevel), t, 0.6);
    graph.hum.gain.setTargetAtTime(0.22 + 0.12 * dayLevel, t, 0.6);
  };

  const ensure = () => {
    if (!graph) {
      graph = buildGraph();
      applyDay();
    }
    if (graph.context.state === 'suspended') void graph.context.resume();
    return graph;
  };
  const applyLevel = () => {
    if (!graph) return;
    graph.master.gain.setTargetAtTime(enabled ? 0.9 : 0, graph.context.currentTime, 0.25);
  };

  return {
    get enabled() {
      return enabled;
    },
    setEnabled(next) {
      enabled = next;
      if (enabled) ensure();
      applyLevel();
    },
    setDay(day) {
      dayLevel = day;
      applyDay();
    },
    keyDown(_code, width) {
      if (!enabled) return;
      const g = ensure();
      applyLevel();
      strike(g, width, false);
    },
    keyUp(_code, width) {
      if (!enabled || !graph) return;
      strike(graph, width, true);
    },
    dispose() {
      if (!graph) return;
      graph.stopAmbience();
      void graph.context.close();
      graph = null;
    },
  };
}
