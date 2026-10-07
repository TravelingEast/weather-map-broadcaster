# SkyWindow: live webcam platform

A webcam directory in the style of worldcam-type sites. It handles both kinds of cameras:

- **Live streams**: HLS (`.m3u8`), YouTube live, MJPEG, or any iframe embed. Played in the browser.
- **Still cameras**: JPEG/PNG snapshots. The server polls each one, archives frames to disk, and serves them from its own cache. Viewers get a timelapse scrubber over the archive. Cameras can also **push** frames to the server (Raspberry Pi, IP cam, cron script).

**Weather Watch** uses Meteomatics forecasts to rank cameras by the impactful weather expected at their location over the next 72 hours, so you know which cams to watch before a storm, ice event, or heat wave arrives.

**Storm Tracker** pulls the latest NHC forecast track and lists every camera near it, ordered by when the center passes closest, with distance, side of track, forecast storm strength, and the Meteomatics forecast at that camera.

Viewer features: home page with featured and latest cams, browse and filter (country, category, live/still, text search), clustered world map, camera pages with local time, current weather (Open-Meteo), nearby cameras, favorites, share links, and an embed code. Admins add and edit cameras from `/admin`.

## Run it

```bash
npm install
ADMIN_TOKEN=pick-a-long-random-string npm start
# open http://localhost:3000
```

Or with Docker (includes MediaMTX for your own RTSP cameras):

```bash
ADMIN_TOKEN=pick-a-long-random-string docker compose up -d
```

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `ADMIN_TOKEN` | unset | Enables `/admin` and the admin API. Unset means admin is off. |
| `DATA_DIR` | `./data` | Camera catalog (`cameras.json`) and archived frames |
| `SNAPSHOT_RETENTION` | `288` | Frames kept per still camera (288 = 24 h at 5 min) |
| `SNAPSHOT_MAX_AGE_HOURS` | `72` | Frames older than this are deleted |
| `METEOMATICS_USERNAME` / `METEOMATICS_PASSWORD` | unset | Enables Weather Watch. Unset means the feature shows a setup note. |
| `METEOMATICS_MODEL` | `mix` | Meteomatics model |
| `IMPACT_HORIZON_HOURS` | `72` | Forecast window scanned (6 to 240) |
| `IMPACT_REFRESH_MINUTES` | `60` | How often to rescan (min 10) |
| `SNAPSHOT_CONCURRENCY` | `12` | Parallel snapshot fetches |

On first start, `seed/cameras.json` is copied into `DATA_DIR`. After that, the copy in `DATA_DIR` is the live catalog.

## Adding cameras

Sign in at `/admin` with `ADMIN_TOKEN` and pick a type:

| Type | What to enter | Notes |
|---|---|---|
| Still image URL | A direct JPEG/PNG URL | Polled every *refresh* seconds (min 30). Identical frames are skipped. |
| Still, camera pushes | Nothing | Save, then open Edit to get the ingest URL and key. |
| HLS | `https://…/index.m3u8` | Must allow CORS from your site. |
| YouTube | Video ID, channel ID (`UC…`), or any YouTube URL | A channel ID follows whatever that channel is streaming live. |
| MJPEG | Stream URL | Plays directly in an `<img>`. |
| iframe | Embed URL | For providers with their own player. |

### Your own IP cameras (RTSP)

Browsers can't play RTSP. Run MediaMTX (`deploy/mediamtx.yml`) to convert it to HLS, then register `http(s)://<host>:8888/<path>/index.m3u8` as an HLS camera. Use HTTPS in production or browsers will block the stream on an HTTPS site.

### Push stills from a Pi or any camera

`scripts/push-frame.sh` grabs a frame (RTSP via ffmpeg, a snapshot URL, or the Pi camera) and uploads it:

```bash
SERVER=https://cams.example.com CAMERA_ID=<id> INGEST_KEY=<key> RTSP_URL=rtsp://… ./scripts/push-frame.sh
```

Raw API: `POST /api/ingest/:id` with `Authorization: Bearer <ingestKey>` and the image as the body. Max 10 MB. Body must be a real JPEG, PNG, WebP, or GIF.

## Weather Watch (Meteomatics)

