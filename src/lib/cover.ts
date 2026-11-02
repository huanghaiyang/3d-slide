/**
 * cover.ts —— 作品封面（缩略图）的生成与缓存
 *
 * 首页作品列表需要每个作品的 16:9 预览图。本模块用独立的 SceneManager 在
 * 屏幕外渲染作品首帧视角，截图后以 data URL 存入存储层，并按作品 updatedAt
 * 判断缓存是否失效，避免每次进入首页都重复渲染。
 *
 * 关键约束：
 * - 浏览器同时可用的 WebGL 上下文数量有限，因此用串行队列（queue）保证同一时刻
 *   最多只有一个离屏渲染任务，渲染完成后立即 dispose 释放上下文；
 * - 渲染尺寸固定 480x270（16:9），足够列表展示又不会让 data URL 过大；
 * - 任何失败（作品损坏、渲染异常）都返回 null，由首页回退到 DOM 拼装缩略图。
 */

import { SceneManager } from '../three/SceneManager';
import type { Deck } from '../types';
import { getDeck, getDeckCover, putDeckCover, type DeckCover, type DeckSummary } from './storage';

/** 封面输出宽度（像素），与高度保持 16:9。 */
const COVER_WIDTH = 480;
/** 封面输出高度（像素）。 */
const COVER_HEIGHT = 270;

/** 串行队列：同一时间只创建一个离屏 WebGL 上下文，避免浏览器上下文超限 */
let queue: Promise<unknown> = Promise.resolve();

/**
 * 为一个作品实际执行离屏渲染并截图。
 *
 * 步骤：
 * 1. 创建固定尺寸、移出可视区域的容器，避免影响页面布局；
 * 2. 以作品背景色与首帧视角（无帧时用 lastView）初始化 SceneManager，
 *    关闭自动渲染循环并开启 preserveDrawingBuffer（截图读取像素所必需）；
 * 3. sync 同步作品对象（不传选中项，避免出现选中框）；
 * 4. captureImage 等待资源加载完成后导出 JPEG data URL；
 * 5. finally 中销毁渲染器并移除容器，确保 WebGL 上下文被释放。
 *
 * @param deck 已完整读取的作品数据
 * @returns 封面图片的 data URL
 */
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
    // 关闭自动渲染循环（手动 sync 后单帧截图）；preserveDrawingBuffer 保证截图时像素未被清空
    { autoStart: false, preserveDrawingBuffer: true },
  );
  try {
    // 空数组表示不选中任何对象；'view' 模式只做展示，不进入编辑交互
    manager.sync(deck, [], 'view');
    return await manager.captureImage(COVER_WIDTH, COVER_HEIGHT, 8000);
  } finally {
    // 无论成功失败都释放 WebGL 上下文并清理离屏容器
    manager.dispose();
    container.remove();
  }
}

/**
 * 读取缓存，必要时重新渲染并写回缓存（单次任务的内部实现）。
 *
 * 缓存命中条件：封面存在、deckUpdatedAt 与列表摘要的 updatedAt 一致且有 dataUrl。
 * 需要渲染时会重新读取完整 deck，并再次核对 updatedAt，防止列表摘要与数据不同步
 * 导致生成过期封面。作品损坏、空作品或读取失败时返回 null。
 *
 * @param summary 首页列表使用的作品摘要（含更新时间与对象数量）
 * @returns 有效的封面缓存；无法生成时返回 null
 */
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

/**
 * 读取或后台生成作品封面；失败返回 null，由首页回退到 DOM 拼装缩略图。
 *
 * 命中缓存时同步返回，不进入渲染队列；否则把任务追加到串行队列，确保离屏
 * WebGL 上下文不会同时创建多个。队列本身吞掉错误，保证后续任务仍能继续。
 *
 * @param summary 作品摘要
 * @param cached  调用方已经读取到的封面缓存（可选，避免重复查询存储）
 * @returns 封面数据；失败或无需封面时为 null
 */
export function ensureDeckCover(
  summary: DeckSummary,
  cached?: DeckCover | null,
): Promise<DeckCover | null> {
  if (summary.broken || summary.objectCount === 0) return Promise.resolve(null);
  if (cached && cached.deckUpdatedAt === summary.updatedAt && cached.dataUrl) {
    return Promise.resolve(cached);
  }
  const job = queue.then(() => generate(summary));
  // 队列只关心任务是否结束，不传播失败，否则一次失败会让后续任务全部中断
  queue = job.catch(() => null);
  return job.catch(() => null);
}
