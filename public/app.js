/* SkyWindow front end. Plain JS, no build step. */
(() => {
  'use strict';

  const app = document.getElementById('app');
  // Replace the page body, skipping null/false placeholders from conditional sections.
  const setView = (...kids) => app.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  let cleanup = []; // teardown callbacks for the current view (timers, players, maps)

  // ---------- helpers ----------

  // h('div.cls#id', {attrs}, ...children). Text children are inserted as text, never HTML.
  function h(tag, attrs, ...kids) {
    const [, name, rest] = /^([a-z0-9]+)(.*)$/i.exec(tag);
    const el = document.createElement(name);
    for (const m of rest.matchAll(/([.#])([\w-]+)/g)) {
      if (m[1] === '.') el.classList.add(m[2]);
      else el.id = m[2];
    }
    if (attrs != null && attrs !== false && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
      kids.unshift(attrs);
      attrs = null;
    }
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k in el && k !== 'list' && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    });
    if (res.status === 204) return null;
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.error || (body.errors || []).join('; ') || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  const favs = {
    list() { return store.get('favorites', []); },
    has(id) { return this.list().includes(id); },
    toggle(id) {
      const l = this.list();
      const i = l.indexOf(id);
      if (i >= 0) l.splice(i, 1); else l.push(id);
      store.set('favorites', l);
      return i < 0;
    },
  };

  const regionNames = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; } })();
  const countryName = (cc) => (cc && regionNames ? regionNames.of(cc) : cc) || 'Worldwide';
  const flag = (cc) => (cc && /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 127397 + c.charCodeAt(0))) : '🌐');
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  function ago(ts) {
    if (!ts) return '';
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  function toast(msg) {
    const t = h('div.toast', msg);
    document.body.append(t);
    setTimeout(() => t.remove(), 2600);
  }

  function place(c) {
    return [c.city, c.region, c.country ? countryName(c.country) : ''].filter(Boolean).join(', ');
  }

  // YouTube: accept a video ID, channel ID, or any common URL form.
  function youtubeEmbed(input) {
    const s = String(input).trim();
    let m;
    if ((m = /^(UC[\w-]{22})$/.exec(s)) || (m = /youtube\.com\/channel\/(UC[\w-]{22})/.exec(s))) {
      return { embed: `https://www.youtube.com/embed/live_stream?channel=${m[1]}&autoplay=1&mute=1`, id: null };
    }
    if ((m = /^([\w-]{11})$/.exec(s)) || (m = /(?:v=|youtu\.be\/|\/live\/|\/embed\/|\/shorts\/)([\w-]{11})/.exec(s))) {
      return { embed: `https://www.youtube.com/embed/${m[1]}?autoplay=1&mute=1&playsinline=1`, id: m[1] };
    }
    return { embed: null, id: null };
  }

  function thumbFor(c) {
    if (c.thumbnail) return c.thumbnail;
    if (c.kind === 'youtube') {
      const { id } = youtubeEmbed(c.url);
      if (id) return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    }
    if (c.kind === 'mjpeg') return null; // do not open endless streams just for thumbnails
    return null;
  }

  // ---------- components ----------

  function favButton(c, onChange) {
    const b = h('button.fav', {
      type: 'button',
      title: 'Favorite',
      'aria-label': 'Toggle favorite',
      'aria-pressed': String(favs.has(c.id)),
      onclick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        const on = favs.toggle(c.id);
        b.setAttribute('aria-pressed', String(on));
        b.textContent = on ? '★' : '☆';
        if (onChange) onChange(on);
      },
    }, favs.has(c.id) ? '★' : '☆');
    return b;
  }

  function thumbBlock(c, { fav = true } = {}) {
    const src = thumbFor(c);
    const t = h('div.thumb',
      src
        ? h('img', { src, alt: '', loading: 'lazy', onerror: (e) => e.target.replaceWith(h('div.placeholder', c.live ? 'Live stream' : 'No image yet')) })
        : h('div.placeholder', c.live ? '▶ Live stream' : 'Waiting for first image'),
      h(`span.badge.${c.live ? 'live' : 'still'}`, c.live ? 'LIVE' : 'STILL'),
      !c.live && c.lastOk ? h('span.age', ago(c.lastOk)) : null,
      impactChip(c),
      fav ? favButton(c) : null,
    );
    return t;
  }

  function card(c) {
    return h('a.card', { href: `/cam/${c.slug}`, 'data-link': true },
      thumbBlock(c),
      h('div.card-body',
        h('div.card-title', c.name),
        h('div.card-sub',
          h(`span.dot.${c.status}`, { title: `Status: ${c.status}` }),
          h('span', flag(c.country)),
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, place(c) || cap(c.category)),
        ),
      ),
    );
  }

  function grid(cams, emptyMsg = 'No cameras match.') {
    if (!cams.length) return h('div.empty', emptyMsg);
    return h('div.grid', cams.map(card));
  }

  function section(title, body, more) {
    return h('section.section',
      h('div.section-head', h('h2', title), more ? h('a', { href: more, 'data-link': true }, 'See all →') : null),
      body,
    );
  }

  // Player for any camera kind. Returns { el, destroy }.
  function player(c, { timelapse = false } = {}) {
    const box = h('div.player');
    const destroyers = [];

    if (c.kind === 'hls') {
      const v = h('video', { controls: true, muted: true, autoplay: true, playsInline: true, poster: c.poster || null });
      v.muted = true;
      box.append(v);
      if (v.canPlayType('application/vnd.apple.mpegurl')) {
        v.src = c.url;
      } else if (window.Hls && window.Hls.isSupported()) {
        const hls = new window.Hls({ liveDurationInfinity: true, lowLatencyMode: true });
        hls.loadSource(c.url);
        hls.attachMedia(v);
        hls.on(window.Hls.Events.ERROR, (_e, data) => {
          if (data.fatal) {
            hls.destroy();
            box.replaceChildren(h('div.msg', 'Stream unavailable right now. It may be offline or blocked by the source.'));
          }
        });
        destroyers.push(() => hls.destroy());
      } else {
        box.replaceChildren(h('div.msg', 'This browser cannot play HLS streams.'));
      }
      v.play().catch(() => {});
    } else if (c.kind === 'youtube') {
      const { embed } = youtubeEmbed(c.url);
      box.append(embed
        ? h('iframe', { src: embed, allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen', allowFullscreen: true, title: c.name, referrerpolicy: 'strict-origin-when-cross-origin' })
        : h('div.msg', 'Invalid YouTube reference.'));
    } else if (c.kind === 'iframe') {
      box.append(h('iframe', { src: c.url, allow: 'autoplay; fullscreen', allowFullscreen: true, title: c.name, sandbox: 'allow-scripts allow-same-origin allow-presentation', referrerpolicy: 'no-referrer' }));
    } else if (c.kind === 'mjpeg') {
      const img = h('img', { src: c.url, alt: c.name });
      box.append(img);
      destroyers.push(() => { img.src = ''; });
    } else {
      // Still camera: show cached latest frame, refresh on the camera's interval.
      const img = h('img', { alt: c.name });
      const stamp = h('span.overlay-time');
      let showingLatest = true;
      const load = (url, ts) => {
        const next = new Image();
        next.onload = () => { img.src = next.src; stamp.textContent = ts ? new Date(ts).toLocaleString() : ''; };
        next.onerror = () => { if (!img.src) box.replaceChildren(h('div.msg', 'No image yet. The server will fetch one shortly.')); };
        next.src = url;
      };
      const refreshLatest = async () => {
        if (!showingLatest) return;
        try {
          const { camera } = await api(`/api/cameras/${c.id}`);
          if (camera.lastOk) load(`/api/cameras/${c.id}/latest?t=${camera.lastOk}`, camera.lastOk);
          else if (!img.src) box.replaceChildren(h('div.msg', c.kind === 'push' ? 'Waiting for this camera to upload its first image.' : 'No image yet. The server will fetch one shortly.'), stamp);
        } catch { /* keep last frame */ }
      };
      box.append(img, stamp);
      refreshLatest();
      const t = setInterval(refreshLatest, Math.max(30, Math.min(c.refreshSeconds || 300, 600)) * 1000);
      destroyers.push(() => clearInterval(t));

      if (timelapse) {
        const tl = timelapseBar(c, (frame) => {
          if (!frame) { showingLatest = true; refreshLatest(); return; }
          showingLatest = false;
          load(frame.url, frame.ts);
        });
        destroyers.push(tl.destroy);
        return { el: h('div', box, tl.el), destroy: () => destroyers.forEach((f) => f()) };
      }
    }
    return { el: box, destroy: () => destroyers.forEach((f) => f()) };
  }

  // Scrubber and playback over archived frames. onFrame(null) means "back to live".
  function timelapseBar(c, onFrame) {
    let frames = [];
    let playing = null;
    const range = h('input', { type: 'range', min: '0', max: '0', value: '0', 'aria-label': 'Archive position' });
    const label = h('span.tl-time', 'Latest');
    const playBtn = h('button.btn.small', { type: 'button' }, '▶ Timelapse');
    const liveBtn = h('button.btn.small', { type: 'button' }, 'Latest');
    const speed = h('select', { 'aria-label': 'Playback speed', style: { width: 'auto' } },
      [['4', '4 fps'], ['8', '8 fps'], ['15', '15 fps']].map(([v, t]) => h('option', { value: v, selected: v === '8' }, t)));
    const el = h('div.timelapse', playBtn, range, label, speed, liveBtn);

    const preload = new Map();
    const show = (i) => {
      const f = frames[i];
      if (!f) return;
      range.value = String(i);
      label.textContent = new Date(f.ts).toLocaleString();
      onFrame(f);
      // Warm the next few frames so playback does not stutter.
      for (let j = i + 1; j < Math.min(i + 6, frames.length); j++) {
        if (!preload.has(j)) { const im = new Image(); im.src = frames[j].url; preload.set(j, im); }
      }
    };
    const stop = () => { clearInterval(playing); playing = null; playBtn.textContent = '▶ Timelapse'; };
    const load = async () => {
      try {
        ({ frames } = await api(`/api/cameras/${c.id}/frames`));
      } catch { frames = []; }
      range.max = String(Math.max(0, frames.length - 1));
      range.value = range.max;
      range.disabled = frames.length < 2;
      playBtn.disabled = frames.length < 2;
      if (frames.length < 2) label.textContent = `${frames.length} frame${frames.length === 1 ? '' : 's'} archived`;
    };

    range.addEventListener('input', () => { stop(); show(Number(range.value)); });
    playBtn.addEventListener('click', async () => {
      if (playing) return stop();
      await load();
      if (frames.length < 2) return;
      let i = 0;
      playBtn.textContent = '❚❚ Pause';
      playing = setInterval(() => {
        show(i);
        i = i + 1 >= frames.length ? 0 : i + 1;
      }, 1000 / Number(speed.value));
    });
    liveBtn.addEventListener('click', () => { stop(); label.textContent = 'Latest'; load(); onFrame(null); });
    load();
    return { el, destroy: stop };
  }

  // ---------- weather (Open-Meteo, no key) ----------

  const WX = {
    0: ['☀️', 'Clear'], 1: ['🌤️', 'Mostly clear'], 2: ['⛅', 'Partly cloudy'], 3: ['☁️', 'Overcast'],
    45: ['🌫️', 'Fog'], 48: ['🌫️', 'Rime fog'], 51: ['🌦️', 'Light drizzle'], 53: ['🌦️', 'Drizzle'], 55: ['🌧️', 'Heavy drizzle'],
    56: ['🌧️', 'Freezing drizzle'], 57: ['🌧️', 'Freezing drizzle'], 61: ['🌦️', 'Light rain'], 63: ['🌧️', 'Rain'], 65: ['🌧️', 'Heavy rain'],
    66: ['🌧️', 'Freezing rain'], 67: ['🌧️', 'Freezing rain'], 71: ['🌨️', 'Light snow'], 73: ['🌨️', 'Snow'], 75: ['❄️', 'Heavy snow'],
    77: ['🌨️', 'Snow grains'], 80: ['🌦️', 'Showers'], 81: ['🌧️', 'Showers'], 82: ['⛈️', 'Violent showers'],
    85: ['🌨️', 'Snow showers'], 86: ['❄️', 'Snow showers'], 95: ['⛈️', 'Thunderstorm'], 96: ['⛈️', 'Thunderstorm, hail'], 99: ['⛈️', 'Thunderstorm, hail'],
  };
  const imperial = () => store.get('units', (navigator.language || 'en-US') === 'en-US' ? 'imperial' : 'metric') === 'imperial';
  const compass = (deg) => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(deg / 22.5) % 16];

  async function fetchWeather(c) {
    const imp = imperial();
    const q = new URLSearchParams({
      latitude: c.lat, longitude: c.lon, timezone: 'auto',
      current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day,precipitation',
      daily: 'sunrise,sunset,temperature_2m_max,temperature_2m_min',
      forecast_days: '1',
      temperature_unit: imp ? 'fahrenheit' : 'celsius',
      wind_speed_unit: imp ? 'mph' : 'kmh',
      precipitation_unit: imp ? 'inch' : 'mm',
    });
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${q}`);
    if (!res.ok) throw new Error('weather unavailable');
    return res.json();
  }

  function weatherPanel(c, onTimezone) {
    const body = h('div', h('span.muted', 'Loading weather…'));
    const unitBtn = h('button.btn.small', { type: 'button', style: { float: 'right' } }, imperial() ? '°F' : '°C');
    const el = h('div.panel', h('h3', 'Weather now', unitBtn), body);
    const render = async () => {
      unitBtn.textContent = imperial() ? '°F' : '°C';
      try {
        const w = await fetchWeather(c);
        const cur = w.current;
        const u = w.current_units;
        const [icon, text] = WX[cur.weather_code] || ['🌡️', 'Unknown'];
        const time = (iso) => (iso ? iso.slice(11, 16) : '');
        if (onTimezone && w.timezone) onTimezone(w.timezone);
        body.replaceChildren(
          h('div.wx-now', h('span.icon', icon), h('span.temp', `${Math.round(cur.temperature_2m)}${u.temperature_2m}`), h('div', h('div', text), h('div.muted', `Feels ${Math.round(cur.apparent_temperature)}${u.apparent_temperature}`))),
          h('dl.kv',
            h('dt', 'Wind'), h('dd', `${compass(cur.wind_direction_10m)} ${Math.round(cur.wind_speed_10m)} ${u.wind_speed_10m}, gusts ${Math.round(cur.wind_gusts_10m)}`),
            h('dt', 'Humidity'), h('dd', `${cur.relative_humidity_2m}%`),
            h('dt', 'Clouds'), h('dd', `${cur.cloud_cover}%`),
            h('dt', 'Pressure'), h('dd', imperial() ? `${(cur.pressure_msl * 0.02953).toFixed(2)} inHg` : `${Math.round(cur.pressure_msl)} hPa`),
            h('dt', 'Precip'), h('dd', `${cur.precipitation} ${u.precipitation}`),
            h('dt', 'High / Low'), h('dd', `${Math.round(w.daily.temperature_2m_max[0])}° / ${Math.round(w.daily.temperature_2m_min[0])}°`),
            h('dt', 'Sunrise / Sunset'), h('dd', `${time(w.daily.sunrise[0])} / ${time(w.daily.sunset[0])}`),
          ),
        );
      } catch {
        body.replaceChildren(h('span.muted', 'Weather is unavailable right now.'));
      }
    };
    unitBtn.addEventListener('click', () => { store.set('units', imperial() ? 'metric' : 'imperial'); render(); });
    render();
    return el;
  }

  // ---------- weather impact (Meteomatics, via our server) ----------

  const LEVELS = { 1: 'Minor', 2: 'Moderate', 3: 'Severe' };
  const HAZARD_ICON = { wind: '💨', rain: '🌧️', snow: '❄️', ice: '🧊', storm: '⛈️', hail: '🌨️', fog: '🌫️', heat: '🔥', cold: '🥶' };

  function fmtVal(v, unit) {
    if (v == null) return '—';
    const imp = imperial();
    switch (unit) {
      case 'ms': return imp ? `${Math.round(v * 2.237)} mph` : `${Math.round(v * 3.6)} km/h`;
      case 'mm': return imp ? `${(v / 25.4).toFixed(2)} in` : `${v.toFixed(1)} mm`;
      case 'cm': return imp ? `${(v / 2.54).toFixed(1)} in` : `${v.toFixed(1)} cm`;
      case 'pct': return `${Math.round(v)}%`;
      case 'm': return imp ? `${(v / 1609.34).toFixed(v < 1609 ? 2 : 1)} mi` : `${(v / 1000).toFixed(1)} km`;
      case 'c': return imp ? `${Math.round(v * 9 / 5 + 32)}°F` : `${Math.round(v)}°C`;
      default: return String(v);
    }
  }

  function fmtWhen(ts, tz) {
    const opts = { weekday: 'short', hour: 'numeric' };
    let s;
    try { s = new Date(ts).toLocaleString([], { ...opts, timeZone: tz || undefined }); } catch { s = new Date(ts).toLocaleString([], opts); }
    const hrs = Math.round((ts - Date.now()) / 3.6e6);
    return hrs <= 0 ? `${s} (now)` : `${s} (in ${hrs}h)`;
  }

  function describe(e) {
    switch (e.type) {
      case 'wind': return `Gusts to ${fmtVal(e.peak, 'ms')}`;
      case 'rain': return `${fmtVal(e.total, 'mm')} total, up to ${fmtVal(e.peak, 'mm')}/h`;
      case 'snow': return `${fmtVal(e.total, 'cm')} new snow, up to ${fmtVal(e.peak, 'cm')}/h`;
      case 'ice': return `Freezing rain or sleet, ${fmtVal(e.total, 'mm')} total`;
      case 'storm': return `${fmtVal(e.peak, 'pct')} thunderstorm chance`;
      case 'hail': return `Hail up to ${fmtVal(e.peak, 'cm')}`;
      case 'fog': return `Visibility down to ${fmtVal(e.peak, 'm')}`;
      case 'heat': return `Feels like ${fmtVal(e.peak, 'c')}`;
      case 'cold': return `Feels like ${fmtVal(e.peak, 'c')}`;
      default: return e.label;
    }
  }

  // Level is always shown as icon + word, never color alone.
  function levelTag(level) {
    return h(`span.lvl.lvl-${level}`, { title: `${LEVELS[level]} impact` }, level === 3 ? '▲ ' : level === 2 ? '◆ ' : '● ', LEVELS[level]);
  }

  function impactChip(c) {
    const s = c.impact;
    if (!s || !s.level) return null;
    const top = s.events[0];
    return h(`span.impact-chip.lvl-${s.level}`, { title: `${LEVELS[s.level]}: ${s.events.map((e) => e.label).join(', ')}` },
      `${HAZARD_ICON[top.type] || '⚠'} ${top.label}${s.events.length > 1 ? ` +${s.events.length - 1}` : ''}`);
  }

  function eventRow(e, tz) {
    return h('div.event',
      h('div.event-head', h('span', `${HAZARD_ICON[e.type] || '⚠'} `, h('b', e.label)), levelTag(e.level)),
      h('div', describe(e)),
      h('div.muted', e.start === e.end ? fmtWhen(e.peakAt, tz) : `Peak ${fmtWhen(e.peakAt, tz)} · ${e.hours}h affected`),
    );
  }

  // Three small multiples (gusts, precip, feels-like) over the forecast window.
  // One y-axis each, a shared crosshair, and a single tooltip that reads all three.
  function outlookChart(hours, events, tz) {
    const wrap = h('div.outlook');
    const tip = h('div.chart-tip', { role: 'status', hidden: true });
    const svgNS = 'http://www.w3.org/2000/svg';
    const s = (tag, attrs = {}) => {
      const el = document.createElementNS(svgNS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      return el;
    };
    const imp = imperial();
    const series = [
      { key: 'gust', title: `Wind gusts (${imp ? 'mph' : 'km/h'})`, conv: (v) => (v == null ? null : imp ? v * 2.237 : v * 3.6), unit: 'ms', type: 'line' },
      { key: 'precip', title: `Precipitation per hour (${imp ? 'in' : 'mm'})`, conv: (v) => (v == null ? null : imp ? v / 25.4 : v), unit: 'mm', type: 'bar' },
      { key: 'feels', title: `Feels like (${imp ? '°F' : '°C'})`, conv: (v) => (v == null ? null : imp ? v * 9 / 5 + 32 : v), unit: 'c', type: 'line' },
    ];
    // Hour -> worst hazard level, for background bands.
    const hazardAt = new Map();
    for (const e of events) {
      for (const [t, lvl] of e.at || []) hazardAt.set(t, Math.max(hazardAt.get(t) || 0, lvl));
    }

    const draw = () => {
      wrap.querySelectorAll('svg').forEach((n) => n.remove());
      wrap.querySelectorAll('.chart-title').forEach((n) => n.remove());
      const W = Math.max(wrap.clientWidth, 260);
      const H = 92;
      const pad = { l: 40, r: 10, t: 8, b: 18 };
      const iw = W - pad.l - pad.r;
      const ih = H - pad.t - pad.b;
      const n = hours.length;
      const x = (i) => pad.l + (n <= 1 ? 0 : (i / (n - 1)) * iw);
      const svgs = [];

      for (const ser of series) {
        const vals = hours.map((hr) => ser.conv(hr[ser.key]));
        const finite = vals.filter((v) => v != null);
        let lo = ser.type === 'bar' ? 0 : Math.min(...finite);
        let hi = Math.max(...finite, ser.type === 'bar' ? (imp ? 0.1 : 2) : -Infinity);
        if (!finite.length) { lo = 0; hi = 1; }
        // Keep a minimum span so near-flat lines don't look dramatic.
        const minSpan = ser.type === 'bar' ? 0 : 10;
        if (hi - lo < minSpan) { const mid = (hi + lo) / 2; hi = mid + minSpan / 2; lo = mid - minSpan / 2; }
        if (hi === lo) hi += 1;
        const y = (v) => pad.t + ih - ((v - lo) / (hi - lo)) * ih;

        const svg = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' });
        // Hazard bands behind the data.
        hours.forEach((hr, i) => {
          const lvl = hazardAt.get(hr.t);
          if (!lvl) return;
          const bw = iw / Math.max(n - 1, 1);
          svg.append(s('rect', { x: x(i) - bw / 2, y: pad.t, width: bw, height: ih, class: `band lvl-${lvl}` }));
        });
        // Recessive grid: baseline + top value.
        for (const v of [lo, hi]) {
          svg.append(s('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: 'grid' }));
          const lab = s('text', { x: pad.l - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'axis' });
          lab.textContent = ser.type === 'bar' && imp ? v.toFixed(2) : Math.round(v);
          svg.append(lab);
        }
        // Day ticks at local midnight.
        hours.forEach((hr, i) => {
          let hour;
          try { hour = Number(new Date(hr.t).toLocaleString('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tz || undefined })); } catch { hour = new Date(hr.t).getHours(); }
          if (hour === 0 && ser === series[series.length - 1]) {
            const lab = s('text', { x: x(i), y: H - 4, 'text-anchor': 'middle', class: 'axis' });
            lab.textContent = new Date(hr.t).toLocaleDateString([], { weekday: 'short', timeZone: tz || undefined });
            svg.append(lab);
          }
          if (hour === 0) svg.append(s('line', { x1: x(i), x2: x(i), y1: pad.t, y2: pad.t + ih, class: 'grid' }));
        });

        if (ser.type === 'bar') {
          const bw = Math.max(1, iw / n - 2); // 2px gap between bars
          vals.forEach((v, i) => {
            if (!v) return;
            const top = y(v);
            const hgt = Math.max(1, pad.t + ih - top);
            svg.append(s('path', { d: `M${x(i) - bw / 2},${pad.t + ih} v${-hgt + Math.min(2, hgt)} q0,-2 2,-2 h${bw - 4} q2,0 2,2 v${hgt - Math.min(2, hgt)} z`, class: 'bar' }));
          });
        } else {
          let d = '';
          vals.forEach((v, i) => { if (v != null) d += `${d ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`; });
          svg.append(s('path', { d, class: 'line' }));
        }
        // Direct label on the peak only.
        if (finite.length && ser.type !== 'bar') {
          const pi = vals.indexOf(Math.max(...finite));
          const lab = s('text', { x: Math.min(Math.max(x(pi), pad.l + 14), W - pad.r - 14), y: Math.max(y(vals[pi]) - 5, 10), 'text-anchor': 'middle', class: 'peak' });
          lab.textContent = Math.round(vals[pi]);
          svg.append(lab);
        }
        const cross = s('line', { y1: pad.t, y2: pad.t + ih, class: 'cross', visibility: 'hidden' });
        svg.append(cross);
        svg._cross = cross;
        wrap.append(h('div.chart-title', ser.title), svg);
        svgs.push(svg);
      }

      // Shared crosshair: snap to the nearest hour, read every series.
      const move = (ev) => {
        const r = ev.currentTarget.getBoundingClientRect();
        const px = ev.clientX - r.left;
        const i = Math.round(((px - pad.l) / iw) * (n - 1));
        if (i < 0 || i >= n) return leave();
        const hr = hours[i];
        for (const g of svgs) {
          g._cross.setAttribute('x1', x(i));
          g._cross.setAttribute('x2', x(i));
          g._cross.setAttribute('visibility', 'visible');
        }
        const active = events.filter((e) => (e.at || []).some(([t]) => t === hr.t)).map((e) => e.label);
        tip.replaceChildren(
          h('div.muted', fmtWhen(hr.t, tz)),
          h('div', h('b', fmtVal(hr.gust, 'ms')), h('span.muted', ' gusts')),
          h('div', h('b', fmtVal(hr.precip, 'mm')), h('span.muted', ' precip')),
          h('div', h('b', fmtVal(hr.feels, 'c')), h('span.muted', ' feels like')),
          active.length ? h('div', { style: { marginTop: '4px' } }, active.join(', ')) : null,
        );
        tip.hidden = false;
        const wr = wrap.getBoundingClientRect();
        const left = ev.clientX - wr.left;
        tip.style.left = `${Math.min(Math.max(left + 12, 0), wr.width - 170)}px`;
        tip.style.top = `${ev.clientY - wr.top + 12}px`;
      };
      const leave = () => {
        tip.hidden = true;
        for (const g of svgs) g._cross.setAttribute('visibility', 'hidden');
      };
      for (const g of svgs) {
        g.addEventListener('pointermove', move);
        g.addEventListener('pointerleave', leave);
      }
    };

    wrap.append(tip);
    const ro = new ResizeObserver(() => draw());
    ro.observe(wrap);
    cleanup.push(() => ro.disconnect());

    // Table view: every hour, readable without hovering.
    const table = h('details', h('summary.muted', 'Hourly table'),
      h('div.table-wrap', h('table',
        h('thead', h('tr', h('th', 'Time'), h('th', 'Gusts'), h('th', 'Precip'), h('th', 'Snow'), h('th', 'Storm %'), h('th', 'Feels'), h('th', 'Visibility'))),
        h('tbody', hours.map((hr) => h('tr',
          h('td', new Date(hr.t).toLocaleString([], { weekday: 'short', hour: 'numeric', timeZone: tz || undefined })),
          h('td', fmtVal(hr.gust, 'ms')), h('td', fmtVal(hr.precip, 'mm')), h('td', fmtVal(hr.snow, 'cm')),
          h('td', fmtVal(hr.tstorm, 'pct')), h('td', fmtVal(hr.feels, 'c')), h('td', fmtVal(hr.vis, 'm'))))))));
    return h('div', wrap, table);
  }

  function impactPanel(c, getTz) {
    const body = h('div', h('span.muted', 'Loading outlook…'));
    const el = h('div.panel', h('h3', 'Weather impact outlook'), body);
    api(`/api/cameras/${c.id}/impact`).then((r) => {
      if (!r.configured) return body.replaceChildren(h('span.muted', 'Meteomatics is not configured on this server.'));
      if (!r.hours.length) return body.replaceChildren(h('span.muted', r.error ? `Forecast unavailable: ${r.error}` : 'No forecast yet. The next scan will include this camera.'));
      const tz = getTz();
      body.replaceChildren(
        r.events.length
          ? h('div.events', r.events.map((e) => eventRow(e, tz)))
          : h('p', '✓ No impactful weather in the next ', String(r.hours.length - 1), ' hours.'),
        outlookChart(r.hours, r.events, tz),
        h('div.muted.small', `Meteomatics forecast · updated ${ago(r.updatedAt)}`),
      );
    }).catch(() => body.replaceChildren(h('span.muted', 'Outlook unavailable.')));
    return el;
  }

  async function viewImpact(params) {
    document.title = 'Weather Watch · SkyWindow';
    const hazard = params.get('hazard') || '';
    const minLevel = params.get('minLevel') || '1';
    const q = new URLSearchParams({ minLevel, ...(hazard ? { hazard } : {}) });
    const r = await api(`/api/impact?${q}`);

    const header = h('div',
      h('div.row', h('h1', 'Weather Watch'), h('span.spacer'),
        r.updatedAt ? h('span.muted', `Meteomatics forecast, next ${r.horizonHours}h · updated ${ago(r.updatedAt)}`) : null),
      h('p.muted', 'Cameras ranked by how much impactful weather is forecast at their location. Sooner and stronger events rank higher.'));

    if (!r.configured) {
      setView(header, h('div.empty',
        h('p', 'Meteomatics is not configured on this server.'),
        h('p', 'Set ', h('code', 'METEOMATICS_USERNAME'), ' and ', h('code', 'METEOMATICS_PASSWORD'), ' and restart.')));
      return;
    }

    const chips = h('div.chips',
      h(`a.chip${hazard ? '' : '.active'}`, { href: '/impact', 'data-link': true }, 'All hazards'),
      Object.entries(r.hazards).map(([k, label]) => h(`a.chip${hazard === k ? '.active' : ''}`, { href: `/impact?hazard=${k}`, 'data-link': true }, `${HAZARD_ICON[k]} ${label}`)));

    const counts = { 1: 0, 2: 0, 3: 0 };
    r.cameras.forEach((c) => { counts[c.impact.level] += 1; });

    const rows = r.cameras.map((c) => h('a.impact-row', { href: `/cam/${c.slug}`, 'data-link': true },
      h('div.impact-thumb', thumbBlock(c, { fav: false })),
      h('div.impact-main',
        h('div.row', h('b', c.name), levelTag(c.impact.level)),
        h('div.muted', `${flag(c.country)} ${place(c) || 'Worldwide'}`),
        h('div.impact-events', c.impact.events.map((e) => h(`span.impact-chip.static.lvl-${e.level}`, `${HAZARD_ICON[e.type]} ${e.label} · ${fmtWhen(e.peakAt, c.timezone).replace(/ \(.*\)$/, '')}`)))),
      h('div.impact-score', h('b', c.impact.score), h('span.muted', 'score'))));

    setView(
      header,
      r.error ? h('div.panel.errors', `Last refresh failed: ${r.error}. Showing the previous forecast.`) : null,
      h('div.stats', { style: { marginBottom: '16px' } },
        [3, 2, 1].map((l) => h('div.stat', h('b', counts[l]), h('span', levelTag(l), ' cameras')))),
      chips,
      h('div.impact-list', rows.length ? rows : h('div.empty', hazard ? 'No cameras expect this hazard in the forecast window.' : 'No impactful weather forecast at any camera. Quiet day.')),
    );
  }

  // ---------- views ----------

  async function viewHome() {
    document.title = 'SkyWindow · Live Cams';
    const [meta, featured, live, still, watch] = await Promise.all([
      api('/api/meta'),
      api('/api/cameras?featured=true&limit=12'),
      api('/api/cameras?type=live&limit=12'),
      api('/api/cameras?type=still&limit=12'),
      api('/api/impact').catch(() => ({ cameras: [] })),
    ]);
    const hero = featured.cameras.find((c) => c.live) || featured.cameras[0] || live.cameras[0] || still.cameras[0];

    const heroBox = h('div.hero-main');
    if (hero) {
      const p = player(hero);
      cleanup.push(p.destroy);
      heroBox.append(p.el);
    } else {
      heroBox.append(h('div.empty', 'No cameras yet. Add some in Admin.'));
    }

    const cats = Object.entries(meta.categories).sort((a, b) => b[1] - a[1]);
    const countries = Object.entries(meta.countries).sort((a, b) => countryName(a[0]).localeCompare(countryName(b[0])));

    setView(
      h('div.hero',
        heroBox,
        h('div.hero-side',
          hero ? h('div.panel',
            h('h3', 'Featured'),
            h('h2', h('a', { href: `/cam/${hero.slug}`, 'data-link': true }, hero.name)),
            h('div.muted', `${flag(hero.country)} ${place(hero)}`),
            hero.description ? h('p', hero.description) : null,
          ) : null,
          h('div.stats',
            h('div.stat', h('b', meta.total), h('span', 'cameras')),
            h('div.stat', h('b', meta.live), h('span', 'live streams')),
            h('div.stat', h('b', meta.still), h('span', 'still cams')),
          ),
          h('div.chips', cats.map(([k, n]) => h('a.chip', { href: `/category/${k}`, 'data-link': true }, `${cap(k)} · ${n}`))),
          h('a.btn', { href: '/map', 'data-link': true }, '🗺️  Open the map'),
        ),
      ),
      watch.cameras.length ? section('⚠ Weather Watch', grid(watch.cameras.slice(0, 4)), '/impact') : null,
      featured.cameras.length ? section('Featured', grid(featured.cameras), '/browse?featured=true') : null,
      section('Live streams', grid(live.cameras, 'No live streams yet.'), '/browse?type=live'),
      section('Still cameras', grid(still.cameras, 'No still cameras yet.'), '/browse?type=still'),
      countries.length ? section('Browse by country', h('div.countries', countries.map(([cc, n]) =>
        h('a.country', { href: `/country/${cc}`, 'data-link': true }, h('span', `${flag(cc)} ${countryName(cc)}`), h('span.muted', n))))) : null,
    );
  }

  async function viewBrowse(params) {
    const meta = await api('/api/meta');
    const state = {
      q: params.get('q') || '',
      country: params.get('country') || '',
      category: params.get('category') || '',
      type: params.get('type') || '',
      featured: params.get('featured') || '',
    };
    const title = state.country ? `${flag(state.country)} ${countryName(state.country)}`
      : state.category ? cap(state.category)
        : state.q ? `Results for “${state.q}”` : 'All cameras';
    document.title = `${title} · SkyWindow`;

    const results = h('div');
    const count = h('span.muted');
    const run = async () => {
      const q = new URLSearchParams(Object.entries(state).filter(([, v]) => v));
      history.replaceState(null, '', `/browse${q.toString() ? `?${q}` : ''}`);
      const { cameras, total } = await api(`/api/cameras?${q}`);
      count.textContent = `${total} camera${total === 1 ? '' : 's'}`;
      results.replaceChildren(grid(cameras));
    };

    const qInput = h('input.input', { type: 'search', value: state.q, placeholder: 'Filter by name, place, tag…', 'aria-label': 'Filter' });
    let t;
    qInput.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { state.q = qInput.value; run(); }, 200); });
    const sel = (key, label, options) => {
      const s = h('select', { 'aria-label': label },
        h('option', { value: '' }, label),
        options.map(([v, text]) => h('option', { value: v, selected: state[key] === v }, text)));
      s.addEventListener('change', () => { state[key] = s.value; run(); });
      return s;
    };

    setView(
      h('div.row', h('h1', title), h('span.spacer'), count),
      h('div.filters',
        h('div.q', qInput),
        sel('type', 'Live + still', [['live', 'Live streams'], ['still', 'Still cameras']]),
        sel('category', 'All categories', meta.allCategories.filter((k) => meta.categories[k]).map((k) => [k, `${cap(k)} (${meta.categories[k]})`])),
        sel('country', 'All countries', Object.keys(meta.countries).sort((a, b) => countryName(a).localeCompare(countryName(b))).map((cc) => [cc, `${flag(cc)} ${countryName(cc)}`])),
      ),
      results,
    );
    await run();
  }

  async function viewMap(params) {
    document.title = 'Map · SkyWindow';
    const { cameras } = await api('/api/cameras?limit=2000');
    const mapEl = h('div#map');
    let filter = params.get('type') || 'all';
    const btns = ['all', 'live', 'still', 'impact'].map((k) => h('button.btn.small', { type: 'button', 'aria-pressed': String(filter === k), 'data-k': k }, k === 'impact' ? '⚠ Weather impact' : cap(k)));
    const locate = h('button.btn.small', { type: 'button' }, '📍 Near me');
    setView(h('div.map-page', mapEl, h('div.map-tools', btns, locate)));

    const map = L.map(mapEl, { worldCopyJump: true, zoomControl: true }).setView([25, -40], 3);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19, subdomains: 'abcd',
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/attributions">CARTO</a>',
    }).addTo(map);
    cleanup.push(() => map.remove());

    // In impact mode a cluster shows the worst level inside it, so nothing severe hides in a group.
    const cluster = L.markerClusterGroup({
      showCoverageOnHover: false,
      maxClusterRadius: 45,
      iconCreateFunction: (cl) => {
        const n = cl.getChildCount();
        const worst = filter === 'impact' ? Math.max(...cl.getAllChildMarkers().map((m) => m.options.lvl || 0)) : 0;
        const size = n < 10 ? 'small' : n < 100 ? 'medium' : 'large';
        return L.divIcon({
          html: `<div><span>${n}</span></div>`,
          className: `marker-cluster marker-cluster-${size}${worst ? ` cluster-lvl-${worst}` : ''}`,
          iconSize: L.point(40, 40),
        });
      },
    });
    map.addLayer(cluster);

    const popup = (c) => {
      const src = thumbFor(c);
      return h('div.popup',
        src ? h('img', { src, alt: '' }) : null,
        h('div', h('b', c.name)),
        h('div.muted', `${flag(c.country)} ${place(c)}`),
        c.impact && c.impact.level ? h('div', { style: { marginTop: '4px' } }, levelTag(c.impact.level), ' ', c.impact.events.map((e) => e.label).join(', ')) : null,
        h('div.row', { style: { marginTop: '6px' } },
          h(`span.badge.${c.live ? 'live' : 'still'}`, { style: { position: 'static' } }, c.live ? 'LIVE' : 'STILL'),
          h('a', { href: `/cam/${c.slug}`, 'data-link': true }, 'Watch →')),
      );
    };

    const draw = () => {
      cluster.clearLayers();
      const shown = cameras.filter((c) => (filter === 'impact' ? c.impact && c.impact.level > 0 : filter === 'all' || (filter === 'live') === c.live));
      if (filter === 'impact' && !shown.length) toast('No impactful weather forecast at any camera.');
      for (const c of shown) {
        const lvl = filter === 'impact' && c.impact ? c.impact.level : 0;
        const icon = L.divIcon({ className: '', html: lvl ? `<div class="pin lvl-${lvl}">${lvl === 3 ? '▲' : lvl === 2 ? '◆' : '●'}</div>` : `<div class="pin ${c.live ? 'live' : 'still'}"></div>`, iconSize: lvl ? [20, 20] : [14, 14] });
        L.marker([c.lat, c.lon], { icon, title: c.name, lvl }).bindPopup(() => popup(c)).addTo(cluster);
      }
      if (shown.length && !params.get('lat')) map.fitBounds(cluster.getBounds().pad(0.2), { maxZoom: 6 });
    };
    btns.forEach((b) => b.addEventListener('click', () => {
      filter = b.dataset.k;
      btns.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      draw();
    }));
    locate.addEventListener('click', () => {
      if (!navigator.geolocation) return toast('Location is not available in this browser.');
      navigator.geolocation.getCurrentPosition(
        (p) => map.setView([p.coords.latitude, p.coords.longitude], 8),
        () => toast('Could not get your location.'),
      );
    });
    draw();
    if (params.get('lat')) map.setView([Number(params.get('lat')), Number(params.get('lon'))], Number(params.get('z')) || 8);
  }

  async function viewCam(slug, { embed = false } = {}) {
    let data;
    try {
      data = await api(`/api/cameras/${encodeURIComponent(slug)}`);
    } catch (e) {
      if (e.status === 404) return viewNotFound();
      throw e;
    }
    const { camera: c, nearby } = data;
    document.title = `${c.name} · SkyWindow`;

    const p = player(c, { timelapse: !c.live && !embed });
    cleanup.push(p.destroy);
    if (embed) {
      setView(p.el);
      return;
    }

    // Local time at the camera. Use the camera's timezone or the one Open-Meteo reports.
    let tz = c.timezone || null;
    const clock = h('div.clock', '--:--');
    const tzLabel = h('div.muted');
    const tick = () => {
      try {
        clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: tz || undefined });
        tzLabel.textContent = tz ? tz.replace(/_/g, ' ') : 'your local time';
      } catch { tz = null; }
    };
    tick();
    const clockTimer = setInterval(tick, 15000);
    cleanup.push(() => clearInterval(clockTimer));

    const favBtn = h('button.btn', { type: 'button', 'aria-pressed': String(favs.has(c.id)) }, favs.has(c.id) ? '★ Saved' : '☆ Save');
    favBtn.addEventListener('click', () => {
      const on = favs.toggle(c.id);
      favBtn.setAttribute('aria-pressed', String(on));
      favBtn.textContent = on ? '★ Saved' : '☆ Save';
    });
    const shareBtn = h('button.btn', { type: 'button' }, '🔗 Share');
    shareBtn.addEventListener('click', async () => {
      const url = location.href;
      try {
        if (navigator.share) await navigator.share({ title: c.name, url });
        else { await navigator.clipboard.writeText(url); toast('Link copied'); }
      } catch { /* cancelled */ }
    });

    const embedCode = `<iframe src="${location.origin}/embed/${c.slug}" width="640" height="360" frameborder="0" allowfullscreen></iframe>`;
    const statusText = c.live
      ? (c.status === 'online' ? 'Stream reachable' : c.status === 'offline' ? 'Stream unreachable' : 'Embedded player')
      : c.lastOk ? `Updated ${ago(c.lastOk)}` : 'Waiting for first image';

    setView(
      h('div.cam-layout',
        h('div',
          p.el,
          h('div.row', { style: { margin: '14px 0 6px' } },
            h('h1', { style: { margin: 0 } }, c.name),
            h('span.spacer'),
            favBtn, shareBtn,
          ),
          h('div.row.muted',
            h(`span.dot.${c.status}`), statusText, '·',
            h('a', { href: c.country ? `/country/${c.country}` : '/browse', 'data-link': true }, `${flag(c.country)} ${place(c) || 'Worldwide'}`), '·',
            h('a', { href: `/category/${c.category}`, 'data-link': true }, cap(c.category)),
          ),
          c.description ? h('p', c.description) : null,
          c.source ? h('p.muted', 'Source: ', c.sourceUrl ? h('a', { href: c.sourceUrl, target: '_blank', rel: 'noopener' }, c.source) : c.source) : null,
          c.tags && c.tags.length ? h('div.chips', c.tags.map((t) => h('a.chip', { href: `/browse?q=${encodeURIComponent(t)}`, 'data-link': true }, `#${t}`))) : null,
          impactPanel(c, () => tz),
          h('details', { style: { marginTop: '16px' } }, h('summary.muted', 'Embed this camera'), h('pre', embedCode)),
        ),
        h('aside',
          h('div.panel', h('h3', 'Local time'), clock, tzLabel),
          weatherPanel(c, (zone) => { if (!c.timezone) { tz = zone; tick(); } }),
          h('div.panel',
            h('h3', 'Location'),
            h('dl.kv',
              h('dt', 'Lat / Lon'), h('dd', `${c.lat.toFixed(3)}, ${c.lon.toFixed(3)}`),
              h('dt', 'Type'), h('dd', c.live ? `Live (${c.kind.toUpperCase()})` : c.kind === 'push' ? 'Still (pushed)' : `Still, every ${Math.round(c.refreshSeconds / 60)} min`),
            ),
            h('div', { style: { marginTop: '8px' } }, h('a', { href: `/map?lat=${c.lat}&lon=${c.lon}&z=8`, 'data-link': true }, 'View on map →')),
          ),
          nearby.length ? h('div.panel',
            h('h3', 'Nearby cameras'),
            h('div.mini-list', nearby.map((n) => h('a.mini', { href: `/cam/${n.slug}`, 'data-link': true },
              thumbBlock(n, { fav: false }),
              h('div', h('div.card-title', n.name), h('div.muted', `${n.distanceKm.toLocaleString()} km`)))))) : null,
        ),
      ),
    );
  }

  async function viewFavorites() {
    document.title = 'Favorites · SkyWindow';
    const ids = favs.list();
    const { cameras } = await api('/api/cameras?limit=2000');
    const mine = cameras.filter((c) => ids.includes(c.id));
    setView(
      h('h1', 'Favorites'),
      h('p.muted', 'Saved in this browser.'),
      grid(mine, 'No favorites yet. Tap ☆ on any camera to save it here.'),
    );
  }

  // ---------- admin ----------

  async function viewAdmin() {
    document.title = 'Admin · SkyWindow';
    let token = sessionStorage.getItem('adminToken') || '';
    const auth = () => ({ authorization: `Bearer ${token}` });

    const login = () => {
      const input = h('input.input', { type: 'password', placeholder: 'ADMIN_TOKEN', 'aria-label': 'Admin token' });
      const err = h('div.errors');
      const form = h('form.panel.form', { style: { maxWidth: '420px' } },
        h('h2', 'Admin sign in'),
        h('p.muted', 'Enter the ADMIN_TOKEN set on the server.'),
        input, err, h('button.btn.primary', { type: 'submit' }, 'Sign in'));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        token = input.value.trim();
        try {
          await api('/api/admin/cameras', { headers: auth() });
          sessionStorage.setItem('adminToken', token);
          render();
        } catch (ex) { err.textContent = ex.message; }
      });
      setView(form);
      input.focus();
    };

    const fields = (c = {}) => {
      const f = (name, label, attrs = {}) => h('label', label, h('input.input', { name, value: c[name] ?? '', ...attrs }));
      return h('form.form',
        f('name', 'Name', { required: true }),
        h('label', 'Type',
          h('select', { name: 'kind' },
            [['image', 'Still image URL (server polls it)'], ['push', 'Still image, camera pushes to us'], ['hls', 'Live HLS stream (.m3u8)'],
              ['youtube', 'Live YouTube (video or channel ID)'], ['mjpeg', 'Live MJPEG stream'], ['iframe', 'Live embed (iframe URL)']]
              .map(([v, t]) => h('option', { value: v, selected: (c.kind || 'image') === v }, t)))),
        f('url', 'Source URL / ID'),
        h('div.two', f('lat', 'Latitude', { type: 'number', step: 'any', required: true }), f('lon', 'Longitude', { type: 'number', step: 'any', required: true })),
        h('div.two', f('city', 'City'), f('region', 'Region / state')),
        h('div.two',
          f('country', 'Country (ISO code, e.g. US)', { maxlength: '2' }),
          h('label', 'Category', h('select', { name: 'category' }, CATS.map((k) => h('option', { value: k, selected: (c.category || 'other') === k }, cap(k)))))),
        h('div.two', f('refreshSeconds', 'Still refresh (seconds)', { type: 'number', min: '30', value: c.refreshSeconds ?? 300 }), f('timezone', 'Timezone (optional, IANA)')),
        f('poster', 'Poster image URL (live cams, optional)'),
        h('label', 'Description', h('textarea', { name: 'description', rows: '3' }, c.description || '')),
        h('div.two', f('source', 'Source / credit'), f('sourceUrl', 'Source link')),
        f('tags', 'Tags (comma separated)', { value: (c.tags || []).join(', ') }),
        h('div.row',
          h('label.check', h('input', { type: 'checkbox', name: 'featured', checked: Boolean(c.featured) }), 'Featured'),
          h('label.check', h('input', { type: 'checkbox', name: 'enabled', checked: c.enabled !== false }), 'Enabled')),
      );
    };

    const readForm = (form) => {
      const fd = new FormData(form);
      const o = Object.fromEntries(fd.entries());
      o.featured = fd.has('featured');
      o.enabled = fd.has('enabled');
      o.tags = String(o.tags || '').split(',').map((s) => s.trim()).filter(Boolean);
      return o;
    };

    let CATS = [];
    const render = async (editing = null) => {
      let list;
      try {
        ({ cameras: list } = await api('/api/admin/cameras', { headers: auth() }));
        CATS = (await api('/api/meta')).allCategories;
      } catch (e) {
        if (e.status === 401 || e.status === 503) {
          sessionStorage.removeItem('adminToken');
          if (e.status === 503) return setView(h('div.empty', 'Admin is disabled. Set ADMIN_TOKEN on the server and restart.'));
          return login();
        }
        throw e;
      }

      const form = fields(editing || {});
      const errs = h('div.errors');
      const ingest = editing && editing.kind === 'push' && editing.ingestKey
        ? h('div', h('h3', { style: { marginTop: '12px' } }, 'Push ingest'),
          h('p.muted', 'Have the camera (or a cron job on a Pi) POST each frame:'),
          h('pre', `curl -X POST \\\n  -H "Authorization: Bearer ${editing.ingestKey}" \\\n  -H "Content-Type: image/jpeg" \\\n  --data-binary @frame.jpg \\\n  ${location.origin}/api/ingest/${editing.id}`))
        : null;
      form.append(errs, h('div.row',
        h('button.btn.primary', { type: 'submit' }, editing ? 'Save changes' : 'Add camera'),
        editing ? h('button.btn', { type: 'button', onclick: () => render() }, 'Cancel') : null));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errs.textContent = '';
        try {
          const body = JSON.stringify(readForm(form));
          const r = editing
            ? await api(`/api/admin/cameras/${editing.id}`, { method: 'PUT', headers: auth(), body })
            : await api('/api/admin/cameras', { method: 'POST', headers: auth(), body });
          toast(editing ? 'Saved' : 'Camera added');
          render(r.camera.kind === 'push' ? r.camera : null);
        } catch (ex) { errs.textContent = ex.message; }
      });

      const rows = list.sort((a, b) => a.name.localeCompare(b.name)).map((c) => h('tr',
        h('td', h(`span.dot.${c.status}`, { title: c.error || c.status })),
        h('td', h('a', { href: `/cam/${c.slug}`, 'data-link': true }, c.name), c.enabled === false ? h('span.muted', ' (disabled)') : null,
          c.error ? h('div.errors', { style: { fontSize: '.8rem' } }, c.error) : null),
        h('td', c.kind),
        h('td', c.lastOk ? ago(c.lastOk) : '—'),
        h('td', h('div.row',
          h('button.btn.small', { type: 'button', onclick: () => render(c) }, 'Edit'),
          h('button.btn.small', { type: 'button', onclick: async () => { await api(`/api/admin/cameras/${c.id}/check`, { method: 'POST', headers: auth() }); render(editing); } }, 'Check'),
          h('button.btn.small.danger', { type: 'button', onclick: async () => {
            if (!confirm(`Delete “${c.name}” and its archived images?`)) return;
            await api(`/api/admin/cameras/${c.id}`, { method: 'DELETE', headers: auth() });
            render();
          } }, 'Delete'))),
      ));

      setView(
        h('div.row', h('h1', 'Admin'), h('span.spacer'),
          h('button.btn', { type: 'button', onclick: async (e) => {
            e.target.disabled = true;
            try {
              const r = await api('/api/admin/impact/refresh', { method: 'POST', headers: auth() });
              toast(`Weather scan updated for ${r.locations} locations`);
            } catch (ex) { toast(`Weather scan failed: ${ex.message}`); }
            e.target.disabled = false;
          } }, '⚠ Refresh weather scan'),
          h('button.btn', { type: 'button', onclick: () => { sessionStorage.removeItem('adminToken'); token = ''; login(); } }, 'Sign out')),
        h('div.admin-grid',
          h('div.panel.table-wrap',
            h('h3', `${list.length} cameras`),
            h('table', h('thead', h('tr', h('th', ''), h('th', 'Name'), h('th', 'Type'), h('th', 'Last image'), h('th', ''))), h('tbody', rows))),
          h('div.panel', h('h3', editing ? `Edit: ${editing.name}` : 'Add a camera'), form, ingest),
        ),
      );
    };

    if (!token) return login();
    return render();
  }

  function viewNotFound() {
    document.title = 'Not found · SkyWindow';
    setView(h('div.empty', h('h2', 'Camera not found'), h('a', { href: '/', 'data-link': true }, 'Back to home')));
  }

  // ---------- router ----------

  async function route() {
    cleanup.forEach((f) => { try { f(); } catch { /* ignore */ } });
    cleanup = [];
    const { pathname, search } = location;
    const params = new URLSearchParams(search);
    const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const embed = parts[0] === 'embed';
    document.body.classList.toggle('embed', embed);

    document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `/${parts[0] || ''}`));
    const searchInput = document.getElementById('search-input');
    if (parts[0] !== 'browse') searchInput.value = '';

    setView(h('div.muted', 'Loading…'));
    try {
      if (!parts.length) await viewHome();
      else if (parts[0] === 'browse') await viewBrowse(params);
      else if (parts[0] === 'country' && parts[1]) await viewBrowse(new URLSearchParams({ country: parts[1].toUpperCase() }));
      else if (parts[0] === 'category' && parts[1]) await viewBrowse(new URLSearchParams({ category: parts[1] }));
      else if (parts[0] === 'map') await viewMap(params);
      else if ((parts[0] === 'cam' || embed) && parts[1]) await viewCam(parts[1], { embed });
      else if (parts[0] === 'favorites') await viewFavorites();
      else if (parts[0] === 'impact') await viewImpact(params);
      else if (parts[0] === 'admin') await viewAdmin();
      else viewNotFound();
    } catch (e) {
      console.error(e);
      setView(h('div.empty', 'Something went wrong loading this page. ', h('a', { href: location.pathname, 'data-link': true }, 'Try again')));
    }
  }

  function navigate(url) {
    if (url === location.pathname + location.search) return;
    history.pushState(null, '', url);
    window.scrollTo(0, 0);
    route();
  }

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-link]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(a.getAttribute('href'));
  });
  window.addEventListener('popstate', route);
  document.getElementById('search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = document.getElementById('search-input').value.trim();
    navigate(q ? `/browse?q=${encodeURIComponent(q)}` : '/browse');
  });

  route();
})();
