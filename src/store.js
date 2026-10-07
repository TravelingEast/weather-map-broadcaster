'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Camera kinds. "still" kinds are polled and archived by the server;
// "live" kinds are played directly in the browser.
const STILL_KINDS = ['image', 'push'];
const LIVE_KINDS = ['hls', 'youtube', 'iframe', 'mjpeg'];
const KINDS = [...STILL_KINDS, ...LIVE_KINDS];

const CATEGORIES = [
  'city', 'beach', 'mountain', 'weather', 'traffic', 'harbor',
  'nature', 'wildlife', 'landmark', 'ski', 'airport', 'satellite', 'other',
];

function slugify(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'camera';
}

function isHttpUrl(u) {
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch {
    return false;
  }
}

// Validate and normalize camera input. Returns { camera } or { errors }.
function validateCamera(input, existing = null) {
  const c = { ...(existing || {}), ...input };
  const errors = [];

  if (!c.name || typeof c.name !== 'string') errors.push('name is required');
  if (!KINDS.includes(c.kind)) errors.push(`kind must be one of: ${KINDS.join(', ')}`);

  c.lat = Number(c.lat);
  c.lon = Number(c.lon);
  if (!Number.isFinite(c.lat) || c.lat < -90 || c.lat > 90) errors.push('lat must be between -90 and 90');
  if (!Number.isFinite(c.lon) || c.lon < -180 || c.lon > 180) errors.push('lon must be between -180 and 180');

  if (c.kind === 'push') {
    c.url = null;
  } else if (c.kind === 'youtube') {
    if (!c.url || typeof c.url !== 'string') errors.push('url is required (YouTube video ID, channel ID, or URL)');
  } else if (!isHttpUrl(c.url)) {
    errors.push('url must be an http(s) URL');
  }

  if (c.poster && !isHttpUrl(c.poster)) errors.push('poster must be an http(s) URL');

  c.category = CATEGORIES.includes(c.category) ? c.category : 'other';
  c.country = String(c.country || '').toUpperCase().slice(0, 2);
  if (c.country && !/^[A-Z]{2}$/.test(c.country)) errors.push('country must be an ISO 3166-1 alpha-2 code');
  c.city = String(c.city || '').slice(0, 120);
  c.region = String(c.region || '').slice(0, 120);
  c.description = String(c.description || '').slice(0, 2000);
  c.source = String(c.source || '').slice(0, 200);
  c.sourceUrl = c.sourceUrl && isHttpUrl(c.sourceUrl) ? c.sourceUrl : '';
  c.tags = Array.isArray(c.tags) ? c.tags.map(String).slice(0, 20) : [];
  c.featured = Boolean(c.featured);
  c.enabled = c.enabled !== false;
  c.timezone = String(c.timezone || '');

  // Stills: refresh between 30 s and 24 h. Default 5 min.
  const refresh = Number(c.refreshSeconds);
  c.refreshSeconds = Number.isFinite(refresh) ? Math.min(Math.max(refresh, 30), 86400) : 300;

  if (errors.length) return { errors };
  return { camera: c };
}

class CameraStore {
  constructor(file) {
    this.file = file;
    this.cameras = new Map();
    this.load();
  }

  load() {
    if (!fs.existsSync(this.file)) return;
    const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    let changed = false;
    for (const c of raw.cameras || []) {
      // Seeded push cams ship without a key; mint one per install.
      if (c.kind === 'push' && !c.ingestKey) {
        c.ingestKey = crypto.randomBytes(24).toString('hex');
        changed = true;
      }
      this.cameras.set(c.id, c);
    }
    if (changed) this.save();
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const data = { cameras: [...this.cameras.values()] };
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  all() {
    return [...this.cameras.values()];
  }

  get(idOrSlug) {
    if (this.cameras.has(idOrSlug)) return this.cameras.get(idOrSlug);
    for (const c of this.cameras.values()) if (c.slug === idOrSlug) return c;
    return null;
  }

  uniqueSlug(base, ignoreId) {
    let slug = slugify(base);
    let n = 2;
    const taken = (s) => this.all().some((c) => c.slug === s && c.id !== ignoreId);
    while (taken(slug)) slug = `${slugify(base)}-${n++}`;
    return slug;
  }

  create(input) {
    const { camera, errors } = validateCamera(input);
    if (errors) return { errors };
    camera.id = crypto.randomUUID();
    camera.slug = this.uniqueSlug(input.slug || `${camera.name} ${camera.city}`.trim(), camera.id);
    camera.ingestKey = camera.kind === 'push' ? crypto.randomBytes(24).toString('hex') : undefined;
    camera.createdAt = new Date().toISOString();
    camera.updatedAt = camera.createdAt;
    this.cameras.set(camera.id, camera);
    this.save();
    return { camera };
  }

  update(id, input) {
    const existing = this.cameras.get(id);
    if (!existing) return { notFound: true };
    const { id: _i, slug, ingestKey: _k, createdAt: _c, ...rest } = input;
    const { camera, errors } = validateCamera(rest, existing);
    if (errors) return { errors };
    if (slug && slug !== existing.slug) camera.slug = this.uniqueSlug(slug, id);
    if (camera.kind === 'push' && !camera.ingestKey) camera.ingestKey = crypto.randomBytes(24).toString('hex');
    camera.updatedAt = new Date().toISOString();
    this.cameras.set(id, camera);
    this.save();
    return { camera };
  }

  remove(id) {
    const ok = this.cameras.delete(id);
    if (ok) this.save();
    return ok;
  }
}

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Filter cameras by query params: q, country, category, type (live|still), kind, bbox, featured.
function filterCameras(cameras, params = {}) {
  let list = cameras.filter((c) => c.enabled !== false);
  const q = String(params.q || '').trim().toLowerCase();
  if (q) {
    const terms = q.split(/\s+/);
    list = list.filter((c) => {
      const hay = [c.name, c.city, c.region, c.country, c.category, c.description, ...(c.tags || [])]
        .join(' ')
        .toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }
  if (params.country) list = list.filter((c) => c.country === String(params.country).toUpperCase());
  if (params.category) list = list.filter((c) => c.category === params.category);
  if (params.kind) list = list.filter((c) => c.kind === params.kind);
  if (params.type === 'live') list = list.filter((c) => LIVE_KINDS.includes(c.kind));
  if (params.type === 'still') list = list.filter((c) => STILL_KINDS.includes(c.kind));
  if (params.featured === 'true' || params.featured === true) list = list.filter((c) => c.featured);
  if (params.bbox) {
    const [w, s, e, n] = String(params.bbox).split(',').map(Number);
    if ([w, s, e, n].every(Number.isFinite)) {
      list = list.filter((c) => c.lat >= s && c.lat <= n && (w <= e ? c.lon >= w && c.lon <= e : c.lon >= w || c.lon <= e));
    }
  }
  if (params.near) {
    const [lat, lon] = String(params.near).split(',').map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      list = list
        .map((c) => ({ c, d: haversineKm({ lat, lon }, c) }))
        .sort((x, y) => x.d - y.d)
        .map(({ c, d }) => ({ ...c, distanceKm: Math.round(d) }));
    }
  } else {
    list = [...list].sort((a, b) => Number(b.featured) - Number(a.featured) || a.name.localeCompare(b.name));
  }
  return list;
}

module.exports = {
  CameraStore,
  validateCamera,
  filterCameras,
  haversineKm,
  slugify,
  KINDS,
  STILL_KINDS,
  LIVE_KINDS,
  CATEGORIES,
};
