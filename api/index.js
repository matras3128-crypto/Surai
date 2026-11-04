// ЗАПАСНОЙ — минимальная версия (только health и search)
module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const TAVILY = process.env.TAVILY_API_KEY || '';
  
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  
  if (p === '/api/health') {
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, tavily: !!TAVILY }));
  }
  
  if (p === '/api/search' && req.method === 'POST') {
    if (!TAVILY) { res.statusCode = 500; return res.end('{"error":"TAVILY_API_KEY not set"}'); }
    let body = '';
    req.on('data', c => body += c);
    await new Promise(r => req.on('end', r));
    try {
      const r = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TAVILY },
        body: body
      });
      res.statusCode = r.status;
      res.end(await r.text());
    } catch (e) {
      res.statusCode = 502;
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not found' }));
};
