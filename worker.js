// Cloudflare Worker: serves the calculator and proxies only valid Enka UID requests.
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Genshin relay is running');
    const origin = request.headers.get('Origin');
    const allowed = (env.ALLOWED_ORIGINS || 'https://muya-nakama.github.io').split(',').map(s => s.trim());
    if (origin && origin !== url.origin && !allowed.includes(origin)) return new Response('Origin not allowed', {status: 403});
    const headers = {'Content-Type': 'application/json; charset=utf-8', 'Vary': 'Origin'};
    if (origin) headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
    const json = (data, status=200, extra={}) => new Response(JSON.stringify(data), {status, headers: {...headers, ...extra}});
    if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers});
    if (request.method !== 'GET') return json({error:'Method not allowed'}, 405);
    const match = url.pathname.match(/^\/api\/uid\/(\d{9,10})$/);
    if (!match) return json({error:'Invalid UID'}, 400);
    const uid = match[1];
    const cacheKey = new Request(url.origin + '/api/uid/' + uid);
    const cached = await caches.default.match(cacheKey);
    if (cached) {
      const body = await cached.json();
      // Return the remaining lifetime, so clients do not extend the source cache.
      body.ttl = Math.max(1, Math.ceil((Number(cached.headers.get('X-Expires-At')) - Date.now()) / 1000));
      return json(body);
    }
    try {
      const upstream = await fetch('https://enka.network/api/uid/' + uid, {
        headers: {'User-Agent': 'MuyaArtifactScore/1.10 (public showcase calculator)', 'Accept':'application/json'},
        signal: AbortSignal.timeout(15000)
      });
      if (!upstream.ok) return json({error:'Enka request failed'}, upstream.status, upstream.status===429?{'Retry-After':upstream.headers.get('Retry-After')||'60'}:{});
      const data = await upstream.json();
      if (!data.playerInfo || (data.avatarInfoList && !Array.isArray(data.avatarInfoList))) return json({error:'Invalid Enka response'}, 502);
      const ttl = Math.max(1, Math.min(86400, Number(data.ttl)||60));
      // Profile ownership and account associations are unnecessary for scoring.
      const body = {playerInfo:{nickname:data.playerInfo.nickname,level:data.playerInfo.level},avatarInfoList:data.avatarInfoList||[],ttl,uid};
      const stored = new Response(JSON.stringify(body), {headers:{'Content-Type':'application/json','Cache-Control':'public, max-age='+ttl,'X-Expires-At':String(Date.now()+ttl*1000)}});
      ctx.waitUntil(caches.default.put(cacheKey, stored));
      return json(body);
    } catch {return json({error:'Enka timeout or network error'}, 502);}
  }
};
