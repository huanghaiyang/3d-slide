/**
 * probe-font-mirror.mjs —— 测开源字体镜像的可达性
 *
 * jsDelivr 在国内经常连不上，这里对同一份 Fontsource 字体文件逐个镜像测速，
 * 用于决定 lottieText 的候选 URL 顺序。
 */
const pathOf = '@fontsource/roboto/files/roboto-latin-400-normal.woff';
const mirrors = [
  `https://cdn.jsdelivr.net/npm/${pathOf}`,
  `https://fastly.jsdelivr.net/npm/${pathOf}`,
  `https://gcore.jsdelivr.net/npm/${pathOf}`,
  `https://unpkg.com/${pathOf}`,
  `https://mirrors.cloud.tencent.com/npm/${pathOf}`,
  `https://registry.npmmirror.com/${pathOf}`,
];

for (const url of mirrors) {
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    const buffer = await response.arrayBuffer();
    console.log('OK  ', String(response.status).padEnd(4), String(Date.now() - started).padStart(5) + 'ms', String(buffer.byteLength).padStart(7), url);
  } catch (error) {
    console.log('FAIL', String(Date.now() - started).padStart(5) + 'ms', error.name + ': ' + error.message, url);
  }
}
