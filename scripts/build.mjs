// esbuild 打包 + 静态资源拷贝，产物即“可直接加载的未打包扩展” dist/。
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const watch = process.argv.includes('--watch');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const common = {
  bundle: true,
  platform: 'browser',
  target: 'chrome110',
  legalComments: 'none',
  charset: 'utf8',
  logLevel: 'info',
};

const entries = [
  { in: 'src/background/index.ts', out: 'background.js', format: 'esm' },
  { in: 'src/popup/popup.ts', out: 'popup.js', format: 'esm' },
];

function copyStatic() {
  cpSync(resolve(root, 'manifest.json'), resolve(dist, 'manifest.json'));
  cpSync(resolve(root, 'src/popup/popup.html'), resolve(dist, 'popup.html'));
  cpSync(resolve(root, 'src/popup/popup.css'), resolve(dist, 'popup.css'));
  cpSync(resolve(root, 'icons'), resolve(dist, 'icons'), { recursive: true });
}

for (const e of entries) {
  const opts = {
    ...common,
    entryPoints: [resolve(root, e.in)],
    outfile: resolve(dist, e.out),
    format: e.format,
    minify: !watch,
  };
  // eslint-disable-next-line no-await-in-loop
  await build(opts);
}
copyStatic();
console.log(`built extension -> ${dist}`);
