'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/server');
const { parseTCD, interpolate, approach } = require('../src/storms');
const { parseAlgo, parseIteris, parseBbox } = require('../src/importers');

const TCD = fs.readFileSync(path.join(__dirname, 'fixtures', 'tcd-isaias.txt'), 'utf8');

test('parseTCD reads header and forecast table, skips dissipated rows', () => {
  const s = parseTCD(TCD);
  assert.equal(s.name, 'Tropical Storm Isaias');
  assert.equal(s.shortName, 'Isaias');
  assert.equal(s.advisory, 5);
  assert.equal(s.points.length, 8);
  assert.deepEqual(s.points[0], { tau: 0, t: Date.UTC(2026, 9, 7, 15), lat: 22.6, lon: -93.8, windKt: 50, windMph: 60, note: '' });
  assert.equal(s.points[5].windMph, 110);
  assert.equal(s.points[6].note, 'INLAND');
  assert.throws(() => parseTCD('nothing here'), /issuance/);
});

test('parseTCD rolls forecast days into the next month', () => {
  const t = 'Hurricane Test Discussion Number 9\n1000 PM AST Fri Oct 30 2026\n\nINIT  31/0300Z 20.0N  60.0W   80 KT  90 MPH\n 48H  02/0000Z 25.0N  65.0W   90 KT 105 MPH\n';
  const s = parseTCD(t);
  assert.equal(new Date(s.points[1].t).toISOString(), '2026-11-02T00:00:00.000Z');
});

test('approach: distance, timing, and right/left of motion', () => {
  const track = interpolate(parseTCD(TCD).points);
  assert.ok(track.length > 90, 'hourly interpolation');
  // Mobile, AL sits east of a northward track near 88.5W: right side.
  const mobile = approach(track, { lat: 30.6954, lon: -88.0399 });
  assert.equal(mobile.side, 'right');
  assert.ok(mobile.km < 60, `Mobile ${mobile.km} km`);
  // Closest approach is just after landfall, so interpolated wind is already decaying.
  assert.ok(mobile.windMph >= 74 && mobile.windMph <= 110, `Mobile wind ${mobile.windMph}`);
  // New Orleans is west of the track: left side, farther out.
  const nola = approach(track, { lat: 29.9585, lon: -90.065 });
  assert.equal(nola.side, 'left');
  assert.ok(nola.km > 100 && nola.km < 200, `NOLA ${nola.km} km`);
  assert.ok(nola.within150At, 'enters the 150 km band');
});

test('importer parsers map ALGO and Iteris feeds', () => {
  const algo = parseAlgo([{
    id: 42,
    location: { latitude: 30.69, longitude: -88.04, displayRouteDesignator: 'I-10', displayCrossStreet: 'Water St', direction: 'EB', city: 'Mobile', county: 'Mobile' },
    playbackUrls: { hls: 'https://example.test/live/42.m3u8' },
    snapshotImageUrl: 'https://example.test/42.jpg',
  }]);
  assert.equal(algo[0].sourceKey, 'algo:42');
  assert.equal(algo[0].name, 'I-10 EB @ Water St');
  assert.equal(algo[0].kind, 'hls');
  assert.equal(algo[0].snapshotUrl, 'https://example.test/42.jpg');

  const fl = parseIteris('https://fl511.com', 'Florida', 'fl511')({ item2: [{ itemId: '9--1', location: [30.41, -87.21], title: 'I-110 at Fairfield' }] });
  assert.equal(fl[0].url, 'https://fl511.com/map/Cctv/9--1');
  assert.equal(fl[0].lat, 30.41);
  assert.deepEqual(parseBbox('mobile-bay'), [-88.5, 30.1, -87.4, 31.0]);
  assert.deepEqual(parseBbox('-90,29,-88,31'), [-90, 29, -88, 31]);
  assert.throws(() => parseBbox('nowhere'), /bbox/);
});

