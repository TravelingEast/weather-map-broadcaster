'use strict';

// YouTube live streams restart and change video IDs, and owners can turn off embedding.
// These helpers resolve a camera's reference to the video that is live right now and
// confirm it can play inside our page.

// Accepts a video ID, a channel ID (UC...), a handle (@name), or any common YouTube URL.
function parseYouTubeRef(input) {
  const s = String(input || '').trim();
  let m;
  if ((m = /^@([\w.-]{3,})$/.exec(s)) || (m = /youtube\.com\/@([\w.-]{3,})/.exec(s))) return { type: 'handle', value: m[1] };
  if ((m = /^(UC[\w-]{22})$/.exec(s)) || (m = /youtube\.com\/channel\/(UC[\w-]{22})/.exec(s))) return { type: 'channel', value: m[1] };
  if ((m = /^([\w-]{11})$/.exec(s)) || (m = /(?:v=|youtu\.be\/|\/live\/|\/embed\/|\/shorts\/)([\w-]{11})/.exec(s))) return { type: 'video', value: m[1] };
  return null;
}

function pageUrl(ref) {
  if (ref.type === 'handle') return `https://www.youtube.com/@${ref.value}/live`;
  if (ref.type === 'channel') return `https://www.youtube.com/channel/${ref.value}/live`;
  return `https://www.youtube.com/watch?v=${ref.value}`;
}

// Read the watch page (or a channel's /live page, which renders the current live video).
function parseYouTubePage(html) {
  const canonical = /<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/.exec(html);
  const fromPlayer = /"videoDetails":\{"videoId":"([\w-]{11})"/.exec(html);
  const videoId = (canonical && canonical[1]) || (fromPlayer && fromPlayer[1]) || null;
  const live = /"isLiveNow":true/.test(html) || /"isLive":true/.test(html);
  // Absent means unknown; only an explicit false blocks it.
  const embeddable = !/"playableInEmbed":false/.test(html);
  const title = (/"videoDetails":\{[^}]*?"title":"((?:[^"\\]|\\.)*)"/.exec(html) || [])[1] || null;
  return { videoId, live, embeddable, title: title ? JSON.parse(`"${title}"`) : null };
}

module.exports = { parseYouTubeRef, parseYouTubePage, pageUrl };