Every `IMPACT_REFRESH_MINUTES` the server fetches an hourly forecast for every camera location. Cameras at the same spot share one lookup. Locations are batched 50 per request, so 500 cameras cost 10 API calls per refresh. Results are cached in `DATA_DIR/impact.json`, so a restart doesn't trigger a new pull. Admins can force a rescan from `/admin`. New cameras are picked up on the next scan.

Parameters: `t_2m:C, t_apparent:C, wind_speed_10m:ms, wind_gusts_10m_1h:ms, precip_1h:mm, fresh_snow_1h:cm, precip_type_1h:idx, hail_1h:cm, prob_tstorm_1h:p, cape:Jkg, visibility:m, is_fog_1h:idx, weather_symbol_1h:idx`.

Hazard levels per hour (thresholds roughly follow NWS advisory and warning criteria):

| Hazard | Minor | Moderate | Severe |
|---|---|---|---|
| High wind (gusts) | 35 mph | 45 mph | 58 mph |
| Heavy rain (per hour) | 6 mm | 15 mm | 30 mm |
| Snow (per hour) | 0.5 cm | 2.5 cm | 5 cm |
| Ice | sleet | freezing rain | freezing rain ≥1 mm/h |
| Thunderstorms* | 30% | 50% | 70%, or 50% with CAPE ≥2500 |
| Hail | | 0.5 cm | 2.5 cm |
| Dense fog (visibility) | <1 km | <400 m | |
| Heat (feels like) | 90°F | 103°F | 115°F |
| Extreme cold (feels like) | 0°F | -20°F | -40°F |

\* `prob_tstorm_1h` alone was seen at 20-50% in dry, stable air, so a storm hour only counts when that hour also has at least 0.5 mm of precipitation and CAPE of at least 250 J/kg.

Each camera gets a score: the sum over hazards of level², weighted up for events within 6 hours and down for events beyond 24 hours, and slightly up for longer events. Thresholds live in `src/impact.js` (`HAZARDS`) and are easy to tune.

Where it shows up: the `/impact` page (ranked list, hazard filters), a hazard tag on camera cards, a top-4 Weather Watch row on the home page, an impact mode on the map (clusters show their worst level), and a 72-hour outlook on each camera page. The outlook shows gusts, precipitation, and feels-like temperature with shaded hazard hours, a hover readout, and an hourly table.

## Storm Tracker

Every 30 minutes the server checks the NHC Tropical Cyclone Discussion (TCD) for each Atlantic and East Pacific bin through `api.weather.gov`. Bins with a discussion issued in the last 18 hours count as active. It parses the `FORECAST POSITIONS AND MAX WINDS` table, interpolates the track hourly, and for each camera computes:

- closest approach: distance, time, and interpolated storm wind and category at that time
- side of track: right or left of the direction of motion (the right side usually gets the worst surge and wind), or "center" within 15 km
- when the center first comes within 150 km
- Meteomatics peak gust and rain total at the camera within ±6 hours of closest approach

