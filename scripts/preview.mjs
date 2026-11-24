/**
 * preview.mjs — serves ./public on http://localhost:8080 so you can look at the
 * page before deploying. No dependencies.
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, resolve, normalize } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..', 'public')
const PORT = Number(process.env.PORT) || 8080

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  let rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '')
  if (rel === '' || rel === '.') rel = 'index.html'
  const file = join(ROOT, rel)
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden')
    return
  }
  try {
    const body = await readFile(file)
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found: ' + rel)
  }
}).listen(PORT, () => console.log('preview → http://localhost:' + PORT))