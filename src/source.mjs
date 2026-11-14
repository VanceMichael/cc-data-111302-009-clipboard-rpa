import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {json} from './client.mjs';

const CONTROL_KEYS = new Set(['product', 'version', 'paragraph']);

function applyControl(state, body) {
  for (const key of Object.keys(body)) {
    if (!CONTROL_KEYS.has(key)) throw Object.assign(new Error(`不支持的控制字段: ${key}`), {status: 400});
  }
  const productId = body.product ?? state.product;
  const product = state.products?.[productId];
  if (!product) throw Object.assign(new Error(`未知产品: ${productId}`), {status: 400});
  if (body.version !== undefined) {
    const version = Number(body.version);
    if (!Number.isInteger(version) || version < 1) throw Object.assign(new Error('version 必须是正整数'), {status: 400});
    if (version !== product.version) {
      product.version = version;
      product.paragraphs[0] = body.paragraph ?? '更新后的外壳';
    }
  } else if (body.paragraph !== undefined) {
    product.paragraphs[0] = String(body.paragraph);
  }
  state.version = product.version;
  state.product = productId;
  return state;
}

export async function createSource({port = 0, host = '127.0.0.1', fixture} = {}) {
  const state = fixture
    ? structuredClone(fixture)
    : JSON.parse(await readFile(new URL('../fixtures/source.json', import.meta.url), 'utf8'));
  const pages = {'/index.html': 'index.html', '/': 'index.html', '/portal.html': 'portal.html', '/blank.html': 'blank.html'};
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://local.test');
      let text = '';
      for await (const chunk of request) {
        text += chunk;
        if (text.length > 8 * 1024 * 1024) {
          json(response, {error: '控制请求过大'}, 413);
          return;
        }
      }
      let body = {};
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          return json(response, {error: 'JSON无效'}, 400);
        }
      }
      if (url.pathname === '/health') return json(response, {status: 'ok'});
      if (url.pathname === '/state' || url.pathname === '/inventory') return json(response, state);
      if (url.pathname === '/control' && request.method === 'POST') {
        try {
          return json(response, applyControl(state, body));
        } catch (error) {
          return json(response, {error: error.message}, error.status ?? 400);
        }
      }
      if (Object.hasOwn(pages, url.pathname)) {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        return response.end(await readFile(new URL('../public/' + pages[url.pathname], import.meta.url)));
      }
      return json(response, {error: '资源不存在'}, 404);
    } catch (error) {
      if (!response.headersSent) json(response, {error: error.message}, 500);
      else response.destroy();
    }
  });
  await new Promise(resolve => server.listen(port, host, resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    close: async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  };
}
