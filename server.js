const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;

function sendJSON(res, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(s);
}

function readJSONSafe(file) {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, file))); } catch (e) { return null; }
}

// Simple SSE clients list
const clients = [];

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // Static files
  if (pathname === '/' || pathname === '/index.html') {
    const file = path.join(PUBLIC_DIR, 'index.html');
    return fs.createReadStream(file).pipe(res);
  }
  if (pathname.startsWith('/public/') || pathname.startsWith('/app.js')) {
    const p = path.join(PUBLIC_DIR, pathname.replace(/^\//, ''));
    if (fs.existsSync(p)) return fs.createReadStream(p).pipe(res);
  }

  // SSE stream for live updates
  if (pathname === '/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write('\n');
    const client = res;
    clients.push(client);
    req.on('close', () => {
      const idx = clients.indexOf(client);
      if (idx >= 0) clients.splice(idx, 1);
    });
    return;
  }

  // API: top rankings (type: season|power|money|level)
  if (pathname === '/api/top') {
    const type = parsed.query.type || 'season';
    const limit = parseInt(parsed.query.limit || '50');
    const usuarios = readJSONSafe('usuarios.json') || {};
    const seasons = readJSONSafe('seasons.json') || { seasons: {}, current: null };
    const currentSeason = seasons.current;
    let arr = [];
    for (const k of Object.keys(usuarios)) {
      const u = usuarios[k];
      const seasonPts = currentSeason && seasons.seasons[currentSeason] && seasons.seasons[currentSeason].standings && seasons.seasons[currentSeason].standings[k] ? seasons.seasons[currentSeason].standings[k] : 0;
      arr.push({ id: k, nombre: u.nombre || k.split('@')[0], poder: u.poder || 0, dinero: u.dinero || 0, nivel: u.nivel || 1, seasonPts });
    }
    if (type === 'season') arr.sort((a,b)=> b.seasonPts - a.seasonPts);
    else if (type === 'power') arr.sort((a,b)=> b.poder - a.poder);
    else if (type === 'money') arr.sort((a,b)=> b.dinero - a.dinero);
    else if (type === 'level') arr.sort((a,b)=> b.nivel - a.nivel);
    sendJSON(res, { ok: true, data: arr.slice(0, limit), total: arr.length, currentSeason });
    return;
  }

  // API: get seasons/events
  if (pathname === '/api/seasons') {
    const s = readJSONSafe('seasons.json') || { seasons: {}, current: null };
    sendJSON(res, s);
    return;
  }

  // API: social config GET
  if (pathname === '/api/social/config' && req.method === 'GET') {
    const cfg = readJSONSafe('socialConfig.json') || null;
    sendJSON(res, { ok: true, config: cfg });
    return;
  }

  // API: social config POST - actions: addBadWord, removeBadWord, set
  if (pathname === '/api/social/config' && req.method === 'POST') {
    let body = '';
    req.on('data', d=> body += d);
    req.on('end', ()=>{
      try {
        const payload = JSON.parse(body || '{}');
        const cfgPath = path.join(__dirname,'socialConfig.json');
        let cfg = readJSONSafe('socialConfig.json') || { badWords: [], alertThreshold: 30, alertWindowMs: 60000, historialVisibility: 'public' };
        if (payload.action === 'addBadWord' && payload.word) {
          if (!cfg.badWords.includes(payload.word)) cfg.badWords.push(payload.word);
          fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
          sendJSON(res, { ok: true }); return;
        }
        if (payload.action === 'removeBadWord' && payload.word) {
          cfg.badWords = (cfg.badWords||[]).filter(x => x !== payload.word);
          fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
          sendJSON(res, { ok: true }); return;
        }
        if (payload.action === 'set') {
          if (payload.key === 'alertThreshold' && typeof payload.value !== 'undefined') cfg.alertThreshold = Number(payload.value) || cfg.alertThreshold;
          if (payload.key2 === 'alertWindow' && typeof payload.value2 !== 'undefined') cfg.alertWindowMs = Number(payload.value2)*1000 || cfg.alertWindowMs;
          if (payload.key3 === 'historialVisibility' && payload.value3) cfg.historialVisibility = payload.value3;
          fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
          sendJSON(res, { ok: true }); return;
        }
        sendJSON(res, { ok: false, error: 'Acción desconocida' });
      } catch (e) { sendJSON(res, { ok: false, error: e.message }); }
    });
    return;
  }

  if (pathname === '/api/events' && req.method === 'GET') {
    const ev = readJSONSafe('events.json') || [];
    sendJSON(res, { ok: true, events: ev });
    return;
  }

  // Create event (POST) expects JSON body {name, desc, start, end}
  if (pathname === '/api/events' && req.method === 'POST') {
    let body = '';
    req.on('data', d=> body += d);
    req.on('end', ()=>{
      try {
        const payload = JSON.parse(body);
        const ev = readJSONSafe('events.json') || [];
        ev.push(Object.assign({ id: `ev_${Date.now()}` }, payload));
        fs.writeFileSync(path.join(__dirname,'events.json'), JSON.stringify(ev, null, 2));
        notifyClients();
        sendJSON(res, { ok: true, event: payload });
      } catch (e) { sendJSON(res, { ok: false, error: e.message }); }
    });
    return;
  }

  // Start season (POST) { name?, durationDays? }
  if (pathname === '/api/season/start' && req.method === 'POST') {
    let body = '';
    req.on('data', d=> body += d);
    req.on('end', ()=>{
      try {
        const payload = JSON.parse(body || '{}');
        const seasonsFile = path.join(__dirname,'seasons.json');
        const data = readJSONSafe('seasons.json') || { seasons: {}, current: null };
        const id = `Temporada_${Object.keys(data.seasons || {}).length + 1}`;
        const now = Date.now();
        const ends = now + (payload.durationDays || 30) * 24*3600*1000;
        data.seasons[id] = { standings: {}, started: now, ends, archived: false, name: payload.name || id, top: [] };
        data.current = id;
        fs.writeFileSync(seasonsFile, JSON.stringify(data, null, 2));
        notifyClients();
        sendJSON(res, { ok: true, id });
      } catch (e) { sendJSON(res, { ok: false, error: e.message }); }
    });
    return;
  }

  // End season (POST) - will set ends to now so bot will close on next check
  if (pathname === '/api/season/end' && req.method === 'POST') {
    try {
      const seasonsFile = path.join(__dirname,'seasons.json');
      const data = readJSONSafe('seasons.json') || { seasons: {}, current: null };
      if (!data.current) return sendJSON(res, { ok: false, error: 'No active season' });
      const id = data.current;
      if (data.seasons && data.seasons[id]) {
        data.seasons[id].ends = Date.now() - 1000;
      }
      data.current = null;
      fs.writeFileSync(seasonsFile, JSON.stringify(data, null, 2));
      notifyClients();
      sendJSON(res, { ok: true, finished: id });
    } catch (e) { sendJSON(res, { ok: false, error: e.message }); }
    return;
  }

  res.writeHead(404); res.end('Not Found');
});

function notifyClients() {
  const top = readJSONSafe('usuarios.json') || {};
  const seasons = readJSONSafe('seasons.json') || { seasons: {}, current: null };
  const payload = JSON.stringify({ time: Date.now(), users: Object.keys(top).length, seasons });
  for (const c of clients) {
    try { c.write(`data: ${payload}\n\n`); } catch (e) {}
  }
}

// Periodic notify
setInterval(()=> notifyClients(), 5000);

// Try to listen on the desired port; if in use try next ports automatically
function attemptListen(port, attempts = 20) {
  server.once('error', (err) => {
    if (err && err.code === 'EADDRINUSE' && attempts > 0) {
      console.warn(`Port ${port} in use, trying ${port + 1}...`);
      setTimeout(() => attemptListen(port + 1, attempts - 1), 200);
    } else {
      console.error('Server error:', err);
      process.exit(1);
    }
  });
  server.once('listening', () => {
    console.log(`Web UI listening on http://localhost:${port}`);
  });
  try {
    server.listen(port);
  } catch (e) {
    console.error('Listen failed:', e.message);
  }
}

const startPort = parseInt(process.env.PORT || '3000', 10) || 3000;
attemptListen(startPort, 20);