async function boot(opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storm-'));
  const ctx = createApp({ dataDir, adminToken: 'secret', poll: false, log: { error() {}, log() {} }, ...opts });
  const server = await new Promise((r) => { const s = ctx.app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, { method = 'GET', body } = {}) => {
    const res = await fetch(base + p, { method, headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  };
  return { ...ctx, call, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

test('import endpoint upserts by sourceKey and respects the area', async () => {
  let feed = [
    { id: 1, location: { latitude: 30.69, longitude: -88.04, displayRouteDesignator: 'I-10', displayCrossStreet: 'Water St' }, playbackUrls: { hls: 'https://example.test/1.m3u8' } },
    { id: 2, location: { latitude: 33.52, longitude: -86.80, displayRouteDesignator: 'I-65', displayCrossStreet: 'Birmingham' }, playbackUrls: { hls: 'https://example.test/2.m3u8' } },
  ];
  const importFetch = async () => ({ ok: true, status: 200, json: async () => feed });
  const t = await boot({ importFetch });
  try {
    const r1 = await t.call('/api/admin/import', { method: 'POST', body: { source: 'algo', bbox: 'north-gulf' } });
    assert.equal(r1.status, 200);
    assert.deepEqual([r1.body.fetched, r1.body.matched, r1.body.created, r1.body.updated], [2, 1, 1, 0]);
    const cam = t.store.all().find((c) => c.sourceKey === 'algo:1');
    assert.equal(cam.category, 'traffic');
    assert.equal(cam.snapshotUrl, 'https://api.algotraffic.com/v4/Cameras/1/snapshot.jpg');

    // Re-import keeps id/slug and admin choices.
    await t.call(`/api/admin/cameras/${cam.id}`, { method: 'PUT', body: { featured: true } });
    feed = [{ ...feed[0], location: { ...feed[0].location, displayCrossStreet: 'Royal St' } }];
    const r2 = await t.call('/api/admin/import', { method: 'POST', body: { source: 'algo', bbox: 'north-gulf' } });
    assert.deepEqual([r2.body.created, r2.body.updated], [0, 1]);
    const again = t.store.get(cam.id);
    assert.equal(again.name, 'I-10 @ Royal St');
    assert.equal(again.slug, cam.slug);
    assert.equal(again.featured, true);

    const pub = await t.call(`/api/cameras/${cam.id}`);
    assert.equal(pub.body.camera.archived, true, 'live cam with snapshot feed is archived');

    assert.equal((await t.call('/api/admin/import', { method: 'POST', body: { source: 'nope' } })).status, 400);
  } finally { t.close(); }
});

test('Isaias pack loads link cams, idempotently', async () => {
  const t = await boot();
  try {
    const packs = await t.call('/api/admin/packs');
    const pack = packs.body.packs.find((p) => p.id === 'isaias-north-gulf');
    assert.ok(pack && pack.count >= 10);
    const r1 = await t.call('/api/admin/packs/isaias-north-gulf', { method: 'POST' });
    assert.equal(r1.body.created, pack.count);
    assert.deepEqual(r1.body.errors, []);
    const r2 = await t.call('/api/admin/packs/isaias-north-gulf', { method: 'POST' });
    assert.deepEqual([r2.body.created, r2.body.updated], [0, pack.count]);
    const bourbon = t.store.all().find((c) => c.sourceKey === 'pack:earthcam-bourbon');
    const pub = await t.call(`/api/cameras/${bourbon.slug}`);
    assert.equal(pub.body.camera.kind, 'link');
    assert.equal(pub.body.camera.live, true);
  } finally { t.close(); }
});

test('storm endpoints: refresh from NWS, rank cameras, manual fallback', async () => {
  const issuance = new Date(Date.now() - 2 * 3.6e6).toISOString();
  const stormFetch = async (url) => {
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    if (url.endsWith('/types/TCD/locations/AT4')) return ok({ '@graph': [{ id: 'abc-123', issuanceTime: issuance }] });
    if (url.endsWith('/products/abc-123')) return ok({ productText: TCD });
    if (/locations\/(AT|EP)\d$/.test(url)) return ok({ '@graph': [{ id: 'old', issuanceTime: '2026-08-01T00:00:00Z' }] });
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const t = await boot({ storms: { fetchImpl: stormFetch } });
  try {
    await t.call('/api/admin/packs/isaias-north-gulf', { method: 'POST' });
    const r = await t.call('/api/admin/storms/refresh', { method: 'POST' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.storms, ['Tropical Storm Isaias'], 'old discussions are ignored');

    const list = await t.call('/api/storms');
    assert.equal(list.body.storms[0].id, 'at4');
    assert.equal(list.body.storms[0].peak.windMph, 110);

    const near = await t.call('/api/storms/at4/cameras?maxKm=300');
    assert.ok(near.body.total >= 10);
    const times = near.body.cameras.map((c) => c.approach.at);
    assert.deepEqual(times, [...times].sort((a, b) => a - b), 'ordered by closest approach');
    assert.ok(near.body.cameras.every((c) => c.approach.km <= 300));
    const beachOnly = await t.call('/api/storms/at4/cameras?maxKm=300&category=beach');
    assert.ok(beachOnly.body.cameras.every((c) => c.category === 'beach'));

    const cam = near.body.cameras[0];
    const detail = await t.call(`/api/cameras/${cam.slug}`);
    assert.equal(detail.body.storms[0].name, 'Tropical Storm Isaias');

    // Manual paste works without the feed, and can be removed.
    const manual = await t.call('/api/admin/storms/manual', { method: 'POST', body: { text: TCD } });
    assert.equal(manual.status, 201);
    assert.equal(manual.body.storm.id, 'manual-isaias');
    assert.equal((await t.call('/api/admin/storms/manual', { method: 'POST', body: { text: 'junk' } })).status, 400);
    assert.equal((await t.call('/api/admin/storms/manual-isaias', { method: 'DELETE' })).status, 204);
    assert.equal((await t.call('/api/storms')).body.storms.length, 1);
  } finally { t.close(); }
});
