'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/server');
const { assess, parseResponse, PARAMS } = require('../src/impact');

const H = 3.6e6;
const base = Date.parse('2026-10-07T12:00:00Z');
const calm = (i, over = {}) => ({ t: base + i * H, temp: 15, feels: 15, wind: 3, gust: 5, precip: 0, snow: 0, ptype: 0, hail: 0, tstorm: 1, cape: 0, vis: 30000, fog: 0, symbol: 1, ...over });

test('assess: calm weather has no events', () => {
  const r = assess(Array.from({ length: 48 }, (_, i) => calm(i)), base);
  assert.equal(r.level, 0);
  assert.equal(r.score, 0);
  assert.deepEqual(r.events, []);
});

test('assess: wind, ice, fog, heat, storms classify by level with peaks', () => {
  const hours = Array.from({ length: 48 }, (_, i) => calm(i));
  hours[3] = calm(3, { gust: 16 });
  hours[4] = calm(4, { gust: 22 }); // 49 mph -> moderate
  hours[10] = calm(10, { ptype: 5, precip: 0.4 }); // freezing rain -> moderate ice
  hours[11] = calm(11, { ptype: 5, precip: 1.2 }); // -> severe
  hours[20] = calm(20, { vis: 800 });
  hours[21] = calm(21, { vis: 300 });
  hours[30] = calm(30, { feels: 40 });
  hours[40] = calm(40, { tstorm: 55, cape: 3000, precip: 2 }); // high CAPE bumps to severe
  hours[44] = calm(44, { tstorm: 95, cape: 0, precip: 0 }); // dry and stable: ignored
  const r = assess(hours, base);
  const by = Object.fromEntries(r.events.map((e) => [e.type, e]));
  assert.equal(by.wind.level, 2);
  assert.equal(by.wind.peak, 22);
  assert.equal(by.wind.peakAt, base + 4 * H);
  assert.equal(by.wind.hours, 2);
  assert.deepEqual(by.wind.at, [[base + 3 * H, 1], [base + 4 * H, 2]]);
  assert.equal(by.ice.level, 3);
  assert.equal(by.ice.total, 1.6);
  assert.equal(by.fog.level, 2);
  assert.equal(by.fog.peak, 300, 'fog peak is the lowest visibility');
  assert.equal(by.heat.level, 2);
  assert.equal(by.storm.level, 3);
  assert.equal(by.storm.hours, 1, 'dry high-probability hour does not count');
  assert.equal(r.level, 3);
  assert.equal(r.events[0].level, 3, 'most severe first');
  assert.ok(!by.rain, 'freezing rain does not double count as heavy rain below threshold');
});

test('assess: sooner events score higher', () => {
  const soon = Array.from({ length: 48 }, (_, i) => calm(i, i === 2 ? { gust: 21 } : {}));
  const later = Array.from({ length: 48 }, (_, i) => calm(i, i === 40 ? { gust: 21 } : {}));
  assert.ok(assess(soon, base).score > assess(later, base).score);
});

test('parseResponse: real Meteomatics multi-point shape, matched by index', () => {
  // Trimmed from a live response (2026-10-07).
  const json = {
    version: '3.0', status: 'OK',
    data: [
      { parameter: 't_2m:C', coordinates: [
        { lat: 25, lon: -90, dates: [{ date: '2026-10-07T12:00:00Z', value: 28.2 }, { date: '2026-10-07T13:00:00Z', value: 28.3 }] },
        { lat: 40.7128, lon: -74.006, dates: [{ date: '2026-10-07T12:00:00Z', value: 6.6 }, { date: '2026-10-07T13:00:00Z', value: 10.0 }] }] },
      { parameter: 'cape:Jkg', coordinates: [
        { lat: 25, lon: -90, dates: [{ date: '2026-10-07T12:00:00Z', value: 1502.546 }, { date: '2026-10-07T13:00:00Z', value: 1555.246 }] },
        { lat: 40.7128, lon: -74.006, dates: [{ date: '2026-10-07T12:00:00Z', value: -999 }, { date: '2026-10-07T13:00:00Z', value: 0 }] }] },
    ],
  };
  const [gulf, nyc] = parseResponse(json, 2);
  assert.equal(gulf.length, 2);
  assert.equal(gulf[0].temp, 28.2);
  assert.equal(gulf[1].cape, 1555.246);
  assert.equal(nyc[1].temp, 10);
  assert.equal(nyc[0].cape, null, '-999 means missing');
  assert.throws(() => parseResponse({ status: 'ERROR', message: 'Parameter lfi:idx not available in model mix' }, 1), /lfi/);
});

