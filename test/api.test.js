'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createApp } = require('../src/server');
const { filterCameras, validateCamera } = require('../src/store');

// Minimal valid JPEG header bytes plus a varying payload.
const jpeg = (n = 0) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]), Buffer.from(`frame-${n}`)]);

async function boot(opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cams-'));
  const silent = { error() {}, log() {} };
  const ctx = createApp({ dataDir, adminToken: 'secret', poll: false, log: silent, ...opts });
  const server = await new Promise((r) => { const s = ctx.app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, { method = 'GET', body, token, headers = {} } = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: {
        ...(body && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body ? (Buffer.isBuffer(body) ? body : JSON.stringify(body)) : undefined,
    });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
  const close = () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); };
  return { ...ctx, call, close, dataDir };
}

test('seed catalog loads and filters work', async () => {
  const t = await boot();
  try {
    const all = await t.call('/api/cameras');
    assert.equal(all.status, 200);
    assert.ok(all.body.total >= 10);
    const live = await t.call('/api/cameras?type=live');
    assert.ok(live.body.cameras.every((c) => c.live));
    const still = await t.call('/api/cameras?type=still');
    assert.ok(still.body.cameras.every((c) => !c.live));
    const q = await t.call('/api/cameras?q=gulf');
    assert.equal(q.body.cameras[0].name, 'GOES-East Gulf');
    const meta = await t.call('/api/meta');
    assert.equal(meta.body.total, all.body.total);
    // Seed push cam gets a per-install key that never appears publicly.
    assert.ok(!JSON.stringify(all.body).includes('ingestKey'));
    const push = t.store.all().find((c) => c.kind === 'push');
    assert.match(push.ingestKey, /^[0-9a-f]{48}$/);
  } finally { t.close(); }
});

test('camera detail returns nearby sorted by distance, and 404s unknown', async () => {
  const t = await boot();
  try {
    const r = await t.call('/api/cameras/goes-east-northeast');
    assert.equal(r.status, 200);
    const d = r.body.nearby.map((n) => n.distanceKm);
    assert.deepEqual(d, [...d].sort((a, b) => a - b));
    assert.equal((await t.call('/api/cameras/nope')).status, 404);
    assert.equal((await t.call('/api/whatever')).status, 404);
  } finally { t.close(); }
});

test('admin endpoints require the token', async () => {
  const t = await boot();
  try {
    assert.equal((await t.call('/api/admin/cameras')).status, 401);
    assert.equal((await t.call('/api/admin/cameras', { token: 'wrong' })).status, 401);
    assert.equal((await t.call('/api/admin/cameras', { token: 'secret' })).status, 200);
  } finally { t.close(); }
  const u = await boot({ adminToken: undefined });
  try {
    assert.equal((await u.call('/api/admin/cameras', { token: 'anything' })).status, 503);
  } finally { u.close(); }
});

test('admin create validates input', async () => {
  const t = await boot();
  try {
    const bad = await t.call('/api/admin/cameras', { method: 'POST', token: 'secret', body: { name: 'x', kind: 'hls', url: 'ftp://x', lat: 100, lon: 0 } });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.errors.length >= 2);
  } finally { t.close(); }
});

