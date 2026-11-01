const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const serverless = require('serverless-http');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const TAVILY = process.env.TAVILY_API_KEY || '';
const REV_FILE = path.join('/tmp', 'reviews.json');

function loadRev() { try { return JSON.parse(fs.readFileSync(REV_FILE, 'utf8')); } catch (e) { return {}; } }
function saveRev(db) { try { fs.writeFileSync(REV_FILE, JSON.stringify(db)); } catch (e) { console.error(e.message); } }

const hits = new Map();
app.use((req, res, next) => {
  const now = Date.now();
  const a = (hits.get(req.ip) || []).filter(t => now - t < 1000);
  if (a.length >= 3) return res.status(429).json({ error: 'slow down' });
  a.push(now); hits.set(req.ip, a); next();
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
  'https://api.dailymotion.com/videos?search=' + encodeURIComponent(req.query.q || '') + '&fields=id,title,thumbnail_720_url,thumbnail_360_url,channel,url,duration,views_total&limit=' + Math.min(+req.query.limit || 20, 40) + '&sort=relevance'));

app.get('/api/geocode', (req, res) => proxy(res,
  'https://photon.komoot.io/api/?q=' + encodeURIComponent(req.query.q || '') + '&limit=' + (req.query.limit || 6) + '&lang=' + (req.query.lang || 'ru')));

app.get('/api/city', (req, res) => proxy(res,
  'https://photon.komoot.io/reverse?lon=' + req.query.lon + '&lat=' + req.query.lat + '&lang=ru'));

app.get('/api/weather', (req, res) => proxy(res,
  'https://api.open-meteo.com/v1/forecast?latitude=' + req.query.lat + '&longitude=' + req.query.lon + '&current=temperature_2m,weather_code'));

app.get('/api/route', (req, res) => proxy(res,
  'https://router.project-osrm.org/route/v1/' + (req.query.profile || 'driving') + '/' + req.query.from + ';' + req.query.to + '?overview=full&geometries=geojson'));

app.post('/api/poi', async (req, res) => {
  const filter = req.body && req.body.filter;
  const bbox = (req.body && req.body.bbox) || '46.5,40.5,87.3,55.4';
  if (!filter) return res.status(400).json({ error: 'filter required' });
  const q = '[out:json][timeout:25];(node[' + filter + '](' + bbox + ');way[' + filter + '](' + bbox + '););out center tags 30;';
  try {
    const r = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(q)
    });
    const data = await r.json();
    const els = (data.elements || [])
      .map(e => ({ osm: (e.type || '') + (e.id || ''), tags: e.tags || {}, lat: e.lat || (e.center && e.center.lat), lon: e.lon || (e.center && e.center.lon) }))
      .filter(p => p.lat && p.lon);
    for (const p of els.slice(0, 10)) {
      const wp = p.tags.wikipedia;
      if (wp) {
        try {
          const title = wp.indexOf(':') > -1 ? wp.split(':').slice(1).join(':') : wp;
          const wr = await fetch('https://ru.wikipedia.org/w/api.php?action=query&titles=' + encodeURIComponent(title) + '&prop=pageimages&format=json&pithumbsize=640&origin=*');
          const wd = await wr.json();
          const pages = (wd.query && wd.query.pages) || {};
          const page = Object.values(pages)[0];
          if (page && page.thumbnail && page.thumbnail.source) p.photo = page.thumbnail.source;
        } catch (e) {}
      }
      if (!p.photo && p.tags.image) p.photo = p.tags.image;
    }
    res.json(els);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/reviews', (req, res) => {
  const db = loadRev();
  res.json(db[req.query.poi] || []);
});

app.post('/api/reviews', (req, res) => {
  const b = req.body || {};
  if (!b.poi || !b.text || !+b.rating) return res.status(400).json({ error: 'poi, rating, text required' });
  const db = loadRev();
  (db[b.poi] = db[b.poi] || []).push({
    name: String(b.name || 'Гость').slice(0, 40),
    rating: Math.max(1, Math.min(5, Math.floor(+b.rating))),
    text: String(b.text).slice(0, 1000),
    date: new Date().toISOString()
  });
  saveRev(db);
  res.json({ ok: true, count: db[b.poi].length });
});

module.exports.handler = serverless(app);
