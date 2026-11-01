import { SceneManager } from '../three/SceneManager';
import type { Deck } from '../types';
import { getDeck, getDeckCover, putDeckCover, type DeckCover, type DeckSummary } from './storage';

const COVER_WIDTH = 480;
const COVER_HEIGHT = 270;

/** 串行队列：同一时间只创建一个离屏 WebGL 上下文，避免浏览器上下文超限 */
let queue: Promise<unknown> = Promise.resolve();

async function renderCover(deck: Deck): Promise<string> {
  const container = document.createElement('div');
  container.style.cssText = `position:fixed;left:-10000px;top:0;width:${COVER_WIDTH}px;height:${COVER_HEIGHT}px;overflow:hidden;pointer-events:none;`;
  document.body.appendChild(container);
  const manager = new SceneManager(
    container,
    deck.background,
    deck.frames[0]?.view ?? deck.lastView,
    'view',
    { onImageError: () => {} },
    { autoStart: false, preserveDrawingBuffer: true },
  );
  try {
    manager.sync(deck, [], 'view');
    return await manager.captureImage(COVER_WIDTH, COVER_HEIGHT, 8000);
  } finally {
    manager.dispose();
    container.remove();
  }
}

async function generate(summary: DeckSummary): Promise<DeckCover | null> {
  if (summary.broken || summary.objectCount === 0) return null;
  const cached = await getDeckCover(summary.id);
  if (cached && cached.deckUpdatedAt === summary.updatedAt && cached.dataUrl) return cached;
  const deck = await getDeck(summary.id);
  if (!deck || deck.updatedAt !== summary.updatedAt || deck.objects.length === 0) return null;
  const dataUrl = await renderCover(deck);
  const cover: DeckCover = {
    id: deck.id,
    dataUrl,
    deckUpdatedAt: deck.updatedAt,
    at: Date.now(),
  };
  await putDeckCover(cover);
  return cover;
}

/** 读取或后台生成作品封面；失败返回 null，由首页回退到 DOM 拼装缩略图 */
export function ensureDeckCover(
  summary: DeckSummary,
  cached?: DeckCover | null,
): Promise<DeckCover | null> {
  if (summary.broken || summary.objectCount === 0) return Promise.resolve(null);
  if (cached && cached.deckUpdatedAt === summary.updatedAt && cached.dataUrl) {
    return Promise.resolve(cached);
  }
  const job = queue.then(() => generate(summary));
  queue = job.catch(() => null);
  return job.catch(() => null);
}
