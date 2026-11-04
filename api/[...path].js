const fs = require('fs');

const TAVILY = process.env.TAVILY_API_KEY || '';
const REV_FILE = '/tmp/reviews.json';

function send(res, code, obj) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = code;
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise(resolve => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function loadRev() { try { return JSON.parse(fs.readFileSync(REV_FILE, 'utf8')); } catch (e) { return {}; } }
function saveRev(db) { try { fs.writeFileSync(REV_FILE, JSON.stringify(db)); } catch (e) {} }

async function proxy(url, opts) {
  const r = await fetch(url, opts);
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text() };
}

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const q = url.searchParams;

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.statusCode = 204;
    return res.end();
  }

  try {
    if (p === '/api/health') return send(res, 200, { ok: true, tavily: !!TAVILY });

    if (p === '/api/search' && req.method === 'POST') {
      if (!TAVILY) return send(res, 500, { error: 'TAVILY_API_KEY not set' });
      const body = await readBody(req);
      const r = await proxy('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TAVILY },
        body: JSON.stringify(body)
      });
      return send(res, r.status, r.data);
    }

    if (p === '/api/videos') {
      const r = await proxy('https://api.dailymotion.com/videos?search=' + encodeURIComponent(q.get('q') || '') + '&fields=id,title,thumbnail_720_url,thumbnail_360_url,channel,url,duration,views_total&limit=' + Math.min(+(q.get('limit') || 20), 40) + '&sort=relevance');
      return send(res, r.status, r.data);
    }

    if (p === '/api/geocode') {
      const r = await proxy('https://photon.komoot.io/api/?q=' + encodeURIComponent(q.get('q') || '') + '&limit=' + (q.get('limit') || 6) + '&lang=' + (q.get('lang') || 'ru'));
      return send(res, r.status, r.data);
    }

    if (p === '/api/city') {
      const r = await proxy('https://photon.komoot.io/reverse?lon=' + (q.get('lon') || 0) + '&lat=' + (q.get('lat') || 0) + '&lang=ru');
      return send(res, r.status, r.data);
    }

    if (p === '/api/weather') {
      const r = await proxy('https://api.open-meteo.com/v1/forecast?latitude=' + (q.get('lat') || 0) + '&longitude=' + (q.get('lon') || 0) + '&current=temperature_2m,weather_code');
      return send(res, r.status, r.data);
    }

    if (p === '/api/route') {
      const r = await proxy('https://router.project-osrm.org/route/v1/' + (q.get('profile') || 'driving') + '/' + (q.get('from') || '') + ';' + (q.get('to') || '') + '?overview=full&geometries=geojson');
      return send(res, r.status, r.data);
    }

    if (p === '/api/poi' && req.method === 'POST') {
      const body = await readBody(req);
      const filter = body.filter;
      const bbox = body.bbox || '46.5,40.5,87.3,55.4';
      if (!filter) return send(res, 400, { error: 'filter required' });
      const oq = '[out:json][timeout:9];(node[' + filter + '](' + bbox + ');way[' + filter + '](' + bbox + '););out center tags 30;';
      const r = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(oq)
      });
      const data = await r.json();
      const els = (data.elements || [])
        .map(e => ({ osm: (e.type || '') + (e.id || ''), tags: e.tags || {}, lat: e.lat || (e.center && e.center.lat), lon: e.lon || (e.center && e.center.lon) }))
        .filter(x => x.lat && x.lon);
      for (const x of els.slice(0, 10)) {
        const wp = x.tags.wikipedia;
        if (wp) {
          try {
            const title = wp.indexOf(':') > -1 ? wp.split(':').slice(1).join(':') : wp;
            const wr = await fetch('https://ru.wikipedia.org/w/api.php?action=query&titles=' + encodeURIComponent(title) + '&prop=pageimages&format=json&pithumbsize=640&origin=*');
            const wd = await wr.json();
            const page = Object.values((wd.query && wd.query.pages) || {})[0];
            if (page && page.thumbnail && page.thumbnail.source) x.photo = page.thumbnail.source;
          } catch (e) {}
        }
        if (!x.photo && x.tags.image) x.photo = x.tags.image;
      }
      return send(res, 200, els);
    }

    if (p === '/api/reviews' && req.method === 'GET') {
      const db = loadRev();
      return send(res, 200, db[q.get('poi') || ''] || []);
    }

    if (p === '/api/reviews' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.poi || !b.text || !+b.rating) return send(res, 400, { error: 'poi, rating, text required' });
      const db = loadRev();
      (db[b.poi] = db[b.poi] || []).push({
        name: String(b.name || 'Гость').slice(0, 40),
        rating: Math.max(1, Math.min(5, Math.floor(+b.rating))),
        text: String(b.text).slice(0, 1000),
        date: new Date().toISOString()
      });
      saveRev(db);
      return send(res, 200, { ok: true, count: db[b.poi].length });
    }

    return send(res, 404, { error: 'not found: ' + p });
  } catch (e) {
    return send(res, 502, { error: String((e && e.message) || e) });
  }
};