`/storm` shows the track on a map with a 150 km corridor (not the official NHC cone, which isn't parsed). Cameras are grouped into core (≤50 km), strong impacts (≤150 km) and outer bands, with filters for live/still, category and radius. Camera pages near an active storm show a storm banner.

If `api.weather.gov` is unreachable, an admin can paste the NHC Forecast Discussion text into `/admin` → Storms.

## Importing traffic cameras

From `/admin` → Import cameras, or by API:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"source":"algo","bbox":"north-gulf","refreshSeconds":300}' https://your-host/api/admin/import
```

| Source | Feed | What you get |
|---|---|---|
| `algo` | `api.algotraffic.com/v4/Cameras` (Alabama, no key) | Live HLS video plus a snapshot per camera, which the server archives for timelapse |
| `fl511` | `fl511.com/map/mapIcons/Cameras` (Florida, no key) | Stills from `fl511.com/map/Cctv/{id}` |
| `la511` | `511la.org/map/mapIcons/Cameras` (Louisiana, no key) | Stills, same Iteris platform as FL511 |

`bbox` takes a named area (`north-gulf`, `gulf-coast`, `mobile-bay`, `mississippi-coast`, `new-orleans`, `pensacola-destin`) or `west,south,east,north`. Re-running an import updates cameras in place and keeps your featured/enabled choices. Field mappings follow the open-source [roadie](https://github.com/bobbyearl/roadie) project's fetchers. These are unofficial public map feeds and can change without notice. Mississippi's MDOT has no public feed, so it's in the watchlist as a link.

Curated packs live in `seed/packs/`. `isaias-north-gulf` adds 16 public beach, landmark, harbor, and field-team streams from Grand Isle to Panama City Beach (EarthCam, SkylineWebcams, WAFB, HurricaneTrack, and others). Sites that don't allow embedding are added as `link` cameras. They show on the map and in the Storm Tracker and open the stream on the owner's site.

### Recording a storm

Stills and DOT snapshots are archived automatically. For a multi-day event, keep more frames and poll faster:

```bash
SNAPSHOT_RETENTION=3000 SNAPSHOT_MAX_AGE_HOURS=120 SNAPSHOT_CONCURRENCY=16
```

Re-import with `refreshSeconds: 120` for the cameras nearest the track. Budget disk at about 50 KB per frame: 300 cameras every 2 minutes for 4 days is about 43 GB.

## Seed catalog

The seed ships with NOAA GOES GeoColor satellite stills (CONUS, regional sectors, full disk), two public HLS **test** streams to confirm the player works, and one push-camera placeholder. Replace or extend it from the admin page. Before listing a third-party camera, check that its owner allows embedding or rehosting.

## API

| Method | Path | |
|---|---|---|
| GET | `/api/cameras?q=&country=&category=&type=live\|still&featured=true&bbox=w,s,e,n&near=lat,lon&limit=` | List and filter |
| GET | `/api/cameras/:idOrSlug` | Camera plus 8 nearest cameras |
| GET | `/api/cameras/:id/latest` | Latest archived frame (stills) |
| GET | `/api/cameras/:id/frames` | Archive index |
| GET | `/api/cameras/:id/frames/:ts` | One archived frame |
| GET | `/api/meta` | Counts by country and category |
| GET | `/api/health` | Status counts |
| POST | `/api/ingest/:id` | Push a frame (camera key or admin token) |
| GET/POST | `/api/admin/cameras` | List with errors and keys / create |
| PUT/DELETE | `/api/admin/cameras/:id` | Update / delete (delete also removes the archive) |
| POST | `/api/admin/cameras/:id/check` | Force a health check |
| GET | `/api/impact?hazard=&minLevel=&country=&category=` | Cameras ranked by forecast impact |
| GET | `/api/cameras/:id/impact` | Hazard events plus hourly forecast for one camera |
| POST | `/api/admin/impact/refresh` | Force a Meteomatics rescan |
| GET | `/api/storms` | Active storms with forecast points |
| GET | `/api/storms/:id/cameras?maxKm=&type=&category=` | Cameras near the track, by closest approach |
| POST | `/api/admin/storms/refresh` | Re-check NHC discussions |
| POST | `/api/admin/storms/manual` | Add a storm from pasted TCD text (`{"text": "..."}`) |
| GET | `/api/admin/import/sources` | Import sources and named areas |
| POST | `/api/admin/import` | Import DOT cameras (`{"source","bbox","refreshSeconds"}`) |
| POST | `/api/admin/packs/:id` | Load a curated pack |

Front-end routes: `/`, `/browse`, `/map`, `/impact`, `/storm`, `/storm/:id`, `/cam/:slug`, `/country/:cc`, `/category/:name`, `/favorites`, `/admin`, `/embed/:slug`.

## Tests

```bash
npm test
```

## Known limits

- Storage is a JSON file plus a folder of frames. Fine for hundreds of cameras on one server. Past that, move the catalog to Postgres and frames to object storage.
- The admin token is a single shared secret. Put the site behind HTTPS.
- The server fetches whatever still-image URLs admins enter. Only give admin access to people you trust.
- Meteomatics credentials stay on the server. Browsers only see the computed results.
- Current-conditions weather and map tiles load from Open-Meteo and CARTO/OpenStreetMap in the viewer's browser.