// Fake Meteomatics: windy wherever lat > 40, calm elsewhere.
function fakeMeteomatics(calls) {
  return async (url, opts) => {
    calls.push({ url, auth: opts.headers.authorization });
    const m = /api\.meteomatics\.com\/([^/]+)--([^/]+):PT1H\/([^/]+)\/([^/]+)\/json/.exec(url);
    const [, start, end, params, coords] = m;
    const pts = coords.split('+').map((p) => p.split(',').map(Number));
    const times = [];
    for (let t = Date.parse(start); t <= Date.parse(end); t += H) times.push(new Date(t).toISOString().replace('.000Z', 'Z'));
    const data = params.split(',').map((parameter) => ({
      parameter,
      coordinates: pts.map(([lat, lon]) => ({
        lat, lon,
        dates: times.map((date, i) => ({
          date,
          value: parameter === PARAMS.gust ? (lat > 40 && i === 3 ? 24 : 5) : parameter === PARAMS.vis ? 30000 : parameter === PARAMS.feels ? 15 : 0,
        })),
      })),
    }));
    return { ok: true, status: 200, text: async () => JSON.stringify({ version: '3.0', status: 'OK', data }) };
  };
}

async function boot(meteomatics) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-'));
  const log = { error() {}, log() {} };
  const ctx = createApp({ dataDir, adminToken: 'secret', poll: false, log, meteomatics });
  const server = await new Promise((r) => { const s = ctx.app.listen(0, () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const get = async (p, opts = {}) => {
    const res = await fetch(url + p, opts);
    return { status: res.status, body: await res.json() };
  };
  return { ...ctx, get, dataDir, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

test('impact service batches unique locations and ranks cameras', async () => {
  const calls = [];
  const t = await boot({ username: 'u', password: 'p', chunkSize: 4, horizonHours: 24, fetchImpl: fakeMeteomatics(calls) });
  try {
    const st = await t.impacts.refresh();
    assert.equal(st.error, null);
    const unique = new Set(t.store.all().map((c) => `${c.lat.toFixed(3)},${c.lon.toFixed(3)}`)).size;
    assert.equal(Object.keys(st.byLocation).length, unique);
    assert.equal(calls.length, Math.ceil(unique / 4), 'chunked requests');
    assert.equal(calls[0].auth, `Basic ${Buffer.from('u:p').toString('base64')}`);
    assert.match(calls[0].url, /\?model=mix$/);
    assert.ok(calls[0].url.includes(Object.values(PARAMS).join(',')));
    assert.ok(fs.existsSync(path.join(t.dataDir, 'impact.json')), 'cache persisted');

    const r = await t.get('/api/impact');
    assert.equal(r.body.configured, true);
    assert.ok(r.body.cameras.length > 0);
    assert.ok(r.body.cameras.every((c) => c.lat > 40 && c.impact.level === 2));
    const scores = r.body.cameras.map((c) => c.impact.score);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));

    const all = await t.get('/api/impact?minLevel=0');
    assert.equal(all.body.cameras.length, t.store.all().length);
    assert.equal((await t.get('/api/impact?hazard=heat')).body.cameras.length, 0);

    const cam = r.body.cameras[0];
    const detail = await t.get(`/api/cameras/${cam.slug}/impact`);
    assert.equal(detail.body.level, 2);
    assert.equal(detail.body.hours.length, 25);
    assert.equal(detail.body.events[0].type, 'wind');

    const meta = await t.get('/api/meta');
    assert.equal(meta.body.impact.counts[2], r.body.cameras.length);

    // Card data carries the summary for list views.
    const list = await t.get('/api/cameras?q=northeast');
    assert.equal(list.body.cameras[0].impact.level, 2);

    // Cache survives a restart without a new API call.
    const again = createApp({ dataDir: t.dataDir, poll: false, log: { error() {} }, meteomatics: { username: 'u', password: 'p' } });
    assert.equal(again.impacts.summary(t.store.get(cam.id)).level, 2);
  } finally { t.close(); }
});

test('impact: unconfigured and API errors are reported, not thrown', async () => {
  const t = await boot({});
  try {
    const r = await t.get('/api/impact');
    assert.equal(r.body.configured, false);
    assert.equal(r.body.cameras.length, 0);
    const refresh = await t.get('/api/admin/impact/refresh', { method: 'POST', headers: { authorization: 'Bearer secret' } });
    assert.equal(refresh.status, 503);
  } finally { t.close(); }

  const failing = async () => ({ ok: false, status: 401, text: async () => '{"status":"ERROR","message":"Unauthorized"}' });
  const u = await boot({ username: 'u', password: 'bad', fetchImpl: failing });
  try {
    const refresh = await u.get('/api/admin/impact/refresh', { method: 'POST', headers: { authorization: 'Bearer secret' } });
    assert.equal(refresh.status, 502);
    assert.match(refresh.body.error, /Unauthorized/);
    assert.equal((await u.get('/api/impact')).body.error, 'Unauthorized');
  } finally { u.close(); }
});
