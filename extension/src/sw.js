// Service worker: the only part that talks to tenor.com. It reads the result
// data Tenor embeds in its own pages and hands the content script a short list
// of { id, title, preview, width, height }.

const TENOR = 'https://tenor.com';
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_RESULTS = 50;

// url -> { time, value }
const cache = new Map();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  handle(msg).then(
    (gifs) => sendResponse({ ok: true, gifs }),
    (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }),
  );
  return true;
});

async function handle(msg) {
  if (!msg || typeof msg !== 'object') throw new Error('Bad request.');
  if (msg.type === 'featured') return featured();
  if (msg.type === 'search' && typeof msg.query === 'string') return search(msg.query);
  if (msg.type === 'resolve' && typeof msg.input === 'string') return resolve(msg.input);
  throw new Error('Bad request.');
}

async function fetchStore(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.time < CACHE_TTL_MS) return hit.value;
  const res = await fetch(url, { credentials: 'omit', redirect: 'follow' });
  if (!res.ok) throw new Error(res.status === 404 ? 'Tenor could not find that GIF.' : `Tenor returned HTTP ${res.status}.`);
  if (new URL(res.url).origin !== TENOR) throw new Error('Tenor redirected somewhere unexpected.');
  const html = await res.text();
  const m = html.match(/<script id="store-cache" type="text\/x-cache"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('Tenor changed its page format; search is unavailable.');
  const value = JSON.parse(m[1]);
  cache.set(url, { time: Date.now(), value });
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  return value;
}

function toGif(r) {
  if (!r || !/^\d{1,20}$/.test(String(r.id)) || !r.media_formats) return null;
  const flags = r.flags || [];
  if (flags.includes('sticker') || flags.includes('static')) return null;
  const f = r.media_formats.tinygif || r.media_formats.tinywebp || r.media_formats.gif;
  if (!f || typeof f.url !== 'string' || !/^https:\/\/media\d*\.tenor\.com\//.test(f.url)) return null;
  const dims = Array.isArray(f.dims) ? f.dims : [];
  return {
    id: String(r.id),
    title: String(r.content_description || r.h1_title || 'GIF').slice(0, 200),
    preview: f.url,
    width: dims[0] || 220,
    height: dims[1] || 124,
  };
}

const toGifs = (results) => (results || []).map(toGif).filter(Boolean).slice(0, MAX_RESULTS);

async function featured() {
  const store = await fetchStore(`${TENOR}/`);
  return toGifs(store.gifs && store.gifs.featured && store.gifs.featured.results);
}

async function search(query) {
  const slug = query.trim().toLowerCase().split(/\s+/).filter(Boolean).map(encodeURIComponent).join('-');
  if (!slug) return featured();
  const store = await fetchStore(`${TENOR}/search/${slug}-gifs`);
  const searches = Object.values((store.universal && store.universal.search) || {});
  return toGifs(searches[0] && searches[0].results);
}

// Accepts a tenor.com page link, a tenor.com short link, a media.tenor.com
// file link or a bare numeric ID, and returns the one GIF it points at.
async function resolve(input) {
  const text = input.trim();
  let pageUrl;
  if (/^\d{1,20}$/.test(text)) {
    pageUrl = `${TENOR}/view/x-gif-${text}`;
  } else {
    let url;
    try { url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`); } catch (e) { throw new Error('That is not a Tenor link.'); }
    if (/^media\d*\.tenor\.com$/.test(url.hostname)) {
      // media IDs are the base64 of the 64-bit GIF ID followed by a format code
      const mediaId = url.pathname.split('/').filter(Boolean).find((p) => /^[A-Za-z0-9_-]{16}$/.test(p));
      if (!mediaId) throw new Error('That is not a Tenor GIF link.');
      pageUrl = `${TENOR}/view/x-gif-${decodeMediaId(mediaId)}`;
    } else if (url.hostname === 'tenor.com' || url.hostname === 'www.tenor.com') {
      pageUrl = `${TENOR}${url.pathname}`;
    } else {
      throw new Error('That is not a Tenor link.');
    }
  }
  const store = await fetchStore(pageUrl);
  const entries = Object.values((store.gifs && store.gifs.byId) || {});
  const gifs = toGifs(entries.flatMap((e) => (e && e.results) || []).slice(0, 1));
  if (!gifs.length) throw new Error('That link does not point at a GIF.');
  return gifs;
}

function decodeMediaId(mediaId) {
  const bin = atob(mediaId.slice(0, 11).replace(/-/g, '+').replace(/_/g, '/') + '=');
  let n = 0n;
  for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(bin.charCodeAt(i));
  return n.toString();
}
