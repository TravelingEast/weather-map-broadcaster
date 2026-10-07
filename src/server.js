'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { CameraStore, filterCameras, CATEGORIES, KINDS, LIVE_KINDS, STILL_KINDS } = require('./store');
const { SnapshotService, MAX_IMAGE_BYTES } = require('./snapshots');

const ROOT = path.join(__dirname, '..');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function bearer(req) {
  const h = req.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : req.query.token || '';
}

function createApp({ dataDir, adminToken, retention, maxAgeHours, poll = true, log = console } = {}) {
  dataDir = dataDir || path.join(ROOT, 'data');
  const camerasFile = path.join(dataDir, 'cameras.json');
  if (!fs.existsSync(camerasFile)) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'seed', 'cameras.json'), camerasFile);
  }

  const store = new CameraStore(camerasFile);
  const snaps = new SnapshotService({ store, dir: path.join(dataDir, 'snapshots'), retention, maxAgeHours, log });
  if (poll) snaps.start();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  const requireAdmin = (req, res, next) => {
    if (!adminToken) return res.status(503).json({ error: 'ADMIN_TOKEN is not configured on the server' });
    if (!safeEqual(bearer(req), adminToken)) return res.status(401).json({ error: 'unauthorized' });
    next();
  };

  // Public view of a camera: never leak the ingest key.
  const view = (c, { admin = false } = {}) => {
    const s = snaps.getStatus(c.id);
    const { ingestKey, ...pub } = c;
    const isStill = STILL_KINDS.includes(c.kind);
    return {
      ...pub,
      ...(admin && ingestKey ? { ingestKey } : {}),
      live: LIVE_KINDS.includes(c.kind),
      status: s.status,
      lastOk: s.lastOk,
      lastChecked: s.lastChecked,
      error: admin ? s.error : undefined,
      thumbnail: isStill
        ? (s.lastOk ? `/api/cameras/${c.id}/latest?t=${s.lastOk}` : null)
        : c.poster || null,
      // Browser-side URL to play. Stills are served through our cache.
      playUrl: isStill ? `/api/cameras/${c.id}/latest` : c.url,
    };
  };

  app.get('/api/health', (req, res) => {
    const all = store.all();
    const counts = {};
    for (const c of all) {
      const st = snaps.getStatus(c.id).status;
      counts[st] = (counts[st] || 0) + 1;
    }
    res.json({ ok: true, cameras: all.length, status: counts, uptime: process.uptime() });
  });

  app.get('/api/meta', (req, res) => {
    const cams = filterCameras(store.all());
    const countries = {};
    const categories = {};
    for (const c of cams) {
      if (c.country) countries[c.country] = (countries[c.country] || 0) + 1;
      categories[c.category] = (categories[c.category] || 0) + 1;
    }
    res.json({
      total: cams.length,
      live: cams.filter((c) => LIVE_KINDS.includes(c.kind)).length,
      still: cams.filter((c) => STILL_KINDS.includes(c.kind)).length,
      countries,
      categories,
      allCategories: CATEGORIES,
      kinds: KINDS,
    });
  });

  app.get('/api/cameras', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 500, 2000);
    const list = filterCameras(store.all(), req.query);
    res.json({ total: list.length, cameras: list.slice(0, limit).map((c) => view(c)) });
  });

  app.get('/api/cameras/:id', (req, res) => {
    const c = store.get(req.params.id);
    if (!c || c.enabled === false) return res.status(404).json({ error: 'not found' });
    const nearby = filterCameras(store.all(), { near: `${c.lat},${c.lon}` })
      .filter((x) => x.id !== c.id)
      .slice(0, 8)
      .map((x) => ({ ...view(x), distanceKm: x.distanceKm }));
    res.json({ camera: view(c), nearby });
  });

  app.get('/api/cameras/:id/latest', (req, res) => {
    const c = store.get(req.params.id);
    if (!c) return res.status(404).end();
    const f = snaps.latestFrame(c.id);
    if (!f) return res.status(404).json({ error: 'no frame yet' });
    res.set('cache-control', 'no-cache');
    res.set('x-frame-time', new Date(f.ts).toISOString());
    res.type(f.type).sendFile(f.path);
  });

  app.get('/api/cameras/:id/frames', (req, res) => {
    const c = store.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    const frames = snaps.listFrames(c.id).map((f) => ({ ts: f.ts, url: `/api/cameras/${c.id}/frames/${f.ts}` }));
    res.json({ frames });
  });

  app.get('/api/cameras/:id/frames/:ts', (req, res) => {
    const c = store.get(req.params.id);
    if (!c) return res.status(404).end();
    const f = snaps.framePath(c.id, req.params.ts);
    if (!f) return res.status(404).end();
    res.set('cache-control', 'public, max-age=31536000, immutable');
    res.type(f.type).sendFile(f.path);
  });

  // Push ingest: a camera (Pi, IP cam FTP bridge, script) POSTs raw image bytes.
  //   curl -X POST -H "Authorization: Bearer <ingestKey>" -H "Content-Type: image/jpeg" \
  //        --data-binary @frame.jpg https://host/api/ingest/<cameraId>
  app.post(
    '/api/ingest/:id',
    express.raw({ type: ['image/*', 'application/octet-stream'], limit: MAX_IMAGE_BYTES }),
    (req, res) => {
      const c = store.get(req.params.id);
      if (!c) return res.status(404).json({ error: 'not found' });
      const key = bearer(req);
      const ok = (c.ingestKey && safeEqual(key, c.ingestKey)) || (adminToken && safeEqual(key, adminToken));
      if (!ok) return res.status(401).json({ error: 'unauthorized' });
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'empty body' });
      try {
        const s = snaps.saveFrame(c.id, req.body, req.get('content-type'));
        res.status(201).json({ ok: true, ts: s.lastOk, unchanged: Boolean(s.unchanged) });
      } catch (e) {
        res.status(415).json({ error: e.message });
      }
    },
  );

  // Admin
  app.get('/api/admin/cameras', requireAdmin, (req, res) => {
    res.json({ cameras: store.all().map((c) => view(c, { admin: true })) });
  });

  app.post('/api/admin/cameras', requireAdmin, async (req, res) => {
    const { camera, errors } = store.create(req.body || {});
    if (errors) return res.status(400).json({ errors });
    snaps.check(camera).catch(() => {});
    res.status(201).json({ camera: view(camera, { admin: true }) });
  });

  app.put('/api/admin/cameras/:id', requireAdmin, (req, res) => {
    const r = store.update(req.params.id, req.body || {});
    if (r.notFound) return res.status(404).json({ error: 'not found' });
    if (r.errors) return res.status(400).json({ errors: r.errors });
    snaps.status.delete(r.camera.id); // force a fresh check with the new settings
    snaps.check(r.camera).catch(() => {});
    res.json({ camera: view(r.camera, { admin: true }) });
  });

  app.delete('/api/admin/cameras/:id', requireAdmin, (req, res) => {
    const c = store.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    store.remove(c.id);
    snaps.removeCamera(c.id);
    res.status(204).end();
  });

  app.post('/api/admin/cameras/:id/check', requireAdmin, async (req, res) => {
    const c = store.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    await snaps.check(c);
    res.json({ camera: view(c, { admin: true }) });
  });

  // Static front end and vendored libraries.
  const nm = path.join(ROOT, 'node_modules');
  app.use('/vendor/leaflet', express.static(path.join(nm, 'leaflet', 'dist'), { maxAge: '7d' }));
  app.use('/vendor/markercluster', express.static(path.join(nm, 'leaflet.markercluster', 'dist'), { maxAge: '7d' }));
  app.use('/vendor/hls', express.static(path.join(nm, 'hls.js', 'dist'), { maxAge: '7d' }));
  app.use(express.static(path.join(ROOT, 'public'), { index: false }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

  // SPA routes: /, /map, /cam/:slug, /country/:cc, /category/:cat, /favorites, /admin, /embed/:slug
  app.get('*', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

  return { app, store, snaps };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const { app } = createApp({
    dataDir: process.env.DATA_DIR,
    adminToken: process.env.ADMIN_TOKEN,
    retention: Number(process.env.SNAPSHOT_RETENTION) || 288,
    maxAgeHours: Number(process.env.SNAPSHOT_MAX_AGE_HOURS) || 72,
  });
  app.listen(port, () => {
    console.log(`webcam platform listening on http://localhost:${port}`);
    if (!process.env.ADMIN_TOKEN) console.log('ADMIN_TOKEN not set: admin API is disabled.');
  });
}

module.exports = { createApp };
