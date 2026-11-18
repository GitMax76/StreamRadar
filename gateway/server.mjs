import { readFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';

const radar = new URL(process.env.RADAR_ORIGIN || 'http://127.0.0.1:8080');
const manager = new URL(process.env.MANAGER_ORIGIN || 'http://127.0.0.1:8097');
const port = Number(process.env.PORT || 8790);
const routes = new Map([['radar', radar], ['manager', manager]]);
const staticHeaders = {
  'Cache-Control': 'no-cache',
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff'
};
const manifest = JSON.stringify({
  id: '/', name: 'StreamSuite', short_name: 'StreamSuite', lang: 'it',
  start_url: '/', scope: '/', display: 'standalone',
  theme_color: '#10151c', background_color: '#10151c',
  icons: [
    { src: '/radar/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/radar/icon-512.png', sizes: '512x512', type: 'image/png' }
  ]
});
const staticFiles = new Map([
  ['/', ['text/html; charset=utf-8', await readFile(new URL('./index.html', import.meta.url))]],
  ['/suite.css', ['text/css; charset=utf-8', await readFile(new URL('./suite.css', import.meta.url))]],
  ['/manifest.webmanifest', ['application/manifest+json; charset=utf-8', manifest]]
]);

function proxy(incoming, outgoing, target, path, area) {
  const requestHeaders = ['accept', 'content-type', 'content-length'];
  if (area === 'manager') requestHeaders.push('authorization');
  const headers = Object.fromEntries(requestHeaders
    .filter(name => incoming.headers[name] !== undefined)
    .map(name => [name, incoming.headers[name]]));
  const upstream = request({
    hostname: target.hostname, port: target.port, method: incoming.method, path, headers,
    timeout: 120_000
  }, reply => {
    const responseHeaders = {};
    for (const name of ['content-type', 'content-length', 'cache-control', 'www-authenticate',
      'content-security-policy', 'x-content-type-options', 'referrer-policy', 'location', 'allow']) {
      if (reply.headers[name] !== undefined) responseHeaders[name] = reply.headers[name];
    }
    outgoing.writeHead(reply.statusCode, responseHeaders);
    reply.on('error', () => outgoing.destroy());
    reply.pipe(outgoing);
  });
  upstream.on('timeout', () => upstream.destroy());
  upstream.on('error', () => {
    if (outgoing.headersSent) return outgoing.destroy();
    outgoing.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    outgoing.end(JSON.stringify({ error: 'Servizio temporaneamente non raggiungibile.' }));
  });
  outgoing.on('close', () => {
    if (!outgoing.writableFinished) upstream.destroy();
  });
  incoming.pipe(upstream);
}

createServer((incoming, outgoing) => {
  const queryStart = incoming.url.indexOf('?');
  const path = queryStart < 0 ? incoming.url : incoming.url.slice(0, queryStart);
  const query = queryStart < 0 ? '' : incoming.url.slice(queryStart);
  const staticFile = staticFiles.get(path);
  if (staticFile && ['GET', 'HEAD'].includes(incoming.method)) {
    const [type, body] = staticFile;
    outgoing.writeHead(200, { ...staticHeaders, 'Content-Type': type });
    return outgoing.end(incoming.method === 'HEAD' ? undefined : body);
  }
  const match = /^\/(radar|manager)(\/[^\\]*)?$/.exec(path);
  if (!match) {
    outgoing.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return outgoing.end('Pagina inesistente');
  }
  const [, area, suffix] = match;
  if (!suffix && ['GET', 'HEAD'].includes(incoming.method)) {
    outgoing.writeHead(308, { Location: `/${area}/${query}` });
    return outgoing.end();
  }
  const forwardQuery = area === 'radar' ? query : '';
  proxy(incoming, outgoing, routes.get(area), (suffix || '/') + forwardQuery, area);
}).listen(port, process.env.BIND_IP || '0.0.0.0', () => console.log(`StreamSuite in ascolto sulla porta ${port}`));
