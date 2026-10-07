'use strict';

const fs = require('fs');
const { haversineKm } = require('./store');

const UA = 'weather-map-broadcaster/0.1 (webcam storm tracker)';
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
// Atlantic and East Pacific bins. NHC rotates active storms through these.
const BINS = ['AT1', 'AT2', 'AT3', 'AT4', 'AT5', 'EP1', 'EP2', 'EP3', 'EP4', 'EP5'];

// Parse an NHC Tropical Cyclone Discussion (TCD). Only needs the header and the
// "FORECAST POSITIONS AND MAX WINDS" table, so pasted text works too.
function parseTCD(text) {
  const t = String(text || '').replace(/\r/g, '');
  const title = /^\s*((?:Potential\s+)?(?:Post-)?(?:Tropical|Subtropical|Hurricane|Remnants)[^\n]*?)\s+Discussion\s+Number\s+(\d+)/im.exec(t);
  // Issuance line, e.g. "400 AM CDT Wed Oct 07 2026" or "1000 PM AST TUE OCT 06 2026".
  const issued = /^\s*\d{3,4}\s+[AP]M\s+[A-Z]{3}\s+[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})/m.exec(t);
  if (!issued) throw new Error('could not find the issuance date line');
  const month = MONTHS[issued[1].toUpperCase()];
  const year = Number(issued[3]);
  const issueDay = Number(issued[2]);

  const points = [];
  const re = /^\s*(INIT|\d{1,3}H)\s+(\d{2})\/(\d{2})(\d{2})Z\s+(\d{1,2}\.\d)([NS])\s+(\d{1,3}\.\d)([EW])\s+(\d+)\s+KT\s+(\d+)\s+MPH(.*)$/gm;
  let m;
  while ((m = re.exec(t))) {
    const day = Number(m[2]);
    // Forecast days can roll into the next month (e.g. issued Oct 30, valid Nov 02).
    const mon = day < issueDay - 15 ? month + 1 : month;
    points.push({
      tau: m[1] === 'INIT' ? 0 : Number(m[1].slice(0, -1)),
      t: Date.UTC(year, mon, day, Number(m[3]), Number(m[4])),
      lat: Number(m[5]) * (m[6] === 'S' ? -1 : 1),
      lon: Number(m[7]) * (m[8] === 'W' ? -1 : 1),
      windKt: Number(m[9]),
      windMph: Number(m[10]),
      note: m[11].replace(/^[.\s]+/, '').trim(),
    });
  }
  if (!points.length) throw new Error('no forecast positions found (expected the "FORECAST POSITIONS AND MAX WINDS" table)');

  const name = title ? title[1].replace(/\s+/g, ' ').trim() : 'Unnamed storm';
  return {
    name,
    shortName: name.split(' ').pop(),
    advisory: title ? Number(title[2]) : null,
    issued: Date.UTC(year, month, issueDay),
    points,
  };
}

// Classification label from max wind (mph).
function category(mph) {
  if (mph >= 157) return 'Cat 5';
  if (mph >= 130) return 'Cat 4';
  if (mph >= 111) return 'Cat 3';
  if (mph >= 96) return 'Cat 2';
  if (mph >= 74) return 'Cat 1';
  if (mph >= 39) return 'TS';
  return 'TD';
}

// Hourly positions along the forecast track (linear between forecast points).
function interpolate(points) {
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const steps = Math.max(1, Math.round((b.t - a.t) / 3.6e6));
    for (let k = 0; k < steps; k++) {
      const f = k / steps;
      out.push({ t: a.t + f * (b.t - a.t), lat: a.lat + f * (b.lat - a.lat), lon: a.lon + f * (b.lon - a.lon), windMph: a.windMph + f * (b.windMph - a.windMph) });
    }
  }
  const last = points[points.length - 1];
  out.push({ t: last.t, lat: last.lat, lon: last.lon, windMph: last.windMph });
  return out;
}

