/**
 * test-lottie-text.mjs —— 在 node 侧验证文本图层展开（不依赖浏览器）
 *
 * 流程：用 vite 把 src/lib/lottieText.ts 打包成 ESM → 构造一份含拉丁与中文
 * 文本图层的 Lottie → 先确认「未预取字体时全部跳过」→ 预取字体后再展开 →
 * 统计轮廓/顶点数量并写出展开后的 JSON（可交给 Rust 端 check 脚本继续验证）。
 */
import { build } from 'vite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, '.tmp-text');

await build({
  root,
  configFile: false,
  logLevel: 'warn',
  build: {
    outDir,
    emptyOutDir: true,
    minify: false,
    target: 'node18',
    lib: { entry: path.join(root, 'src/lib/lottieText.ts'), formats: ['es'], fileName: 'lottieText' },
  },
});

const modulePath = path.join(outDir, 'lottieText.js');
const { prepareLottieFonts, expandLottieText } = await import(pathToUrl(modulePath));

function pathToUrl(p) {
  return new URL(`file://${p.replace(/\\/g, '/')}`).href;
}

// 屏幕坐标系（y 向下）的文本层：第一行基线为图层原点
function textLayer(ind, name, text, family, fontName, size, color, p) {
  return {
    ddd: 0,
    ind,
    ty: 5,
    nm: name,
    sr: 1,
    ks: {
      o: { a: 0, k: 100 },
      r: { a: 0, k: 0 },
      p: { a: 0, k: p },
      a: { a: 0, k: [0, 0, 0] },
      s: { a: 0, k: [100, 100, 100] },
    },
    ao: 0,
    t: {
      d: {
        k: [
          {
            s: { s: size, f: fontName, t: text, j: 0, tr: 0, lh: size * 1.25, ls: 0, fc: color },
            t: 0,
          },
        ],
      },
      p: {},
      m: { g: 1, a: { a: 0, k: [0, 0] } },
      a: [],
    },
    ip: 0,
    op: 120,
    st: 0,
    bm: 0,
  };
}

const document = {
  v: '5.7.4',
  fr: 30,
  ip: 0,
  op: 120,
  w: 800,
  h: 400,
  nm: 'text-demo',
  ddd: 0,
  assets: [],
  fonts: {
    list: [
      { fName: 'Roboto', fFamily: 'Roboto', fStyle: 'Regular', ascent: 75 },
      { fName: 'NotoSansSC', fFamily: 'Noto Sans SC', fStyle: 'Regular', ascent: 75 },
      { fName: 'Inter', fFamily: 'Inter', fStyle: 'Bold', ascent: 75 },
    ],
  },
  layers: [
    textLayer(1, 'Latin', 'Hello Shader', 'Roboto', 'Roboto', 72, [1, 0.45, 0.2], [90, 130, 0]),
    textLayer(2, 'Chinese', '文 本 图 层', 'Noto Sans SC', 'NotoSansSC', 64, [0.35, 0.85, 1], [90, 260, 0]),
    textLayer(3, 'Bold', 'BOLD FACE', 'Inter', 'Inter', 56, [1, 1, 1], [90, 350, 0]),
  ],
};

const before = expandLottieText(structuredClone(document));
console.log('未预取字体：', { expanded: before.expanded, skipped: before.skipped, messages: before.messages });

const fonts = await prepareLottieFonts(document);
console.log('字体预取：', fonts);

const report = expandLottieText(document);
console.log('展开结果：', { expanded: report.expanded, skipped: report.skipped, messages: report.messages });

let shapes = 0;
let vertices = 0;
let minX = Infinity;
let minY = Infinity;
let maxX = -Infinity;
let maxY = -Infinity;
for (const layer of report.document.layers) {
  if (layer.ty !== 4 || !Array.isArray(layer.shapes)) continue;
  for (const group of layer.shapes) {
    for (const item of group.it ?? []) {
      if (item.ty !== 'sh') continue;
      shapes += 1;
      const k = item.ks.k;
      vertices += k.v.length;
      for (const [x, y] of k.v) {
        const ox = layer.ks.p.k[0];
        const oy = layer.ks.p.k[1];
        minX = Math.min(minX, x + ox);
        maxX = Math.max(maxX, x + ox);
        minY = Math.min(minY, y + oy);
        maxY = Math.max(maxY, y + oy);
      }
    }
  }
}
console.log('几何统计：', {
  paths: shapes,
  vertices,
  bbox: [minX, minY, maxX, maxY].map((v) => Math.round(v * 10) / 10),
});

await mkdir(outDir, { recursive: true });
const file = path.join(outDir, 'text-demo-expanded.json');
await writeFile(file, JSON.stringify(report.document));
console.log('已写出', file, JSON.stringify(report.document).length, 'bytes');

// 同时把「未展开」的原始文本动画写到 public，浏览器实测走完整链路（下载字体→展开→GPU）
const publicFile = path.join(root, 'public', 'text-demo.json');
await writeFile(publicFile, JSON.stringify(document));
console.log('已写出', publicFile, JSON.stringify(document).length, 'bytes');

// 顺带记录第一层的原始 ks，方便核对坐标是否落在画布内
const raw = JSON.parse(await readFile(file, 'utf8'));
console.log('layers:', raw.layers.map((l) => `${l.nm}:ty=${l.ty}`).join(', '));
