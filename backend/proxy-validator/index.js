'use strict';

const http = require('node:http');
const { assertSandboxCompliant } = require('./validate');

const DEFAULT_LISTEN_PORT = 2376;
const DEFAULT_UPSTREAM_HOST = 'socket-proxy';
const DEFAULT_UPSTREAM_PORT = 2375;

function normalizedDockerPath(rawUrl) {
  const pathname = new URL(rawUrl, 'http://proxy-validator').pathname;
  const withoutVersion = pathname.replace(/^\/v\d+(?:\.\d+)?(?=\/)/, '');
  return withoutVersion.length > 1 ? withoutVersion.replace(/\/+$/, '') : withoutVersion;
}

const CONTAINER_ID = '[a-f0-9]{64}';
const LIFECYCLE_ACTION = '(?:start|stop|kill|remove|attach|resize)';
const LIFECYCLE_PATH = new RegExp(`^/containers/${CONTAINER_ID}/${LIFECYCLE_ACTION}$`);
const REMOVE_PATH = new RegExp(`^/containers/${CONTAINER_ID}$`);

function isAllowedPassThrough(method, path) {
  if (method === 'GET' || method === 'HEAD') return true;
  if (method === 'POST' && LIFECYCLE_PATH.test(path)) return true;
  return method === 'DELETE' && REMOVE_PATH.test(path);
}

function send(res, statusCode, message) {
  const body = Buffer.from(`${message}\n`);
  res.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': body.length,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('aborted', () => reject(new Error('client aborted request')));
    req.on('error', reject);
  });
}

function forward(req, res, options, body) {
  const upstreamReq = http.request({
    host: options.upstreamHost,
    port: options.upstreamPort,
    method: req.method,
    path: req.url,
    headers: req.headers,
  }, (upstreamRes) => {
    res.writeHead(
      upstreamRes.statusCode || 502,
      upstreamRes.statusMessage,
      upstreamRes.headers,
    );
    upstreamRes.pipe(res);
  });

  upstreamReq.on('error', () => {
    if (res.headersSent) {
      res.destroy();
    } else {
      send(res, 502, 'Bad Gateway');
    }
  });

  req.on('aborted', () => upstreamReq.destroy());

  if (body !== undefined) {
    upstreamReq.end(body);
  } else {
    req.pipe(upstreamReq);
  }
}

function createProxyServer({
  upstreamHost = process.env.DOCKER_UPSTREAM_HOST || DEFAULT_UPSTREAM_HOST,
  upstreamPort = Number(process.env.DOCKER_UPSTREAM_PORT || DEFAULT_UPSTREAM_PORT),
} = {}) {
  const options = { upstreamHost, upstreamPort };

  return http.createServer(async (req, res) => {
    let path;
    try {
      path = normalizedDockerPath(req.url || '/');
    } catch {
      send(res, 400, 'Bad Request');
      return;
    }

    if (req.method === 'POST' && (path === '/images/create' || path === '/build')) {
      req.resume();
      send(res, 403, 'Forbidden');
      return;
    }

    if (req.method === 'POST' && path === '/containers/create') {
      try {
        const rawBody = await readBody(req);
        const createBody = JSON.parse(rawBody.toString('utf8'));
        assertSandboxCompliant(createBody);
        forward(req, res, options, rawBody);
      } catch {
        if (!res.headersSent) send(res, 403, 'Forbidden');
      }
      return;
    }

    if (!isAllowedPassThrough(req.method, path)) {
      req.resume();
      send(res, 403, 'Forbidden');
      return;
    }

    forward(req, res, options);
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || DEFAULT_LISTEN_PORT);
  const server = createProxyServer();
  server.listen(port, '0.0.0.0', () => {
    process.stdout.write(`proxy-validator listening on ${port}\n`);
  });
}

module.exports = { createProxyServer };
