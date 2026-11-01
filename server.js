import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Локально раздаём public/
if (!process.env.NETLIFY && !process.env.AWS_LAMBDA_FUNCTION_NAME) {
  app.use(express.static('public'));
}

const TAVILY = process.env.TAVILY_API_KEY || '';

/* ===== ОТЗЫВЫ: храним в /tmp (writable на AWS Lambda) ===== */
const TMP_DIR = process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME ? '/tmp' : './data';
const REV_FILE = path.join(TMP_DIR, 'reviews.json');
try { fs.mkdirSync(TMP_DIR, { recursive: true }); } catch {}

function loadRev() {
  try { return JSON.parse(fs.readFileSync(REV_FILE, 'utf8')); } catch { return {}; }
}
function saveRev(db) {
  try { fs.writeFileSync(REV_FILE, JSON.stringify(db)); } catch (e) { console.error('saveRev:', e.message); }
}

/* ===== RATE LIMIT ===== */
const hits = new Map();
app.use('/api', (req, res, next) => {
  const now = Date.now();
  const a = (hits.get(req.ip) || []).filter(t => now - t < 1000);
  if (a.length >= 3) return res.status(429).json({ error: 'slow down' });
  a.push(now); hits.set(req.ip, a);
  next();
});

async function proxy(res, url, opts) {
  try {
    const r = await fetch(url, opts);
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('json')) return res.status(r.status).json(await r.json());
    return res.status(r.status).send(await r.text());
  } catch (e) { return res.status(502).json({ error: String(e.message) }); }
}

app.get('/api/health', (req, res) => res.json({ ok: true, tavily: !!TAVILY }));

app.post('/api/search', (req, res) => {
  if (!TAVILY) return res.status(500).json({ error: 'TAVILY_API_KEY not set' });
  proxy(res, 'https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TAVILY },
    body: JSON.stringify(req.body)
  });
});

app.get('/api/videos', (req, res) => proxy(res,
  `https://api.dailymotion.com/videos?search=${encodeURIComponent(req.query.q || '')}&fields=id,title,thumbnail_720_url,thumbnail_360_url,channel,url,duration,views_total&limit=${Math.min(+req.query.limit || 20, 40)}&sort=relevance`));

app.get('/api/geocode', (req, res) => proxy(res,
  `https://photon.komoot.io/api/?q=${encodeURIComponent(req.query.q || '')}&limit=${req.query.limit || 6}&lang=${req.query.lang || 'ru'}`));

app.get('/api/city', (req, res) => proxy(res,
  `https://photon.komoot.io/reverse?lon=${req.query.lon}&lat=${req.query.lat}&lang=ru`));

app.get('/api/weather', (req, res) => proxy(res,
  `https://api.open-meteo.com/v1/forecast?latitude=${req.query.lat}&longitude=${req.query.lon}&current=temperature_2m,weather_code`));

app.get('/api/route', (req, res) => proxy(res,
  `https://router.project-osrm.org/route/v1/${req.query.profile || 'driving'}/${req.query.from};${req.query.to}?overview=full&geometries=geojson`));

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

app.get('/api/reviews', (req, res) => {
  const db = loadRev();
  res.json(db[req.query.poi] || []);
});
app.post('/api/reviews', (req, res) => {
  const { poi, name, rating, text } = req.body || {};
  if (!poi || !text || !+rating) return res.status(400).json({ error: 'poi, rating, text required' });
  const db = loadRev();
  (db[poi] = db[poi] || []).push({
    name: String(name || 'Гость').slice(0, 40),
    rating: Math.max(1, Math.min(5, +rating | 0)),
    text: String(text).slice(0, 1000),
    date: new Date().toISOString()
  });
  saveRev(db);
  res.json({ ok: true, count: db[poi].length });
});

export { app };

// Локальный запуск
if (!process.env.NETLIFY && !process.env.AWS_LAMBDA_FUNCTION_NAME) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log('✅ Surai API: http://localhost:' + PORT));
                                                              }
