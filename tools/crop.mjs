/**
 * crop.mjs — crop a PNG to a rectangle, with no dependencies.
 *
 * Node ships zlib, which is all a PNG needs: inflate the image data, undo the
 * per-row filters, copy the pixels you want, then deflate them again.
 *
 *   node tools/crop.mjs in.png out.png 1200 630 [x] [y]
 *
 * Supports the 8-bit non-interlaced PNGs a browser screenshot produces
 * (greyscale, RGB, RGBA). Output is always 8-bit RGBA.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { inflateSync, deflateSync } from 'node:zlib'

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/* ---------------------------------------------------------------- CRC32 */
const CRC = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return (buf) => {
    let c = -1
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    return (c ^ -1) >>> 0
  }
})()

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(CRC(body))
  return Buffer.concat([len, body, crc])
}

/* ---------------------------------------------------------------- decode */
function decode(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG')
  let off = 8
  let ihdr = null
  const idat = []
  let palette = null
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.subarray(off + 4, off + 8).toString('ascii')
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colour: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      }
    } else if (type === 'PLTE') palette = Buffer.from(data)
    else if (type === 'IDAT') idat.push(Buffer.from(data))
    else if (type === 'IEND') break
    off += 12 + len
  }
  if (!ihdr) throw new Error('no IHDR')
  if (ihdr.depth !== 8) throw new Error('only 8-bit PNGs: got depth ' + ihdr.depth)
  if (ihdr.interlace !== 0) throw new Error('interlaced PNGs not supported')

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.colour]
  if (!channels) throw new Error('unsupported colour type ' + ihdr.colour)

  const raw = inflateSync(Buffer.concat(idat))
  const { width, height } = ihdr
  const stride = width * channels
  const out = Buffer.alloc(stride * height)

  const paeth = (a, b, c) => {
    const p = a + b - c
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }

  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      let v = line[x]
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) v += paeth(a, b, c)
      else if (f !== 0) throw new Error('bad filter ' + f + ' on row ' + y)
      cur[x] = v & 0xff
    }
  }

  return { ...ihdr, channels, data: out, stride, palette }
}

/* ---------------------------------------------------------------- encode */
function encode({ width, height }, pixels) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 6   // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

/* ------------------------------------------------------------------ main */
const [inPath, outPath, wArg, hArg, xArg = '0', yArg = '0'] = process.argv.slice(2)
if (!inPath || !outPath || !wArg || !hArg) {
  console.error('usage: node tools/crop.mjs <in.png> <out.png> <width> <height> [x] [y]')
  process.exit(1)
}
const src = decode(readFileSync(inPath))
const w = Number(wArg), h = Number(hArg), x0 = Number(xArg), y0 = Number(yArg)
if (x0 + w > src.width || y0 + h > src.height) {
  throw new Error(`crop ${w}x${h}+${x0}+${y0} does not fit inside ${src.width}x${src.height}`)
}

const dst = Buffer.alloc(w * h * 4)
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const si = (y0 + y) * src.stride + (x0 + x) * src.channels
    const di = (y * w + x) * 4
    const c = src.channels
    if (c === 4) {
      src.data.copy(dst, di, si, si + 4)
    } else if (c === 3) {
      dst[di] = src.data[si]; dst[di + 1] = src.data[si + 1]; dst[di + 2] = src.data[si + 2]; dst[di + 3] = 255
    } else if (c === 1) {
      const p = src.palette ? src.palette.subarray(src.data[si] * 3, src.data[si] * 3 + 3) : null
      const v = p ? null : src.data[si]
      dst[di] = p ? p[0] : v; dst[di + 1] = p ? p[1] : v; dst[di + 2] = p ? p[2] : v; dst[di + 3] = 255
    } else {
      const v = src.data[si]; dst[di] = v; dst[di + 1] = v; dst[di + 2] = v; dst[di + 3] = src.data[si + 1]
    }
  }
}

writeFileSync(outPath, encode({ width: w, height: h }, dst))
console.log(`cropped ${src.width}x${src.height} → ${w}x${h} at ${x0},${y0} · ${outPath}`)