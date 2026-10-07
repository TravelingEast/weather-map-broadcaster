'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { CameraStore, filterCameras, CATEGORIES, KINDS, LIVE_KINDS, STILL_KINDS } = require('./store');
const { SnapshotService, MAX_IMAGE_BYTES } = require('./snapshots');
const { ImpactService, HAZARDS } = require('./impact');
const { importSource, SOURCES, AREAS } = require('./importers');
const { StormService } = require('./storms');
const { relayRoutes } = require('./relay');
const { parseYouTubeRef } = require('./youtube');

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

function createApp({ dataDir, adminToken, retention, maxAgeHours, concurrency, poll = true, log = console, meteomatics = {}, importFetch, storms: stormOpts = {} } = {}) {
  dataDir = dataDir || path.join(ROOT, 'data');
  const camerasFile = path.join(dataDir, 'cameras.json');
  if (!fs.existsSync(camerasFile)) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'seed', 'cameras.json'), camerasFile);
  }

  const store = new CameraStore(camerasFile);
  const snaps = new SnapshotService({ store, dir: path.join(dataDir, 'snapshots'), retention, maxAgeHours, concurrency, log });
  const impacts = new ImpactService({ store, file: path.join(dataDir, 'impact.json'), log, ...meteomatics });
  const storms = new StormService({ file: path.join(dataDir, 'storms.json'), log, ...stormOpts });
  if (poll) {
    snaps.start();
    impacts.start();
    storms.start();
  }

  // Meteomatics peaks at a camera in a window around a time (e.g. closest approach).
  const forecastAround = (c, t, hours = 6) => {
    const r = impacts.forCamera(c);
    if (!r || !r.hours.length) return null;
    const win = r.hours.filter((x) => Math.abs(x.t - t) <= hours * 3.6e6);
    if (!win.length) return null;
    const peak = win.reduce((a, b) => ((b.gust || 0) > (a.gust || 0) ? b : a));
    return {
      peakGust: peak.gust,
      peakGustAt: peak.t,
      precipTotal: Math.round(win.reduce((sum, x) => sum + (x.precip || 0), 0) * 10) / 10,
      windowHours: hours,
    };
  };
  const stormSummary = (st) => {
    const now = Date.now();
    const cur = st.points.reduce((a, b) => (Math.abs(b.t - now) < Math.abs(a.t - now) ? b : a));
    const peak = st.points.reduce((a, b) => (b.windMph > a.windMph ? b : a));
    return { id: st.id, name: st.name, shortName: st.shortName, advisory: st.advisory, issuedAt: st.issuedAt, source: st.source, points: st.points, nearestPoint: cur, peak };
  };

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
    const archived = isStill || Boolean(c.snapshotUrl);
    return {
      ...pub,
      ...(admin && ingestKey ? { ingestKey } : {}),
      live: LIVE_KINDS.includes(c.kind),
      status: s.status,
      lastOk: s.lastOk,
      lastChecked: s.lastChecked,
      error: admin ? s.error : undefined,
      archived,
      liveVideoId: c.kind === 'youtube' ? s.liveVideoId || null : undefined,
      thumbnail: archived && s.lastOk
        ? `/api/cameras/${c.id}/latest?t=${s.lastOk}`
        : c.kind === 'youtube' && (s.liveVideoId || (parseYouTubeRef(c.url) || {}).type === 'video')
          ? `https://i.ytimg.com/vi/${s.liveVideoId || parseYouTubeRef(c.url).value}/hqdefault.jpg`
          : isStill ? null : c.poster || null,
      // Browser-side URL to play. Stills are served through our cache.
      playUrl: isStill ? `/api/cameras/${c.id}/latest` : c.relay ? `/api/cameras/${c.id}/relay/index.m3u8` : c.url,
      impact: impacts.summary(c),
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
    const impact = { 1: 0, 2: 0, 3: 0 };
    for (const c of cams) {
      const s = impacts.summary(c);
      if (s && s.level) impact[s.level] += 1;
    }
    res.json({
      impact: { configured: impacts.configured, updatedAt: impacts.state.updatedAt, counts: impact },
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
    const list = filterCameras(store.all(), { ...req.query, includeLinks: false, statusOf: (c) => snaps.getStatus(c.id).status });
    res.json({ total: list.length, cameras: list.slice(0, limit).map((c) => view(c)) });
  });

  app.get('/api/cameras/:id', (req, res) => {
    const c = store.get(req.params.id);
    // Link-out cams are admin-only: viewers only get cameras that play here.
    if (!c || c.enabled === false || c.kind === 'link') return res.status(404).json({ error: 'not found' });
    const nearby = filterCameras(store.all(), { near: `${c.lat},${c.lon}` })
      .filter((x) => x.id !== c.id)
      .slice(0, 8)
      .map((x) => ({ ...view(x), distanceKm: x.distanceKm }));
    const stormNear = storms.state.storms
      .map((st) => {
        const hit = storms.camerasNear(st, [c], 500)[0];
        return hit ? { id: st.id, name: st.name, approach: hit.a, forecast: forecastAround(c, hit.a.at) } : null;
      })
      .filter(Boolean);
    res.json({ camera: view(c), nearby, storms: stormNear });
  });

  // Cameras ranked by forecast weather impact (Meteomatics).
  app.get('/api/impact', (req, res) => {
    const minLevel = req.query.minLevel != null ? Math.max(Number(req.query.minLevel) || 0, 0) : 1;
    let list = filterCameras(store.all(), { ...req.query, includeLinks: false, statusOf: (c) => snaps.getStatus(c.id).status })
      .map((c) => view(c))
      .filter((c) => (c.impact ? c.impact.level : 0) >= minLevel);
    if (req.query.hazard) list = list.filter((c) => c.impact && c.impact.events.some((e) => e.type === req.query.hazard));
    list.sort((a, b) => (b.impact ? b.impact.score : 0) - (a.impact ? a.impact.score : 0));
    res.json({
      configured: impacts.configured,
      updatedAt: impacts.state.updatedAt,
      horizonHours: impacts.state.horizonHours || impacts.horizonHours,
      model: impacts.state.model || impacts.model,
      error: impacts.state.error || null,
      hazards: Object.fromEntries(Object.entries(HAZARDS).map(([k, v]) => [k, v.label])),
      total: list.length,
      cameras: list,
    });
  });

  app.get('/api/cameras/:id/impact', (req, res) => {
    const c = store.get(req.params.id);
    if (!c || c.enabled === false) return res.status(404).json({ error: 'not found' });
    const r = impacts.forCamera(c);
    res.json({
      configured: impacts.configured,
      updatedAt: impacts.state.updatedAt,
      error: impacts.state.error || null,
      level: r ? r.level : null,
      score: r ? r.score : null,
      events: r ? r.events : [],
      hours: r ? r.hours : [],
    });
  });

  app.get('/api/storms', (req, res) => {
    res.json({ updatedAt: storms.state.updatedAt, error: storms.state.error || null, storms: storms.state.storms.map(stormSummary) });
  });

  // Cameras near a storm's forecast track, in order of closest approach, with Meteomatics peaks.
  app.get('/api/storms/:id/cameras', (req, res) => {
    const st = storms.get(req.params.id);
    if (!st) return res.status(404).json({ error: 'not found' });
    const maxKm = Math.min(Number(req.query.maxKm) || 300, 1500);
    const list = filterCameras(store.all(), { ...req.query, includeLinks: false, statusOf: (c) => snaps.getStatus(c.id).status });
    const near = storms.camerasNear(st, list, maxKm).map(({ c, a }) => ({ ...view(c), approach: a, forecast: forecastAround(c, a.at) }));
    res.json({ storm: stormSummary(st), maxKm, total: near.length, cameras: near });
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

  app.post('/api/admin/storms/refresh', requireAdmin, async (req, res) => {
    const st = await storms.refresh();
    if (st.error) return res.status(502).json({ error: st.error });
    res.json({ updatedAt: st.updatedAt, storms: st.storms.map((x) => x.name) });
  });
  // Fallback when api.weather.gov is unreachable: paste the NHC Forecast Discussion text.
  app.post('/api/admin/storms/manual', requireAdmin, (req, res) => {
    try {
      const st = storms.addManual((req.body || {}).text);
      res.status(201).json({ storm: stormSummary(st) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
  app.delete('/api/admin/storms/:id', requireAdmin, (req, res) => {
    res.status(storms.remove(req.params.id) ? 204 : 404).end();
  });

  app.post('/api/admin/impact/refresh', requireAdmin, async (req, res) => {
    if (!impacts.configured) return res.status(503).json({ error: 'Meteomatics credentials are not configured' });
    const st = await impacts.refresh();
    if (st.error) return res.status(502).json({ error: st.error });
    res.json({ updatedAt: st.updatedAt, locations: Object.keys(st.byLocation).length });
  });

  app.get('/api/admin/import/sources', requireAdmin, (req, res) => {
    res.json({
      sources: Object.entries(SOURCES).map(([id, s]) => ({ id, label: s.label, url: s.url })),
      areas: AREAS,
    });
  });

  // Bulk import DOT cameras inside an area. Safe to re-run: existing cams are updated in place.
  app.post('/api/admin/import', requireAdmin, async (req, res) => {
    const { source, bbox = 'north-gulf', refreshSeconds = 300, tags = [] } = req.body || {};
    try {
      const r = await importSource(store, source, { bbox, refreshSeconds, tags, fetchImpl: importFetch || fetch });
      res.json(r);
    } catch (e) {
      res.status(/unknown source|bbox must/.test(e.message) ? 400 : 502).json({ error: e.message });
    }
  });

  // Curated camera packs in seed/packs/*.json (e.g. a hurricane watchlist). Re-loading updates in place.
  const packDir = path.join(ROOT, 'seed', 'packs');
  const listPacks = () => (fs.existsSync(packDir) ? fs.readdirSync(packDir).filter((f) => f.endsWith('.json')) : [])
    .map((f) => {
      const p = JSON.parse(fs.readFileSync(path.join(packDir, f), 'utf8'));
      return { id: f.replace(/\.json$/, ''), name: p.name, count: (p.cameras || []).length };
    });
  app.get('/api/admin/packs', requireAdmin, (req, res) => res.json({ packs: listPacks() }));
  app.post('/api/admin/packs/:id', requireAdmin, (req, res) => {
    if (!listPacks().some((p) => p.id === req.params.id)) return res.status(404).json({ error: 'unknown pack' });
    const pack = JSON.parse(fs.readFileSync(path.join(packDir, `${req.params.id}.json`), 'utf8'));
    res.json(store.upsertMany(pack.cameras || []));
  });

  relayRoutes(app, { store, log });

  // Static front end and vendored libraries.
  const nm = path.join(ROOT, 'node_modules');
  app.use('/vendor/leaflet', express.static(path.join(nm, 'leaflet', 'dist'), { maxAge: '7d' }));
  app.use('/vendor/markercluster', express.static(path.join(nm, 'leaflet.markercluster', 'dist'), { maxAge: '7d' }));
  app.use('/vendor/hls', express.static(path.join(nm, 'hls.js', 'dist'), { maxAge: '7d' }));
  app.use(express.static(path.join(ROOT, 'public'), { index: false }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

  // SPA routes: /, /map, /cam/:slug, /country/:cc, /category/:cat, /favorites, /admin, /embed/:slug
  app.get('*', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

  return { app, store, snaps, impacts, storms };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const { app } = createApp({
    dataDir: process.env.DATA_DIR,
    adminToken: process.env.ADMIN_TOKEN,
    retention: Number(process.env.SNAPSHOT_RETENTION) || 288,
    maxAgeHours: Number(process.env.SNAPSHOT_MAX_AGE_HOURS) || 72,
    concurrency: Number(process.env.SNAPSHOT_CONCURRENCY) || 12,
    meteomatics: {
      username: process.env.METEOMATICS_USERNAME,
      password: process.env.METEOMATICS_PASSWORD,
      model: process.env.METEOMATICS_MODEL || 'mix',
      horizonHours: Number(process.env.IMPACT_HORIZON_HOURS) || 72,
      refreshMinutes: Number(process.env.IMPACT_REFRESH_MINUTES) || 60,
    },
  });
  app.listen(port, () => {
    console.log(`webcam platform listening on http://localhost:${port}`);
    if (!process.env.ADMIN_TOKEN) console.log('ADMIN_TOKEN not set: admin API is disabled.');
    if (!process.env.METEOMATICS_USERNAME) console.log('METEOMATICS_USERNAME not set: weather impact scan is disabled.');
  });
}

module.exports = { createApp };
