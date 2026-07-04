import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const VENDOR_SRC = join(ROOT, 'vendor');
const DIST_VENDOR = join(ROOT, 'dist', 'vendor');

// markdown-it + DOMPurify 从 node_modules 复制
const NPM_FILES = [
  ['node_modules/markdown-it/dist/markdown-it.min.js', 'markdown-it.min.js'],
  ['node_modules/dompurify/dist/purify.min.js', 'purify.min.js'],
];

async function main() {
  // 初始化目录
  await mkdir(DIST_VENDOR, { recursive: true });

  // 复制 npm 包中的浏览器 bundle
  for (const [src, dest] of NPM_FILES) {
    const srcPath = join(ROOT, src);
    const destPath = join(DIST_VENDOR, dest);
    await cp(srcPath, destPath);
    console.log(`  ✓ ${src} → vendor/${dest}`);
  }

  // highlight.js: 从 CDN 下载（优先使用本地 vendor 目录中的缓存）
  const hljsFile = 'highlight.min.js';
  const hljsDest = join(DIST_VENDOR, hljsFile);
  const hljsCache = join(VENDOR_SRC, hljsFile);

  if (existsSync(hljsCache)) {
    await cp(hljsCache, hljsDest);
    console.log(`  ✓ vendor/${hljsFile} (cached)`);
  } else {
    const url = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js';
    console.log(`  ↓ Downloading highlight.js from CDN...`);
    try {
      const rsp = await fetch(url);
      if (!rsp.ok) throw new Error(`HTTP ${rsp.status}`);
      const buf = Buffer.from(await rsp.arrayBuffer());
      await writeFile(hljsDest, buf);
      await mkdir(VENDOR_SRC, { recursive: true });
      await writeFile(hljsCache, buf);
      console.log(`  ✓ vendor/${hljsFile} (downloaded + cached)`);
    } catch {
      console.warn(`  ⚠ highlight.js download failed (${url}), syntax highlighting disabled`);
      // 最小 stub：所有 markdown 功能正常，仅代码块无语法高亮
      const stub = 'window.hljs={getLanguage(){return null},highlight(o){return{value:o.value}},registerLanguage(){}};';
      await writeFile(hljsDest, stub);
    }
  }
}

main().catch(err => {
  console.error('vendor copy failed:', err);
  process.exit(1);
});
