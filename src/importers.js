'use strict';

// Bulk importers for public DOT camera feeds.
// Field mappings follow the feeds' live JSON as used by the open-source "roadie"
// project (github.com/bobbyearl/roadie, scripts/fetchers/api_states.py).

const UA = 'weather-map-broadcaster/0.1 (+webcam directory)';

// Named areas for the bbox filter: [west, south, east, north].
const AREAS = {
  // Baton Rouge / New Orleans east through Panama City Beach: the Isaias landfall cone.
  'north-gulf': [-91.6, 29.0, -84.9, 31.6],
  'gulf-coast': [-97.9, 25.8, -81.0, 31.6],
  'mobile-bay': [-88.5, 30.1, -87.4, 31.0],
  'mississippi-coast': [-89.7, 30.1, -88.3, 30.8],
  'new-orleans': [-90.6, 29.7, -89.6, 30.4],
  'pensacola-destin': [-87.6, 30.2, -86.2, 30.8],
};

function parseBbox(input) {
  if (!input) return null;
  if (Array.isArray(input)) return input.map(Number);
  if (AREAS[input]) return AREAS[input];
  const parts = String(input).split(',').map(Number);
  if (parts.length === 4 && parts.every(Number.isFinite)) return parts;
  throw new Error(`bbox must be an area name (${Object.keys(AREAS).join(', ')}) or "west,south,east,north"`);
}

const inBbox = (b, lat, lon) => !b || (lat >= b[1] && lat <= b[3] && lon >= b[0] && lon <= b[2]);
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// Alabama ALGO Traffic: live HLS plus a snapshot endpoint per camera. No key.
function parseAlgo(data) {
  return (Array.isArray(data) ? data : []).map((cam) => {
    const loc = cam.location || {};
    const route = clean(loc.displayRouteDesignator);
    const cross = clean(loc.displayCrossStreet);
    const dir = clean(loc.direction);
    const hls = cam.playbackUrls && cam.playbackUrls.hls;
    const snapshot = cam.snapshotImageUrl || `https://api.algotraffic.com/v4/Cameras/${cam.id}/snapshot.jpg`;
    return {
      sourceKey: `algo:${cam.id}`,
      name: [route, dir, cross ? `@ ${cross}` : ''].filter(Boolean).join(' ') || `ALGO camera ${cam.id}`,
      lat: Number(loc.latitude),
      lon: Number(loc.longitude),
      city: clean(loc.city),
      region: 'Alabama',
      kind: hls ? 'hls' : 'image',
      url: hls || snapshot,
      snapshotUrl: hls ? snapshot : '',
      poster: hls ? snapshot : '',
      relay: Boolean(hls), // DOT streams often lack CORS headers; play them through our relay
      county: clean(loc.county),
    };
  });
}

// Iteris "511" platform map feed (FL511, 511LA and others). Stills via /map/Cctv/{id}. No key.
function parseIteris(origin, region, prefix) {
  return (data) => {
    const items = (data && (data.item2 || data.item)) || [];
    return items.map((item) => {
      const loc = item.location;
      const [lat, lon] = Array.isArray(loc) ? loc : [loc && loc.lat, loc && loc.lng];
      return {
        sourceKey: `${prefix}:${item.itemId}`,
        name: clean(item.title || item.description) || `${region} camera ${item.itemId}`,
        lat: Number(lat),
        lon: Number(lon),
        city: '',
        region,
        kind: 'image',
        url: `${origin}/map/Cctv/${encodeURIComponent(item.itemId)}`,
        snapshotUrl: '',
        poster: '',
      };
    });
  };
}

const SOURCES = {
  algo: {
    label: 'Alabama ALGO Traffic (live HLS video)',
    url: 'https://api.algotraffic.com/v4/Cameras',
    parse: parseAlgo,
    attribution: 'ALDOT / ALGO Traffic',
    sourceUrl: 'https://algotraffic.com/Cameras',
  },
  fl511: {
    label: 'Florida FL511 (stills)',
    url: 'https://fl511.com/map/mapIcons/Cameras',
    parse: parseIteris('https://fl511.com', 'Florida', 'fl511'),
    attribution: 'FDOT / FL511',
    sourceUrl: 'https://fl511.com/',
  },
  la511: {
    label: 'Louisiana 511LA (stills)',
    url: 'https://511la.org/map/mapIcons/Cameras',
    parse: parseIteris('https://511la.org', 'Louisiana', 'la511'),
    attribution: 'LADOTD / 511LA',
    sourceUrl: 'https://511la.org/',
  },
};

async function fetchJson(url, fetchImpl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const res = await fetchImpl(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Fetch a source, keep cameras inside bbox, and upsert them into the store.
async function importSource(store, sourceId, { bbox, refreshSeconds = 300, tags = [], fetchImpl = fetch } = {}) {
  const src = SOURCES[sourceId];
  if (!src) throw new Error(`unknown source "${sourceId}". Options: ${Object.keys(SOURCES).join(', ')}`);
  const box = parseBbox(bbox);
  const raw = await fetchJson(src.url, fetchImpl);
  const parsed = src.parse(raw).filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon) && c.lat && c.lon);
  const picked = parsed.filter((c) => inBbox(box, c.lat, c.lon));
  const result = store.upsertMany(picked.map((c) => ({
    ...c,
    country: 'US',
    category: 'traffic',
    source: src.attribution,
    sourceUrl: src.sourceUrl,
    refreshSeconds,
    tags: ['traffic', sourceId, ...tags, ...(c.county ? [c.county.toLowerCase()] : [])],
    description: `${src.attribution} traffic camera${c.kind === 'hls' ? ' with live video' : ''}.`,
  })));
  return { source: sourceId, fetched: parsed.length, matched: picked.length, ...result };
}

module.exports = { importSource, parseAlgo, parseIteris, parseBbox, SOURCES, AREAS };
