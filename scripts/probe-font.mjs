import opentype from 'opentype.js';

// 探测：开源字体 CDN（Fontsource / jsDelivr）的 woff 能否被 opentype 解析，
// 并给出字形轮廓命令数，用于确认文本图层展开方案的可行性。
const urls = [
  'https://cdn.jsdelivr.net/npm/@fontsource/roboto/files/roboto-latin-400-normal.woff',
  'https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-sc/files/noto-sans-sc-chinese-simplified-400-normal.woff',
  'https://cdn.jsdelivr.net/npm/@fontsource/inter/files/inter-latin-400-normal.woff',
];

for (const url of urls) {
  try {
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    const font = opentype.parse(buffer);
    const path = font.getPath('Hello 世界', 0, 0, 100);
    console.log(
      url,
      'status=' + response.status,
      'bytes=' + buffer.byteLength,
      'family=' + (font.names.fontFamily?.en ?? '?'),
      'glyphs=' + font.numGlyphs,
      'advanceA=' + font.getAdvanceWidth('A', 100).toFixed(1),
      'commands=' + path.commands.length,
      'ascent=' + font.ascender,
      'descender=' + font.descender,
    );
  } catch (error) {
    console.log(url, 'ERR', error.message);
  }
}
