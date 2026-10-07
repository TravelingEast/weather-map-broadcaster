'use strict';

const fs = require('fs');
const path = require('path');

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15000;
const EXT_BY_TYPE = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const TYPE_BY_EXT = Object.fromEntries(Object.entries(EXT_BY_TYPE).map(([t, e]) => [e, t]));

function sniffImageType(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  return null;
}

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: { 'user-agent': 'weather-map-broadcaster/0.1 (+webcam directory)', ...(opts.headers || {}) },
      redirect: 'follow',
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readLimited(res, limit) {
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      reader.cancel().catch(() => {});
      throw new Error(`image larger than ${limit} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

// Polls still cameras, archives frames to disk, and health-checks streams.
class SnapshotService {
  constructor({ store, dir, retention = 288, maxAgeHours = 72, log = console }) {
    this.store = store;
    this.dir = dir;
    this.retention = retention;
    this.maxAgeMs = maxAgeHours * 3600 * 1000;
    this.log = log;
    this.status = new Map(); // id -> { status, lastChecked, lastOk, error, latest }
    this.inFlight = new Map(); // id -> promise of the running check
    this.timer = null;
    fs.mkdirSync(dir, { recursive: true });
  }

  camDir(id) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('bad camera id');
    return path.join(this.dir, id);
  }

  getStatus(id) {
    const s = this.status.get(id);
    if (s) return s;
    const latest = this.listFrames(id).at(-1) || null;
    const init = { status: latest ? 'stale' : 'unknown', lastChecked: null, lastOk: latest ? latest.ts : null, error: null, latest };
    this.status.set(id, init);
    return init;
  }

  setStatus(id, patch) {
    const s = { ...this.getStatus(id), ...patch, lastChecked: Date.now() };
    this.status.set(id, s);
    return s;
  }

  listFrames(id) {
    let names;
    try {
      names = fs.readdirSync(this.camDir(id));
    } catch {
      return [];
    }
    return names
      .map((n) => {
        const m = /^(\d{13})\.(jpg|png|webp|gif)$/.exec(n);
        return m ? { ts: Number(m[1]), ext: m[2], file: n } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.ts - b.ts);
  }

  framePath(id, ts) {
    const f = this.listFrames(id).find((x) => x.ts === Number(ts));
    if (!f) return null;
    return { path: path.join(this.camDir(id), f.file), type: TYPE_BY_EXT[f.ext], ts: f.ts };
  }

  latestFrame(id) {
    const f = this.listFrames(id).at(-1);
    if (!f) return null;
    return { path: path.join(this.camDir(id), f.file), type: TYPE_BY_EXT[f.ext], ts: f.ts };
  }

  // Save an image buffer as a new frame. Used by polling and push ingest.
  saveFrame(id, buf, declaredType) {
    const type = sniffImageType(buf);
    if (!type) throw new Error(`not a recognized image (declared ${declaredType || 'none'})`);
    const dir = this.camDir(id);
    fs.mkdirSync(dir, { recursive: true });

    // Skip identical consecutive frames: many cams serve the same file between updates.
    const prev = this.latestFrame(id);
    if (prev) {
      try {
        const old = fs.readFileSync(prev.path);
        if (old.equals(buf)) {
          return this.setStatus(id, { status: 'online', lastOk: Date.now(), error: null, unchanged: true });
        }
      } catch { /* ignore */ }
    }

    const ts = Date.now();
    const file = path.join(dir, `${ts}.${EXT_BY_TYPE[type]}`);
    fs.writeFileSync(file, buf);
    this.prune(id);
    return this.setStatus(id, {
      status: 'online', lastOk: ts, error: null, unchanged: false,
      latest: { ts, ext: EXT_BY_TYPE[type], file: path.basename(file) },
    });
  }

  prune(id) {
    const frames = this.listFrames(id);
    const cutoff = Date.now() - this.maxAgeMs;
    const excess = frames.length - this.retention;
    frames.forEach((f, i) => {
      if (i < excess || f.ts < cutoff) {
        try { fs.unlinkSync(path.join(this.camDir(id), f.file)); } catch { /* ignore */ }
      }
    });
  }

  removeCamera(id) {
    fs.rmSync(this.camDir(id), { recursive: true, force: true });
    this.status.delete(id);
  }

  async pollImage(cam) {
    const res = await fetchWithTimeout(cam.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await readLimited(res, MAX_IMAGE_BYTES);
    return this.saveFrame(cam.id, buf, res.headers.get('content-type'));
  }

  async checkHls(cam) {
    const res = await fetchWithTimeout(cam.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = (await readLimited(res, 512 * 1024)).toString('utf8');
    if (!text.startsWith('#EXTM3U')) throw new Error('not an HLS playlist');
    return this.setStatus(cam.id, { status: 'online', lastOk: Date.now(), error: null });
  }

  async checkMjpeg(cam) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(cam.url, { signal: ctrl.signal });
      ctrl.abort(); // headers are enough; do not download the endless stream
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return this.setStatus(cam.id, { status: 'online', lastOk: Date.now(), error: null });
    } finally {
      clearTimeout(timer);
    }
  }

  isDue(cam) {
    const s = this.getStatus(cam.id);
    if (!s.lastChecked) return true;
    const interval = cam.kind === 'image' ? cam.refreshSeconds * 1000 : 10 * 60 * 1000;
    // Back off on failures: double the wait, capped at 1 h.
    const backoff = s.status === 'offline' ? Math.min(interval * 2 ** Math.min(s.failures || 0, 6), 3600 * 1000) : interval;
    return Date.now() - s.lastChecked >= backoff;
  }

  check(cam) {
    // Concurrent callers share one request per camera.
    if (this.inFlight.has(cam.id)) return this.inFlight.get(cam.id);
    const p = this.runCheck(cam).finally(() => this.inFlight.delete(cam.id));
    this.inFlight.set(cam.id, p);
    return p;
  }

  async runCheck(cam) {
    try {
      let s;
      if (cam.kind === 'image') s = await this.pollImage(cam);
      else if (cam.kind === 'hls') s = await this.checkHls(cam);
      else if (cam.kind === 'mjpeg') s = await this.checkMjpeg(cam);
      else if (cam.kind === 'push') {
        // Push cams go stale if no frame arrives within 3x their expected interval.
        const st = this.getStatus(cam.id);
        const fresh = st.lastOk && Date.now() - st.lastOk < cam.refreshSeconds * 3000;
        s = this.setStatus(cam.id, { status: fresh ? 'online' : st.lastOk ? 'stale' : 'waiting' });
      } else s = this.setStatus(cam.id, { status: 'embed' });
      if (s.status === 'online') this.status.set(cam.id, { ...s, failures: 0 });
      return this.getStatus(cam.id);
    } catch (err) {
      const prev = this.getStatus(cam.id);
      const msg = err.name === 'AbortError' ? 'timeout' : (err.cause && err.cause.code) || err.message;
      return this.setStatus(cam.id, { status: 'offline', error: msg, failures: (prev.failures || 0) + 1 });
    }
  }

  async tick() {
    const due = this.store.all().filter((c) => c.enabled !== false && this.isDue(c));
    // Limit concurrency so a large catalog does not open hundreds of sockets at once.
    const queue = [...due];
    const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
      while (queue.length) await this.check(queue.shift());
    });
    await Promise.all(workers);
  }

  start(intervalMs = 10000) {
    const run = () => this.tick().catch((e) => this.log.error('snapshot tick failed', e));
    run();
    this.timer = setInterval(run, intervalMs);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }
}

module.exports = { SnapshotService, sniffImageType, MAX_IMAGE_BYTES };
