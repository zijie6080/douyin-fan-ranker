// 生成简单的品牌色圆角方块图标（16/48/128），无第三方依赖。
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(resolve(root, 'icons'), { recursive: true });

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function png(size) {
  const [r, g, b] = [0xfe, 0x2c, 0x55]; // 品牌红
  const radius = size * 0.22;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter byte
    for (let x = 0; x < size; x++) {
      // 圆角遮罩
      const inCorner = (cx, cy) => Math.hypot(x - cx, y - cy) > radius;
      let alpha = 255;
      if (x < radius && y < radius && inCorner(radius, radius)) alpha = 0;
      else if (x > size - radius && y < radius && inCorner(size - radius, radius)) alpha = 0;
      else if (x < radius && y > size - radius && inCorner(radius, size - radius)) alpha = 0;
      else if (x > size - radius && y > size - radius && inCorner(size - radius, size - radius)) alpha = 0;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = alpha;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

for (const size of [16, 48, 128]) {
  writeFileSync(resolve(root, `icons/icon${size}.png`), png(size));
}
console.log('icons generated: 16/48/128');
