// Local server for the editor: serves the web app, imports and streams media,
// stores the project, and runs exports. Listens on loopback only.

import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { ExportQueue } from './exporter.js';
import { MediaStore } from './media.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 5175);
const DATA_DIR = path.resolve(process.env.VID_DATA_DIR || path.join(ROOT, 'data'));
const PROJECT_FILE = path.join(DATA_DIR, 'project.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
};

const media = new MediaStore(DATA_DIR);
const exportsQueue = new ExportQueue(DATA_DIR, media);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
  res.end(text);
}

async function readJson(req, limit = 20 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

// Serve a file with byte-range support, which <video> needs for seeking.
async function sendFile(req, res, filePath, { cache = 'no-cache', type = null } = {}) {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) throw new HttpError(404, 'Not found');
  const headers = {
    'Content-Type': type || MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': cache,
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  let start = 0;
  let end = stat.size - 1;
  let status = 200;
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(end, Number(range[2]));
    } else {
      start = Math.max(0, stat.size - Number(range[2]));
    }
    if (start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || stat.size === 0) {
    res.end();
    return;
  }
  await pipeline(createReadStream(filePath, { start, end }), res).catch(() => {});
}

function staticPath(urlPath) {
  const relative = urlPath === '/' ? '/index.html' : urlPath;
  const base = relative.startsWith('/shared/') ? ROOT : path.join(ROOT, 'web');
  const resolved = path.resolve(base, `.${relative}`);
  if (!resolved.startsWith(base + path.sep)) throw new HttpError(403, 'Forbidden');
  return resolved;
}

// Reject cross-site writes: another web page must not be able to drive imports.
function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  const allowed = [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`];
  if (!allowed.includes(origin)) throw new HttpError(403, 'Cross-origin request refused');
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = decodeURIComponent(url.pathname);
  const method = req.method;
  if (method !== 'GET' && method !== 'HEAD') checkOrigin(req);

  if (route === '/api/project') {
    if (method === 'GET') {
      const text = await fs.readFile(PROJECT_FILE, 'utf8').catch(() => null);
      return sendJson(res, 200, { project: text ? JSON.parse(text) : null });
    }
    if (method === 'PUT') {
      const { project } = await readJson(req);
      if (!project || !Array.isArray(project.tracks)) throw new HttpError(400, 'Not a project');
      await fs.writeFile(`${PROJECT_FILE}.tmp`, JSON.stringify(project, null, 2));
      await fs.rename(`${PROJECT_FILE}.tmp`, PROJECT_FILE);
      return sendJson(res, 200, { ok: true });
    }
  }

  if (route === '/api/import' && method === 'POST') {
    const body = await readJson(req);
    const filePath = String(body.path || '').trim().replace(/^"(.*)"$/, '$1');
    if (!filePath) throw new HttpError(400, 'No path given');
    return sendJson(res, 200, { media: await media.importFile(filePath).catch((e) => { throw new HttpError(422, e.message); }) });
  }

  if (route === '/api/upload' && method === 'POST') {
    const target = media.uploadTarget(url.searchParams.get('name') || 'upload.bin');
    await pipeline(req, createWriteStream(target));
    try {
      return sendJson(res, 200, { media: await media.importFile(target) });
    } catch (error) {
      await fs.rm(target, { force: true });
      throw new HttpError(422, error.message);
    }
  }

  let match = /^\/api\/proxy\/([\w]+)$/.exec(route);
  if (match && method === 'POST') {
    if (!media.get(match[1])) throw new HttpError(404, 'Unknown media');
    return sendJson(res, 200, { media: await media.buildProxy(match[1]) });
  }

  match = /^\/media\/([\w]+)$/.exec(route);
  if (match) {
    const filePath = await media.playablePath(match[1]);
    if (!filePath) throw new HttpError(404, 'Unknown media');
    return sendFile(req, res, filePath);
  }

  match = /^\/thumb\/([\w]+)$/.exec(route);
  if (match) return sendFile(req, res, media.thumbPath(match[1]), { cache: 'max-age=3600' });

  if (route === '/api/export' && method === 'POST') {
    const { project } = await readJson(req);
    if (!project || !Array.isArray(project.tracks)) throw new HttpError(400, 'Not a project');
    const job = await exportsQueue.start(project).catch((e) => { throw new HttpError(422, e.message); });
    return sendJson(res, 200, { job });
  }

  match = /^\/api\/export\/([\w]+)$/.exec(route);
  if (match && method === 'GET') {
    const job = exportsQueue.get(match[1]);
    if (!job) throw new HttpError(404, 'Unknown export');
    return sendJson(res, 200, { job });
  }

  match = /^\/exports\/([^/\\]+\.mp4)$/.exec(route);
  if (match) return sendFile(req, res, path.join(exportsQueue.dir, match[1]));

  if (method === 'GET' || method === 'HEAD') return sendFile(req, res, staticPath(route));
  throw new HttpError(404, 'Not found');
}

await fs.mkdir(DATA_DIR, { recursive: true });
await media.init();

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    const status = error.status || 500;
    if (status === 500) console.error(error);
    if (res.headersSent) res.destroy();
    else sendJson(res, status, { error: error.message });
  });
});
server.requestTimeout = 0;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`vid editor running at http://127.0.0.1:${PORT}`);
});
