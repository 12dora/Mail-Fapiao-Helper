#!/usr/bin/env node
/**
 * 渲染层打包：gui-design/src/main.tsx -> gui-design/dist/app.js + app.css。
 *
 * - `--production`：压缩、不产出 sourcemap，用于 pack / dist。
 * - `--watch`：开发模式增量重建。
 * 只用本地 node_modules，构建过程不联网、不下载任何资源。
 */
import esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const production = argv.includes('--production');
const watch = argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  absWorkingDir: root,
  entryPoints: [path.join(root, 'gui-design', 'src', 'main.tsx')],
  outfile: path.join(root, 'gui-design', 'dist', 'app.js'),
  bundle: true,
  format: 'iife',
  target: ['chrome130'],
  platform: 'browser',
  jsx: 'automatic',
  charset: 'utf8',
  legalComments: 'none',
  define: {
    'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development'),
  },
  loader: {
    '.svg': 'dataurl',
    '.png': 'dataurl',
    '.woff2': 'dataurl',
  },
  minify: production,
  sourcemap: production ? false : 'linked',
  logLevel: 'info',
  metafile: false,
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[build-renderer] watching gui-design/src …');
} else {
  await esbuild.build(options);
  console.log(`[build-renderer] built gui-design/dist/app.js (${production ? 'production' : 'development'})`);
}
