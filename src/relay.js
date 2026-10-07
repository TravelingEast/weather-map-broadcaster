'use strict';

// HLS relay for public camera streams (e.g. DOT traffic video) whose servers don't send
// CORS headers, so browsers on our domain can't load them directly. Playlists are rewritten
// so every segment and sub-playlist also comes through us. Only hosts that belong to a
// registered camera are fetched, so this is not an open proxy.

const MAX_PLAYLIST_BYTES = 512 * 1024;
const MAX_SEGMENT_BYTES = 32 * 1024 * 1024;

const encode = (u) => Buffer.from(u).toString('base64url');
const decode = (s) => Buffer.from(String(s), 'base64url').toString('utf8');

const isPlaylist = (url, type) => /mpegurl/i.test(type || '') || /\.m3u8?(\?|$)/i.test(url);

// Rewrite every URI in a playlist (plain lines and URI="..." attributes) through makeUrl.
function rewritePlaylist(text, baseUrl, makeUrl) {
  const abs = (u) => new URL(u, baseUrl).toString();
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${makeUrl(abs(u))}"`);
      return makeUrl(abs(t));
    })
    .join('\n');
}

function relayRoutes(app, { store, fetchImpl = fetch, log = console }) {
  const allowedHost = (cam, url) => {
    try {
      const h = new URL(url).host;
      return [cam.url, cam.snapshotUrl].filter(Boolean).some((u) => new URL(u).host === h);
    } catch {
      return false;
    }
  };

  const relay = async (req, res, cam, target) => {
    if (!allowedHost(cam, target)) return res.status(403).json({ error: 'host not allowed for this camera' });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const up = await fetchImpl(target, { headers: { 'user-agent': 'weather-map-broadcaster/0.1 (hls relay)' }, signal: ctrl.signal });
      if (!up.ok) return res.status(502).json({ error: `upstream HTTP ${up.status}` });
      const type = up.headers.get('content-type') || '';
      const buf = Buffer.from(await up.arrayBuffer());
      if (isPlaylist(target, type)) {
        if (buf.length > MAX_PLAYLIST_BYTES) return res.status(502).json({ error: 'playlist too large' });
        const make = (u) => `/api/cameras/${cam.id}/relay/r?u=${encode(u)}`;
        res.set('cache-control', 'no-cache');
        return res.type('application/vnd.apple.mpegurl').send(rewritePlaylist(buf.toString('utf8'), up.url || target, make));
      }
      if (buf.length > MAX_SEGMENT_BYTES) return res.status(502).json({ error: 'segment too large' });
      res.set('cache-control', 'public, max-age=30');
      return res.type(type || 'application/octet-stream').send(buf);
    } catch (e) {
      log.error('relay failed', cam.id, e.message);
      return res.status(502).json({ error: e.name === 'AbortError' ? 'upstream timeout' : 'upstream error' });
    } finally {
      clearTimeout(timer);
    }
  };

  const camFor = (req, res) => {
    const cam = store.get(req.params.id);
    if (!cam || cam.enabled === false || cam.kind !== 'hls' || !cam.relay) {
      res.status(404).json({ error: 'no relay for this camera' });
      return null;
    }
    return cam;
  };

  app.get('/api/cameras/:id/relay/index.m3u8', (req, res) => {
    const cam = camFor(req, res);
    if (cam) relay(req, res, cam, cam.url);
  });

  app.get('/api/cameras/:id/relay/r', (req, res) => {
    const cam = camFor(req, res);
    if (!cam) return;
    let target;
    try { target = decode(req.query.u); new URL(target); } catch { return res.status(400).json({ error: 'bad url' }); }
    relay(req, res, cam, target);
  });
}

module.exports = { relayRoutes, rewritePlaylist };
