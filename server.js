// Surai API — Express-сервер, готовый для Netlify Functions
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Локально раздаём статику сами; на Netlify это делает CDN
if (!process.env.NETLIFY) {
  app.use(express.static(path.join(__dirname, 'public')));
}

const TAVILY = process.env.TAVILY_API_KEY || '';

/* ========== ОТЗЫВЫ: Netlify Blobs (в облаке) / файл (локально) ========== */
const DATA = path.join(__dirname, 'data');
const REV_FILE = path.join(DATA, 'reviews.json');
try { fs.mkdirSync(DATA, { recursive: true }); } catch {}

let blobs = null;
try {
  const mod = await import('@netlify/blobs');
  blobs = mod.getStore('surai-reviews');
} catch {}

async function loadRev() {
  if (blobs) {
    try { const raw = await blobs.get('reviews.json'); return raw ? JSON.parse(raw) : {}; } catch { return {}; }
  }
  try { return JSON.parse(fs.readFileSync(REV_FILE, 'utf8')); } catch { return {}; }
}
async function saveRev(db) {
  if (blobs) { try { await blobs.set('reviews.json', JSON.stringify(db)); return; } catch {} }
  try { fs.writeFileSync(REV_FILE, JSON.stringify(db, null, 2)); } catch {}
}

/* ========== RATE LIMIT: 3 запроса/сек с IP ========== */
const hits = new Map();
app.use('/api', (req, res, next) => {
  const now = Date.now();
  const a = (hits.get(req.ip) || []).filter(t => now - t < 1000);
  if (a.length >= 3) return res.status(429).json({ error: 'slow down' });
  a.push(now); hits.set(req.ip, a);
  next();
});

/* ========== ПРОКСИ-ПОМОЩНИК ========== */
async function proxy(res, url, opts) {
  try {
    const r = await fetch(url, opts);
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('json')) return res.status(r.status).json(await r.json());
    return res.status(r.status).send(await r.text());
  } catch (e) { return res.status(502).json({ error: 'upstream: ' + e.message }); }
}

/* ========== РОУТЫ ========== */
app.get('/api/health', (req, res) => res.json({ ok: true, tavily: !!TAVILY }));

// 🔒 Tavily — ключ только на сервере
app.post('/api/search', (req, res) => {
  if (!TAVILY) return res.status(500).json({ error: 'TAVILY_API_KEY not set' });
  proxy(res, 'https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TAVILY },
    body: JSON.stringify(req.body)
  });
});

// Видео (Dailymotion)
app.get('/api/videos', (req, res) => proxy(res,
  `https://api.dailymotion.com/videos?search=${encodeURIComponent(req.query.q || '')}&fields=id,title,thumbnail_720_url,thumbnail_360_url,channel,url,duration,views_total&limit=${Math.min(+req.query.limit || 20, 40)}&sort=relevance`));

// Геокодинг (Photon)
app.get('/api/geocode', (req, res) => proxy(res,
  `https://photon.komoot.io/api/?q=${encodeURIComponent(req.query.q || '')}&limit=${req.query.limit || 6}&lang=${req.query.lang || 'ru'}`));

// Город по координатам
app.get('/api/city', (req, res) => proxy(res,
  `https://photon.komoot.io/reverse?lon=${req.query.lon}&lat=${req.query.lat}&lang=ru`));

// Погода (open-meteo)
app.get('/api/weather', (req, res) => proxy(res,
  `https://api.open-meteo.com/v1/forecast?latitude=${req.query.lat}&longitude=${req.query.lon}&current=temperature_2m,weather_code`));

// Маршруты (OSRM)
app.get('/api/route', (req, res) => proxy(res,
  `https://router.project-osrm.org/route/v1/${req.query.profile || 'driving'}/${req.query.from};${req.query.to}?overview=full&geometries=geojson`));

// Организации (Overpass) + фото из Wikipedia/Commons
app.post('/api/poi', async (req, res) => {
  const { filter, bbox } = req.body || {};
  if (!filter) return res.status(400).json({ error: 'filter required' });
  const b = bbox || '46.5,40.5,87.3,55.4';
  const q = `[out:json][timeout:25];(node[${filter}](${b});way[${filter}](${b}););out center tags 30;`;
  try {
    const r = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(q)
    });
    const data = await r.json();
    const els = (data.elements || [])
      .map(e => ({ osm: (e.type || '') + (e.id || ''), tags: e.tags || {}, lat: e.lat || e.center?.lat, lon: e.lon || e.center?.lon }))
      .filter(p => p.lat && p.lon);

    for (const p of els.slice(0, 10)) {
      const wp = p.tags.wikipedia;
      if (wp) {
        try {
          const title = wp.includes(':') ? wp.split(':').slice(1).join(':') : wp;
          const wr = await fetch(`https://ru.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=pageimages&format=json&pithumbsize=640&origin=*`);
          const page = Object.values((await wr.json()).query?.pages || {})[0];
          if (page?.thumbnail?.source) p.photo = page.thumbnail.source;
        } catch {}
      }
      if (!p.photo && p.tags.image) p.photo = p.tags.image;
      if (!p.photo && p.tags['wikimedia_commons']) {
        const f = p.tags['wikimedia_commons'].replace(/^(File|Файл):/, '');
        p.photo = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(f)}?width=640`;
      }
    }
    res.json(els);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ⭐ Отзывы
app.get('/api/reviews', async (req, res) => {
  const db = await loadRev();
  res.json(db[req.query.poi] || []);
});
app.post('/api/reviews', async (req, res) => {
  const { poi, name, rating, text } = req.body || {};
  if (!poi || !text || !+rating) return res.status(400).json({ error: 'poi, rating, text required' });
  const db = await loadRev();
  (db[poi] = db[poi] || []).push({
    name: String(name || 'Гость').slice(0, 40),
    rating: Math.max(1, Math.min(5, +rating | 0)),
    text: String(text).slice(0, 1000),
    date: new Date().toISOString()
  });
  await saveRev(db);
  res.json({ ok: true, count: db[poi].length });
});

/* ========== ЭКСПОРТ ДЛЯ NETLIFY ========== */
export { app };

/* ========== ЛОКАЛЬНЫЙ ЗАПУСК (не на Netlify) ========== */
if (!process.env.NETLIFY && !process.env.AWS_LAMBDA_FUNCTION_NAME) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log('✅ Surai API: http://localhost:' + PORT));
}