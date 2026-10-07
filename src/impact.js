'use strict';

const fs = require('fs');

// Meteomatics parameters pulled for every camera location, hourly.
// All verified against the Meteomatics "mix" model.
const PARAMS = {
  temp: 't_2m:C',
  feels: 't_apparent:C',
  wind: 'wind_speed_10m:ms',
  gust: 'wind_gusts_10m_1h:ms',
  precip: 'precip_1h:mm',
  snow: 'fresh_snow_1h:cm',
  ptype: 'precip_type_1h:idx',
  hail: 'hail_1h:cm',
  tstorm: 'prob_tstorm_1h:p',
  cape: 'cape:Jkg',
  vis: 'visibility:m',
  fog: 'is_fog_1h:idx',
  symbol: 'weather_symbol_1h:idx',
};
const KEY_BY_PARAM = Object.fromEntries(Object.entries(PARAMS).map(([k, p]) => [p, k]));

// Meteomatics precip_type_1h:idx codes.
const PTYPE = { NONE: 0, RAIN: 1, MIX: 2, SNOW: 3, SLEET: 4, FREEZING_RAIN: 5, HAIL: 6 };

// Hazard rules. Each returns a level for one hour: 0 none, 1 minor, 2 moderate, 3 severe.
// Thresholds follow common US NWS advisory/warning criteria, converted to metric.
const HAZARDS = {
  wind: {
    label: 'High wind',
    level: (h) => (h.gust >= 25.9 ? 3 : h.gust >= 20.1 ? 2 : h.gust >= 15.6 ? 1 : 0), // 58 / 45 / 35 mph gusts
    value: (h) => h.gust,
    unit: 'ms',
  },
  rain: {
    label: 'Heavy rain',
    level: (h) => (h.ptype === PTYPE.SNOW ? 0 : h.precip >= 30 ? 3 : h.precip >= 15 ? 2 : h.precip >= 6 ? 1 : 0),
    value: (h) => h.precip,
    unit: 'mm',
    total: 'precip',
  },
  snow: {
    label: 'Snow',
    level: (h) => (h.snow >= 5 ? 3 : h.snow >= 2.5 ? 2 : h.snow >= 0.5 ? 1 : 0), // ~2 / 1 / 0.2 in per hour
    value: (h) => h.snow,
    unit: 'cm',
    total: 'snow',
  },
  ice: {
    label: 'Ice',
    level: (h) => {
      if (h.ptype === PTYPE.FREEZING_RAIN && h.precip > 0) return h.precip >= 1 ? 3 : 2;
      if (h.ptype === PTYPE.SLEET && h.precip > 0) return 1;
      return 0;
    },
    value: (h) => h.precip,
    unit: 'mm',
    total: 'precip',
  },
  storm: {
    label: 'Thunderstorms',
    level: (h) => {
      // prob_tstorm alone runs high in dry, stable air (seen at 20-50% with 0 mm and 0 CAPE),
      // so require rain and some instability in the same hour before counting it.
      if (!(h.precip >= 0.5 && h.cape >= 250)) return 0;
      const p = h.tstorm || 0;
      let l = p >= 70 ? 3 : p >= 50 ? 2 : p >= 30 ? 1 : 0;
      if (l === 2 && h.cape >= 2500) l = 3; // high instability makes storms that do form stronger
      return l;
    },
    value: (h) => h.tstorm,
    unit: 'pct',
  },
  hail: {
    label: 'Hail',
    level: (h) => (h.hail >= 2.5 ? 3 : h.hail >= 0.5 ? 2 : 0),
    value: (h) => h.hail,
    unit: 'cm',
  },
  fog: {
    label: 'Dense fog',
    level: (h) => (h.vis != null && h.vis < 400 ? 2 : (h.vis != null && h.vis < 1000) || h.fog === 1 ? 1 : 0), // 1/4 mi
    value: (h) => h.vis,
    unit: 'm',
    lowIsWorse: true,
  },
  heat: {
    label: 'Heat',
    level: (h) => (h.feels >= 46 ? 3 : h.feels >= 39.4 ? 2 : h.feels >= 32.2 ? 1 : 0), // 115 / 103 / 90 °F
    value: (h) => h.feels,
    unit: 'c',
  },
  cold: {
    label: 'Extreme cold',
    level: (h) => (h.feels <= -40 ? 3 : h.feels <= -28.9 ? 2 : h.feels <= -17.8 ? 1 : 0), // -40 / -20 / 0 °F
    value: (h) => h.feels,
    unit: 'c',
    lowIsWorse: true,
  },
};

// Sooner events matter more to someone deciding which camera to watch.
function proximityWeight(hoursOut) {
  if (hoursOut <= 6) return 1.5;
  if (hoursOut <= 24) return 1;
  return 0.6;
}

// Turn an hourly series into hazard events and a score.
function assess(hours, now = Date.now()) {
  const events = [];
  for (const [type, rule] of Object.entries(HAZARDS)) {
    let ev = null;
    for (const h of hours) {
      const lvl = rule.level(h);
      if (!lvl) continue;
      const v = rule.value(h);
      if (!ev) {
        ev = { type, label: rule.label, unit: rule.unit, level: 0, start: h.t, end: h.t, peak: v, peakAt: h.t, hours: 0, total: 0, at: [] };
        events.push(ev);
      }
      ev.end = h.t;
      ev.hours += 1;
      ev.at.push([h.t, lvl]); // exact affected hours; events can be intermittent
      if (rule.total) ev.total += h[rule.total] || 0;
      const worse = rule.lowIsWorse ? v < ev.peak : v > ev.peak;
      if (lvl > ev.level || (lvl === ev.level && worse)) {
        ev.level = Math.max(ev.level, lvl);
        ev.peak = v;
        ev.peakAt = h.t;
      }
    }
  }
  for (const ev of events) {
    ev.total = Math.round(ev.total * 10) / 10;
    if (!HAZARDS[ev.type].total) delete ev.total;
  }
  events.sort((a, b) => b.level - a.level || a.start - b.start);
  const score = events.reduce((s, e) => s + e.level ** 2 * proximityWeight((e.start - now) / 3.6e6) * (1 + Math.min(e.hours, 12) / 24), 0);
  return { level: events.reduce((m, e) => Math.max(m, e.level), 0), score: Math.round(score * 10) / 10, events };
}

