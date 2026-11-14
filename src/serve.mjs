import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {createSource} from './source.mjs';
import {createAgent} from './agent.mjs';
import {json} from './client.mjs';

function readBody(request, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let text = '';
    request.on('data', chunk => {
      text += chunk;
      if (text.length > limit) {
        reject(Object.assign(new Error('请求体过大'), {status: 413}));
        request.destroy();
      }
    });
    request.on('end', () => {
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error('JSON无效'), {status: 400}));
      }
    });
    request.on('error', reject);
  });
}

function routeMatch(pathname) {
  const record = /^\/api\/records\/([^/]+)$/.exec(pathname);
  if (record) return {name: 'record', id: decodeURIComponent(record[1])};
  const action = /^\/api\/records\/([^/]+)\/(paste|pause|resume|recopy|acknowledge|publish)$/.exec(pathname);
  if (action) return {name: 'action', id: decodeURIComponent(action[1]), action: action[2]};
  return null;
}

export async function createService({
  host = '127.0.0.1',
  port = 0,
  sourceUrl = null,
  portalUrl = null,
  sanitizeDelay = Number(process.env.SANITIZE_DELAY ?? 100),
  recordDirectory = process.env.RECORD_DIR ?? null,
  settleTimeoutMs = Number(process.env.SETTLE_TIMEOUT_MS ?? 6000)
} = {}) {
  const source = sourceUrl ? null : await createSource();
  const origin = sourceUrl ?? source.url;
  const agent = await createAgent({
    sourceUrl: origin,
    portalUrl: portalUrl ?? `${origin}/portal.html?sanitizeDelay=${sanitizeDelay}`,
    sanitizeDelay,
    settleTimeoutMs,
    storageDirectory: recordDirectory
  });

  const events = [];
  const subscribers = new Set();
  agent.onRecord(event => {
    events.push(event);
    if (events.length > 200) events.shift();
    for (const subscriber of subscribers) {
      try {
        subscriber(event);
      } catch {}
    }
  });

  let queue = Promise.resolve();
  const serialize = task => {
    const next = queue.then(task, task);
    queue = next.catch(() => {});
    return next;
  };

  // 浏览器资源直接内置，即使来源是外部服务也能在同一处操作来源页和门户。
  const PAGES = {'/': 'agent.html', '/agent.html': 'agent.html', '/index.html': 'index.html', '/portal.html': 'portal.html', '/blank.html': 'blank.html'};
  const rewrite = (html, target) => {
    if (target === origin) return html;
    return html
      .replaceAll("fetch('/inventory'", `fetch('${origin}/inventory'`)
      .replaceAll("fetch('/control'", `fetch('${origin}/control'`);
  };

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://local.test');
      const pathname = url.pathname;
      const sendJson = (value, status = 200) => json(response, value, status);

      if (request.method === 'OPTIONS') {
        response.writeHead(204, {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type'});
        return response.end();
      }
      if (pathname === '/health') return sendJson({status: 'ok', source: origin, portal: portalUrl ?? `${origin}/portal.html`});
      if (pathname === '/inventory' || pathname === '/state') {
        const upstream = await fetch(`${origin}${pathname}`, {signal: AbortSignal.timeout(3000), cache: 'no-store'});
        return sendJson(await upstream.json(), upstream.status);
      }
      if (pathname === '/api/records' && request.method === 'GET') return sendJson({records: await agent.listRecords()});
      if (pathname === '/api/records' && request.method === 'POST') {
        const body = await readBody(request);
        const result = await serialize(() => agent.createRecord(body));
        return sendJson(result, result.ok ? 201 : 409);
      }
      if (pathname === '/api/events') {
        response.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive'});
        const send = event => response.write(`data: ${JSON.stringify(event)}\n\n`);
        for (const event of events.slice(-20)) send(event);
        const subscriber = event => send(event);
        subscribers.add(subscriber);
        const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 15000);
        request.on('close', () => {
          clearInterval(heartbeat);
          subscribers.delete(subscriber);
        });
        return;
      }
      const match = routeMatch(pathname);
      if (match?.name === 'record' && request.method === 'GET') {
        const value = await agent.getRecord(match.id);
        return sendJson(value);
      }
      if (match?.name === 'action' && request.method === 'POST') {
        const body = await readBody(request);
        const result = await serialize(() => {
          if (match.action === 'paste') {
            if (body.settleTimeoutMs !== undefined) body.settleTimeoutMs = Number(body.settleTimeoutMs);
            return agent.paste(match.id, body);
          }
          if (match.action === 'pause') return agent.pause(match.id, body);
          if (match.action === 'resume') return agent.resume(match.id, body);
          if (match.action === 'recopy') return agent.recopy(match.id);
          if (match.action === 'acknowledge') return agent.acknowledge(match.id, body);
          if (match.action === 'publish') return agent.publish(match.id);
        });
        return sendJson(result, 200);
      }
      if (pathname === '/api/clipboard' && request.method === 'GET') {
        return sendJson(await serialize(() => agent.readClipboard()));
      }
      if (pathname === '/api/clipboard/clear' && request.method === 'POST') {
        return sendJson(await serialize(() => agent.clearClipboard()));
      }
      if (Object.hasOwn(PAGES, pathname) && (request.method === 'GET' || request.method === 'HEAD')) {
        const html = rewrite(await readFile(new URL('../public/' + PAGES[pathname], import.meta.url), 'utf8'), origin);
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        return response.end(html);
      }
      return json(response, {error: '资源不存在'}, 404);
    } catch (error) {
      if (!response.headersSent) json(response, {error: error.message, code: error.code ?? null}, error.status ?? 500);
      else response.destroy();
    }
  });

  await new Promise(resolve => server.listen(port, host, resolve));
  const listening = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${server.address().port}`;
  return {
    url: listening,
    sourceUrl: origin,
    portalUrl: portalUrl ?? `${origin}/portal.html`,
    agent,
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await agent.close();
      if (source) await source.close();
    }
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const service = await createService({
    host: process.env.HOST ?? '127.0.0.1',
    port: Number(process.env.PORT ?? 0),
    sanitizeDelay: Number(process.env.SANITIZE_DELAY ?? 100),
    recordDirectory: process.env.RECORD_DIR ?? null,
    settleTimeoutMs: Number(process.env.SETTLE_TIMEOUT_MS ?? 6000),
    sourceUrl: process.env.SOURCE_URL ?? null,
    portalUrl: process.env.PORTAL_URL ?? null
  });
  console.log(JSON.stringify({service: service.url, source: service.sourceUrl, portal: service.portalUrl, status: '机器人服务就绪'}));
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await service.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
