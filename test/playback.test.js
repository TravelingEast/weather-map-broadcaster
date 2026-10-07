'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createApp } = require('../src/server');
const { parseYouTubeRef, parseYouTubePage } = require('../src/youtube');
const { rewritePlaylist } = require('../src/relay');

test('parseYouTubeRef handles IDs, handles, channels and URLs', () => {
  assert.deepEqual(parseYouTubeRef('Crr5HmqNmws'), { type: 'video', value: 'Crr5HmqNmws' });
  assert.deepEqual(parseYouTubeRef('https://www.youtube.com/watch?v=Crr5HmqNmws'), { type: 'video', value: 'Crr5HmqNmws' });
  assert.deepEqual(parseYouTubeRef('https://www.youtube.com/live/Crr5HmqNmws?si=x'), { type: 'video', value: 'Crr5HmqNmws' });
  assert.deepEqual(parseYouTubeRef('@NavarreBeachPierLive'), { type: 'handle', value: 'NavarreBeachPierLive' });
  assert.deepEqual(parseYouTubeRef('https://www.youtube.com/@BLBGrill/live'), { type: 'handle', value: 'BLBGrill' });
  assert.deepEqual(parseYouTubeRef('UCoA1QcioL4aGra1fPQ6wlGg'), { type: 'channel', value: 'UCoA1QcioL4aGra1fPQ6wlGg' });
  assert.equal(parseYouTubeRef('not a thing!'), null);
});

test('parseYouTubePage reads live state and embeddability', () => {
  const live = '<link rel="canonical" href="https://www.youtube.com/watch?v=AbCdEfGhIjK">"videoDetails":{"videoId":"AbCdEfGhIjK","title":"Navarre \\u0026 Pier","isLive":true}"playableInEmbed":true';
  assert.deepEqual(parseYouTubePage(live), { videoId: 'AbCdEfGhIjK', live: true, embeddable: true, title: 'Navarre & Pier' });
  const ended = '"videoDetails":{"videoId":"AbCdEfGhIjK","title":"Old stream"}"playableInEmbed":true';
  assert.equal(parseYouTubePage(ended).live, false);
  const blocked = '"videoDetails":{"videoId":"AbCdEfGhIjK","isLive":true}"playableInEmbed":false';
  assert.equal(parseYouTubePage(blocked).embeddable, false);
  assert.equal(parseYouTubePage('<html>consent</html>').videoId, null);
});

test('rewritePlaylist routes every URI through the relay', () => {
  const src = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:2.0,\nseg1.ts\nhttps://cdn.example/abs/seg2.ts\n';
  const out = rewritePlaylist(src, 'https://dot.example/live/cam1/index.m3u8', (u) => `R(${u})`);
  assert.match(out, /URI="R\(https:\/\/dot\.example\/live\/cam1\/key\.bin\)"/);
  assert.match(out, /^R\(https:\/\/dot\.example\/live\/cam1\/seg1\.ts\)$/m);
  assert.match(out, /^R\(https:\/\/cdn\.example\/abs\/seg2\.ts\)$/m);
  assert.match(out, /^#EXTINF:2.0,$/m);
});

async function boot() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'play-'));
  const ctx = createApp({ dataDir, adminToken: 'secret', poll: false, log: { error() {}, log() {} } });
  const server = await new Promise((r) => { const s = ctx.app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, { method = 'GET', body } = {}) => {
    const res = await fetch(base + p, { method, headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, type, body: type.includes('json') ? await res.json() : await res.text() };
  };
  return { ...ctx, call, close: () => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

test('HLS relay serves rewritten playlists and segments for allowed hosts only', async () => {
  const up = http.createServer((req, res) => {
    if (req.url === '/live/index.m3u8') { res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }); return res.end('#EXTM3U\n#EXTINF:2,\nseg1.ts\n'); }
    if (req.url === '/live/seg1.ts') { res.writeHead(200, { 'content-type': 'video/mp2t' }); return res.end('TSDATA'); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => up.listen(0, r));
  const origin = `http://127.0.0.1:${up.address().port}`;
  const t = await boot();
  try {
    const { body } = await t.call('/api/admin/cameras', { method: 'POST', body: { name: 'DOT cam', kind: 'hls', url: `${origin}/live/index.m3u8`, lat: 30.6, lon: -88, relay: true } });
    const cam = body.camera;
    assert.equal(cam.playUrl, `/api/cameras/${cam.id}/relay/index.m3u8`);

    const pl = await t.call(cam.playUrl);
    assert.equal(pl.status, 200);
    assert.match(pl.type, /mpegurl/);
    const segPath = pl.body.split('\n').find((l) => l.startsWith('/api/'));
    assert.ok(segPath, 'segment rewritten to relay');
    const seg = await t.call(segPath);
    assert.equal(seg.body, 'TSDATA');

    // Not an open proxy: other hosts are refused.
    const evil = Buffer.from('http://169.254.169.254/latest/meta-data').toString('base64url');
    assert.equal((await t.call(`/api/cameras/${cam.id}/relay/r?u=${evil}`)).status, 403);

    // Non-relay cams have no relay endpoint.
    const plain = (await t.call('/api/admin/cameras', { method: 'POST', body: { name: 'Plain', kind: 'hls', url: `${origin}/live/index.m3u8`, lat: 30, lon: -88 } })).body.camera;
    assert.equal(plain.playUrl, `${origin}/live/index.m3u8`);
    assert.equal((await t.call(`/api/cameras/${plain.id}/relay/index.m3u8`)).status, 404);
  } finally {
    t.close();
    up.close();
  }
});

test('viewers never see link-out cams or YouTube cams that are not live', async () => {
  const t = await boot();
  try {
    const link = (await t.call('/api/admin/cameras', { method: 'POST', body: { name: 'Offsite', kind: 'link', url: 'https://example.com/cam', lat: 30, lon: -88 } })).body.camera;
    const yt = (await t.call('/api/admin/cameras', { method: 'POST', body: { name: 'Dead stream', kind: 'youtube', url: 'AbCdEfGhIjK', lat: 30, lon: -88 } })).body.camera;
    const ytLive = (await t.call('/api/admin/cameras', { method: 'POST', body: { name: 'Live stream', kind: 'youtube', url: '@SomeCam', lat: 30.1, lon: -88 } })).body.camera;
    t.snaps.setStatus(yt.id, { status: 'offline', error: 'not live right now' });
    t.snaps.setStatus(ytLive.id, { status: 'online', liveVideoId: 'ZyXwVuTsRqP' });

    const names = (await t.call('/api/cameras?limit=2000')).body.cameras.map((c) => c.name);
    assert.ok(!names.includes('Offsite'));
    assert.ok(!names.includes('Dead stream'));
    assert.ok(names.includes('Live stream'));
    assert.equal((await t.call(`/api/cameras/${link.id}`)).status, 404);

    const live = (await t.call(`/api/cameras/${ytLive.id}`)).body.camera;
    assert.equal(live.liveVideoId, 'ZyXwVuTsRqP');
    assert.equal(live.thumbnail, 'https://i.ytimg.com/vi/ZyXwVuTsRqP/hqdefault.jpg');

    // Admin still sees everything.
    const admin = (await t.call('/api/admin/cameras')).body.cameras.map((c) => c.name);
    assert.ok(admin.includes('Offsite') && admin.includes('Dead stream'));
  } finally { t.close(); }
});