// Parse a Meteomatics multi-point JSON response into per-location hourly arrays.
// Coordinates come back in request order, so match by index.
function parseResponse(json, count) {
  if (json.status !== 'OK') throw new Error(json.message || 'Meteomatics error');
  const series = Array.from({ length: count }, () => new Map());
  for (const block of json.data) {
    const key = KEY_BY_PARAM[block.parameter];
    if (!key) continue;
    block.coordinates.forEach((coord, i) => {
      if (!series[i]) return;
      for (const d of coord.dates) {
        const t = Date.parse(d.date);
        if (!series[i].has(t)) series[i].set(t, { t });
        // Meteomatics uses -999 for missing values.
        series[i].get(t)[key] = d.value === -999 ? null : d.value;
      }
    });
  }
  return series.map((m) => [...m.values()].sort((a, b) => a.t - b.t));
}

const isoHour = (ms) => new Date(Math.floor(ms / 3.6e6) * 3.6e6).toISOString().replace('.000Z', 'Z');
const locKey = (c) => `${c.lat.toFixed(3)},${c.lon.toFixed(3)}`;

class ImpactService {
  constructor({ store, username, password, file, horizonHours = 48, refreshMinutes = 60, model = 'mix', chunkSize = 50, fetchImpl = fetch, log = console }) {
    this.store = store;
    this.username = username;
    this.password = password;
    this.file = file;
    this.horizonHours = Math.min(Math.max(horizonHours, 6), 240);
    this.refreshMs = Math.max(refreshMinutes, 10) * 60000;
    this.model = model;
    this.chunkSize = chunkSize;
    this.fetch = fetchImpl;
    this.log = log;
    this.state = { updatedAt: null, error: null, byLocation: {} };
    this.running = null;
    this.load();
  }

  get configured() {
    return Boolean(this.username && this.password);
  }

  load() {
    try {
      if (this.file && fs.existsSync(this.file)) this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      this.log.error('could not read impact cache', e.message);
    }
  }

  save() {
    if (!this.file) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.file);
  }

  async fetchChunk(locs, start, end) {
    const coords = locs.map((l) => `${l.lat.toFixed(4)},${l.lon.toFixed(4)}`).join('+');
    const url = `https://api.meteomatics.com/${start}--${end}:PT1H/${Object.values(PARAMS).join(',')}/${coords}/json?model=${encodeURIComponent(this.model)}`;
    const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    try {
      const res = await this.fetch(url, { headers: { authorization: `Basic ${auth}` }, signal: ctrl.signal });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { throw new Error(`Meteomatics HTTP ${res.status}: ${text.slice(0, 200)}`); }
      if (!res.ok) throw new Error(json.message || `Meteomatics HTTP ${res.status}`);
      return parseResponse(json, locs.length);
    } finally {
      clearTimeout(timer);
    }
  }

  // Fetch forecasts for every enabled camera location (deduped), then score them.
  refresh() {
    if (this.running) return this.running;
    this.running = (async () => {
      if (!this.configured) throw new Error('METEOMATICS_USERNAME and METEOMATICS_PASSWORD are not set');
      const unique = new Map();
      for (const c of this.store.all()) if (c.enabled !== false) unique.set(locKey(c), { lat: c.lat, lon: c.lon });
      const keys = [...unique.keys()];
      const now = Date.now();
      const start = isoHour(now);
      const end = isoHour(now + this.horizonHours * 3.6e6);
      const byLocation = {};
      for (let i = 0; i < keys.length; i += this.chunkSize) {
        const slice = keys.slice(i, i + this.chunkSize);
        const series = await this.fetchChunk(slice.map((k) => unique.get(k)), start, end);
        slice.forEach((k, j) => { byLocation[k] = { hours: series[j], ...assess(series[j], now) }; });
      }
      this.state = { updatedAt: Date.now(), error: null, horizonHours: this.horizonHours, model: this.model, byLocation };
      this.save();
      return this.state;
    })()
      .catch((e) => {
        this.state = { ...this.state, error: e.name === 'AbortError' ? 'Meteomatics request timed out' : e.message, lastAttempt: Date.now() };
        this.log.error('impact refresh failed:', this.state.error);
        return this.state;
      })
      .finally(() => { this.running = null; });
    return this.running;
  }

  forCamera(c) {
    return this.state.byLocation[locKey(c)] || null;
  }

  // Lightweight summary attached to every camera in list views.
  summary(c) {
    const r = this.forCamera(c);
    if (!r) return null;
    return { level: r.level, score: r.score, events: r.events.map(({ type, label, level, start, peakAt }) => ({ type, label, level, start, peakAt })) };
  }

  start() {
    if (!this.configured) return;
    const stale = !this.state.updatedAt || Date.now() - this.state.updatedAt > this.refreshMs;
    if (stale) this.refresh();
    this.timer = setInterval(() => this.refresh(), this.refreshMs);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }
}

module.exports = { ImpactService, assess, parseResponse, HAZARDS, PARAMS, locKey };