// Closest approach of the forecast center to a point, and which side of the track it is on.
// The right side (in the direction of motion) usually gets the worst surge and wind.
function approach(track, cam) {
  let best = null;
  track.forEach((p, i) => {
    const d = haversineKm(p, cam);
    if (!best || d < best.km) best = { km: d, i };
  });
  const p = track[best.i];
  const a = track[Math.max(0, best.i - 1)];
  const b = track[Math.min(track.length - 1, best.i + 1)];
  // Cross product of motion vector and vector to camera (lon scaled by latitude).
  const k = Math.cos((p.lat * Math.PI) / 180);
  const mx = (b.lon - a.lon) * k;
  const my = b.lat - a.lat;
  const cx = (cam.lon - p.lon) * k;
  const cy = cam.lat - p.lat;
  const cross = mx * cy - my * cx;
  const within = (km) => {
    const hit = track.find((q) => haversineKm(q, cam) <= km);
    return hit ? hit.t : null;
  };
  return {
    km: Math.round(best.km),
    at: p.t,
    windMph: Math.round(p.windMph),
    category: category(p.windMph),
    side: best.km < 15 ? 'center' : cross < 0 ? 'right' : 'left',
    within150At: within(150),
  };
}

class StormService {
  constructor({ file, refreshMinutes = 30, fetchImpl = fetch, log = console, maxAgeHours = 18 }) {
    this.file = file;
    this.refreshMs = Math.max(refreshMinutes, 5) * 60000;
    this.fetch = fetchImpl;
    this.log = log;
    this.maxAgeMs = maxAgeHours * 3.6e6;
    this.state = { updatedAt: null, error: null, storms: [] };
    this.running = null;
    try {
      if (file && fs.existsSync(file)) this.state = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      log.error('could not read storm cache', e.message);
    }
  }

  save() {
    if (!this.file) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.file);
  }

  async getJson(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = await this.fetch(url, { headers: { 'user-agent': UA, accept: 'application/geo+json, application/json' }, signal: ctrl.signal });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // Latest discussion per bin from api.weather.gov. Bins with no recent discussion are inactive.
  refresh() {
    if (this.running) return this.running;
    this.running = (async () => {
      const found = [];
      for (const bin of BINS) {
        const list = await this.getJson(`https://api.weather.gov/products/types/TCD/locations/${bin}`);
        const latest = list && list['@graph'] && list['@graph'][0];
        if (!latest || Date.now() - Date.parse(latest.issuanceTime) > this.maxAgeMs) continue;
        const product = await this.getJson(`https://api.weather.gov/products/${latest.id}`);
        if (!product || !product.productText) continue;
        try {
          const parsed = parseTCD(product.productText);
          found.push({ id: bin.toLowerCase(), bin, source: 'nhc', issuedAt: Date.parse(latest.issuanceTime), ...parsed });
        } catch (e) {
          this.log.error(`could not parse TCD for ${bin}:`, e.message);
        }
      }
      const manual = this.state.storms.filter((s) => s.source === 'manual');
      this.state = { updatedAt: Date.now(), error: null, storms: [...found, ...manual] };
      this.save();
      return this.state;
    })()
      .catch((e) => {
        this.state = { ...this.state, error: e.name === 'AbortError' ? 'NWS request timed out' : e.message, lastAttempt: Date.now() };
        this.log.error('storm refresh failed:', this.state.error);
        return this.state;
      })
      .finally(() => { this.running = null; });
    return this.running;
  }

  // Admin fallback: paste the NHC discussion text.
  addManual(text) {
    const parsed = parseTCD(text);
    const id = `manual-${parsed.shortName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const storm = { id, bin: null, source: 'manual', issuedAt: Date.now(), ...parsed };
    this.state.storms = [...this.state.storms.filter((s) => s.id !== id), storm];
    this.save();
    return storm;
  }

  remove(id) {
    const before = this.state.storms.length;
    this.state.storms = this.state.storms.filter((s) => s.id !== id);
    if (this.state.storms.length !== before) this.save();
    return this.state.storms.length !== before;
  }

  get(id) {
    return this.state.storms.find((s) => s.id === id) || null;
  }

  // Cameras near the forecast track, ordered by when the center passes closest.
  camerasNear(storm, cameras, maxKm = 300) {
    const track = interpolate(storm.points);
    return cameras
      .map((c) => ({ c, a: approach(track, c) }))
      .filter(({ a }) => a.km <= maxKm)
      .sort((x, y) => x.a.at - y.a.at || x.a.km - y.a.km);
  }

  start() {
    const stale = !this.state.updatedAt || Date.now() - this.state.updatedAt > this.refreshMs;
    if (stale) this.refresh();
    this.timer = setInterval(() => this.refresh(), this.refreshMs);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }
}

module.exports = { StormService, parseTCD, interpolate, approach, category };