test('image camera is polled, archived, deduped, and served', async () => {
  let n = 0;
  let serveSame = false;
  const src = http.createServer((req, res) => {
    if (req.url === '/bad') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>'); }
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    res.end(jpeg(serveSame ? n : ++n));
  });
  await new Promise((r) => src.listen(0, r));
  const srcUrl = `http://127.0.0.1:${src.address().port}`;
  const t = await boot({ retention: 3 });
  try {
    const created = await t.call('/api/admin/cameras', {
      method: 'POST', token: 'secret',
      body: { name: 'Test Cam', kind: 'image', url: `${srcUrl}/cam.jpg`, lat: 40, lon: -75, country: 'us', category: 'city' },
    });
    assert.equal(created.status, 201);
    const cam = t.store.get(created.body.camera.id);
    assert.equal(cam.country, 'US');
    assert.equal(cam.slug, 'test-cam');

    for (let i = 0; i < 5; i++) await t.snaps.check(cam);
    let frames = (await t.call(`/api/cameras/${cam.id}/frames`)).body.frames;
    assert.ok(frames.length <= 3, 'retention prunes old frames');
    assert.ok(frames.length >= 1);

    serveSame = true;
    const before = frames.length;
    await t.snaps.check(cam);
    await t.snaps.check(cam);
    frames = (await t.call(`/api/cameras/${cam.id}/frames`)).body.frames;
    assert.equal(frames.length, before, 'identical frames are not stored twice');

    const latest = await t.call(`/api/cameras/${cam.id}/latest`);
    assert.equal(latest.status, 200);
    assert.equal(latest.headers.get('content-type'), 'image/jpeg');
    assert.equal(latest.body[0], 0xff);

    const one = await t.call(frames[0].url);
    assert.equal(one.status, 200);

    const detail = await t.call(`/api/cameras/${cam.slug}`);
    assert.equal(detail.body.camera.status, 'online');
    assert.match(detail.body.camera.thumbnail, /\/latest\?t=\d+/);

    // Non-image responses mark the camera offline.
    const badRes = await t.call(`/api/admin/cameras/${cam.id}`, { method: 'PUT', token: 'secret', body: { url: `${srcUrl}/bad` } });
    assert.equal(badRes.status, 200);
    await t.snaps.check(t.store.get(cam.id));
    const st = t.snaps.getStatus(cam.id);
    assert.equal(st.status, 'offline');
    assert.match(st.error, /not a recognized image/);

    assert.equal((await t.call(`/api/admin/cameras/${cam.id}`, { method: 'DELETE', token: 'secret' })).status, 204);
    assert.ok(!fs.existsSync(path.join(t.dataDir, 'snapshots', cam.id)));
  } finally {
    t.close();
    src.close();
  }
});

test('push ingest accepts images with the camera key only', async () => {
  const t = await boot();
  try {
    const created = await t.call('/api/admin/cameras', {
      method: 'POST', token: 'secret',
      body: { name: 'Pi Cam', kind: 'push', lat: 35, lon: -80 },
    });
    const { id, ingestKey } = created.body.camera;
    assert.ok(ingestKey);
    const pub = await t.call(`/api/cameras/${id}`);
    assert.equal(pub.body.camera.ingestKey, undefined);

    const post = (body, token, type = 'image/jpeg') => t.call(`/api/ingest/${id}`, { method: 'POST', body, token, headers: { 'content-type': type } });
    assert.equal((await post(jpeg(1), 'nope')).status, 401);
    assert.equal((await post(Buffer.from('hello world, not an image'), ingestKey)).status, 415);
    const ok = await post(jpeg(1), ingestKey);
    assert.equal(ok.status, 201);
    assert.equal(ok.body.unchanged, false);
    assert.equal((await post(jpeg(1), ingestKey)).body.unchanged, true);
    assert.equal((await post(jpeg(2), 'secret')).status, 201, 'admin token also works');
    assert.equal((await t.call(`/api/cameras/${id}/frames`)).body.frames.length, 2);
  } finally { t.close(); }
});

test('SPA fallback serves index.html', async () => {
  const t = await boot();
  try {
    const r = await t.call('/cam/anything');
    assert.equal(r.status, 200);
    assert.match(r.body.toString(), /<main id="app"/);
    assert.equal((await t.call('/vendor/hls/hls.min.js')).status, 200);
    assert.equal((await t.call('/vendor/leaflet/leaflet.js')).status, 200);
  } finally { t.close(); }
});

test('filterCameras: bbox across the antimeridian and near sort', () => {
  const cams = [
    { id: 'a', name: 'A', lat: 20, lon: 179, category: 'x', enabled: true },
    { id: 'b', name: 'B', lat: 20, lon: -179, category: 'x', enabled: true },
    { id: 'c', name: 'C', lat: 20, lon: 0, category: 'x', enabled: true },
    { id: 'd', name: 'D', lat: 20, lon: 0, category: 'x', enabled: false },
  ];
  assert.deepEqual(filterCameras(cams, { bbox: '170,0,-170,40' }).map((c) => c.id).sort(), ['a', 'b']);
  assert.deepEqual(filterCameras(cams, { near: '20,1' }).map((c) => c.id), ['c', 'a', 'b']);
  assert.equal(validateCamera({ name: 'y', kind: 'youtube', url: 'UCabc', lat: 0, lon: 0 }).camera.refreshSeconds, 300);
});
