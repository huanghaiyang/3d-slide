/**
 * Home.tsx —— 首页（作品管理界面）
 *
 * 组件职责：
 * - 列出浏览器本地存储中的所有作品，并展示标题、修改时间、对象数与视点数；
 * - 提供新建空白作品、从内置模板创建、导入 .slide 工程文件三种入口；
 * - 支持作品的重命名与删除（删除前二次确认），以及打开资源库与产品说明；
 * - 为每个作品生成缩略图：优先使用已缓存的封面图，缺失时按对象布局即时拼装
 *   一个轻量 DOM 缩略图，并串行补齐缺失封面以便下次直接复用。
 *
 * 主要交互 / 副作用：
 * - 首次挂载与每次增删改后重新读取作品列表；
 * - 新建 / 导入 / 模板创建都会先写入存储，再通过 onOpen 跳转到编辑器；
 * - 封面生成任务用 coverJobs 去重，避免同一作品被重复计算。
 *
 * 与其他模块的关系：
 * - 列表、封面与持久化操作来自 lib/storage；
 * - 模板来自 lib/templates，导入校验与重名处理来自 lib/validate；
 * - 缩略图中的对象渲染仅为 CSS 近似，不启动 3D 渲染器，保证首页加载性能。
 */

import { useEffect, useRef, useState } from 'react';
import type { SlideObject } from '../types';
import { LIMITS } from '../lib/constants';
import { ensureDeckCover } from '../lib/cover';
import { createDeck } from '../lib/deck';
import { formatStamp } from '../lib/file';
import { formatBytes } from '../lib/image';
import {
  deleteDeck,
  getDeck,
  listDeckCovers,
  listDecks,
  putDeck,
  type DeckCover,
  type DeckSummary,
} from '../lib/storage';
import { parseSlideFile, uniqueTitle } from '../lib/validate';
import { DECK_TEMPLATES, buildTemplateDeck, type DeckTemplate } from '../lib/templates';
import { toast } from '../store/uiStore';
import { Icon } from './Icon';
import { ConfirmDialog, Modal } from './ui';

interface HomeProps {
  onOpen: (id: string) => void;
  onOpenAssets: () => void;
}

/**
 * 作品缩略图。
 *
 * 两种渲染方式：
 * 1. 有缓存封面（cover.dataUrl）时直接展示图片，性能最好；
 * 2. 没有封面时，按可见对象的世界坐标计算包围盒，等比缩放后投影成 CSS 绝对定位元素，
 *    做一张「结构示意」缩略图。图片 / SVG 用 img，媒体与模型用图标，形状与文本按样式近似。
 *
 * @param summary 作品摘要（背景色、对象列表、是否损坏等）
 * @param cover 可选的封面缓存
 */
function DeckThumb({ summary, cover }: { summary: DeckSummary; cover?: DeckCover }) {
  if (cover?.dataUrl) {
    return (
      <div className="deck-thumb" style={{ background: summary.background }}>
        <img className="deck-cover" src={cover.dataUrl} alt="" loading="lazy" decoding="async" />
        {summary.broken && <div className="thumb-broken">无法打开</div>}
      </div>
    );
  }
  // 只统计可见对象，隐藏对象不参与缩略图构图
  const objects = summary.objects.filter((object) => object.visible);
  // 用对象中心 + 宽高计算整体包围盒；初始值取正负无穷，空集合时后续会回退到 0
  const bounds = objects.reduce(
    (acc, object) => ({
      minX: Math.min(acc.minX, object.x - object.width / 2),
      maxX: Math.max(acc.maxX, object.x + object.width / 2),
      minY: Math.min(acc.minY, object.y - object.height / 2),
      maxY: Math.max(acc.maxY, object.y + object.height / 2),
    }),
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
  );
  // 横向视野至少 1600，避免只有少量小对象时被放得过大；额外 12% 留白防止贴边
  const spanX = Math.max(bounds.maxX - bounds.minX, 1600) * 1.12;
  const centerX = Number.isFinite(bounds.minX) ? (bounds.minX + bounds.maxX) / 2 : 0;
  const centerY = Number.isFinite(bounds.minY) ? (bounds.minY + bounds.maxY) / 2 : 0;
  // 缩略图按 16:9 取景，与编辑器的安全框比例保持一致
  const spanY = spanX * 0.5625;
  // 按 z 值从低到高绘制，保证缩略图中的前后遮挡关系与 3D 场景一致
  const ordered = [...objects].sort((a, b) => a.z - b.z);

  /**
   * 把对象的世界坐标换算成缩略图内的百分比定位。
   * 尺寸同样按视野比例缩放，并限制最小 2.5% / 最大 82%，避免过小不可见或撑出容器。
   */
  const place = (object: SlideObject) => {
    const width = Math.max(2.5, (object.width / spanX) * 82);
    const height = Math.max(2.5, (object.height / spanY) * 82);
    return {
      left: `${50 + ((object.x - centerX) / spanX) * 82}%`,
      top: `${50 + ((object.y - centerY) / spanY) * 82}%`,
      width: `${Math.min(width, 82)}%`,
      height: `${Math.min(height, 82)}%`,
      transform: `translate(-50%, -50%) rotate(${object.rotation}deg)`,
      opacity: object.opacity / 100,
    };
  };

  return (
    <div className="deck-thumb" style={{ background: summary.background }}>
      <div className="thumb-grid" aria-hidden="true" />
      {ordered.slice(0, 10).map((object) => {
        if (object.type === 'image' || object.type === 'svg') {
          return (
            <div className="thumb-object" key={object.id} style={place(object)}>
              <img src={object.src} alt="" />
            </div>
          );
        }
        if (object.type === 'video' || object.type === 'audio' || object.type === 'model' || object.type === 'lottie') {
          return (
            <div
              className={`thumb-object thumb-media is-${object.type}`}
              key={object.id}
              style={place(object)}
            >
              <Icon
                name={
                  object.type === 'video'
                    ? 'play'
                    : object.type === 'audio'
                      ? 'audio'
                      : object.type === 'model'
                        ? 'model'
                        : 'spark'
                }
                size={11}
              />
            </div>
          );
        }
        if (object.type === 'shape') {
          return (
            <div
              className={`thumb-object thumb-shape ${object.shape}`}
              key={object.id}
              style={{
                ...place(object),
                background: object.shape === 'line' ? 'transparent' : object.fill,
                border: object.shape === 'line' ? `${Math.max(1, (object.strokeWidth || 6) / 3)}px solid ${object.stroke ?? object.fill}` : undefined,
                borderRadius: object.shape === 'ellipse' ? '50%' : object.shape === 'line' ? 0 : 3,
              }}
            />
          );
        }
        return (
          <div className="thumb-object thumb-text" key={object.id} style={place(object)}>
            <span style={{ color: object.color }}>{object.text || '文本'}</span>
          </div>
        );
      })}
      {ordered.length === 0 && (
        <div className="thumb-empty">
          <span />
          <span />
          <span />
        </div>
      )}
      {summary.broken && <div className="thumb-broken">无法打开</div>}
    </div>
  );
}

/**
 * 首页主组件。
 *
 * @param onOpen 打开指定作品（跳转到编辑器）
 * @param onOpenAssets 打开资源库页面
 */
export function Home({ onOpen, onOpenAssets }: HomeProps) {
  const [decks, setDecks] = useState<DeckSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [covers, setCovers] = useState<Record<string, DeckCover>>({});
  const [busy, setBusy] = useState(false);
  const [renameTarget, setRenameTarget] = useState<DeckSummary | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<DeckSummary | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const coverJobs = useRef(new Set<string>());

  /**
   * 合并已缓存封面，并为缺失的作品生成新封面。
   *
   * 缓存命中条件：封面存在、有 dataUrl，且封面记录的 deckUpdatedAt 与作品 updatedAt 一致
   * （作品被修改后旧封面自动失效）。损坏作品与空作品不生成封面。
   * 生成任务逐张串行执行，避免同时创建大量离屏渲染任务拖慢首页；
   * coverJobs 记录「id:updatedAt」，防止并发刷新时同一作品重复渲染。
   */
  const generateCovers = (summaries: DeckSummary[], cached: DeckCover[]) => {
    const map: Record<string, DeckCover> = {};
    const missing: DeckSummary[] = [];
    const byId = new Map(cached.map((cover) => [cover.id, cover]));
    for (const summary of summaries) {
      const cover = byId.get(summary.id);
      if (cover && cover.dataUrl && cover.deckUpdatedAt === summary.updatedAt) {
        map[summary.id] = cover;
      } else if (!summary.broken && summary.objectCount > 0) {
        missing.push(summary);
      }
    }
    setCovers(map);
    const pending = missing.filter((summary) => !coverJobs.current.has(`${summary.id}:${summary.updatedAt}`));
    if (pending.length === 0) return;
    // 串行逐个补齐封面：后面的作品不会因为批次上限一直停留在 DOM 拼装缩略图
    void (async () => {
      for (const summary of pending) {
        const key = `${summary.id}:${summary.updatedAt}`;
        if (coverJobs.current.has(key)) continue;
        coverJobs.current.add(key);
        const cover = await ensureDeckCover(summary);
        coverJobs.current.delete(key);
        if (cover) setCovers((prev) => ({ ...prev, [cover.id]: cover }));
      }
    })();
  };

  /**
   * 读取作品列表与封面缓存。
   * 封面缓存读取失败时降级为空数组，不影响作品列表展示；
   * 列表读取失败则置空列表并记录错误、弹出提示。
   */
  const load = async () => {
    try {
      const [summaries, cached] = await Promise.all([
        listDecks(),
        listDeckCovers().catch(() => [] as DeckCover[]),
      ]);
      setLoadError(null);
      setDecks(summaries);
      generateCovers(summaries, cached);
    } catch (error) {
      const message = error instanceof Error ? error.message : '作品列表读取失败';
      setDecks([]);
      setLoadError(message);
      toast(message, 'error');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  /** 当前已有作品标题集合，用于新建 / 导入时自动去重命名。 */
  const titles = () => (decks ?? []).map((item) => item.title);

  /** 新建空白作品：自动生成不重名的标题，写入存储后直接打开编辑器。 */
  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const deck = createDeck(uniqueTitle('未命名演示', titles()));
      await putDeck(deck);
      onOpen(deck.id);
    } catch (error) {
      toast(error instanceof Error ? error.message : '新建失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  /** 从内置模板生成作品：模板 id 决定初始对象与视点，标题自动去重。 */
  const createFromTemplate = async (template: DeckTemplate) => {
    if (busy) return;
    setBusy(true);
    try {
      const deck = buildTemplateDeck(template.id, uniqueTitle(template.name, titles()));
      await putDeck(deck);
      toast(`已从「${template.name}」创建`, 'success');
      onOpen(deck.id);
    } catch (error) {
      toast(error instanceof Error ? error.message : '模板创建失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  /**
   * 导入 .slide 工程文件。
   * 先做扩展名与体积校验，再由 parseSlideFile 做结构校验与字段修正；
   * 导入时标题会自动去重，若存在被修正的字段则提示修正项数量。
   */
  const importFile = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.slide')) {
      toast('请选择 .slide 工程文件', 'error');
      return;
    }
    if (file.size > LIMITS.projectBytes) {
      toast(`工程文件超过 ${formatBytes(LIMITS.projectBytes)} 上限`, 'error');
      return;
    }
    setBusy(true);
    try {
      const text = await file.text();
      const parsed = parseSlideFile(text);
      const deck = {
        ...parsed.deck,
        title: uniqueTitle(parsed.deck.title, titles()),
        updatedAt: Date.now(),
      };
      await putDeck(deck);
      if (parsed.warnings.length > 0) {
        toast(`已导入，${parsed.warnings.length} 项内容已修正`, 'info');
      } else {
        toast('工程已导入', 'success');
      }
      onOpen(deck.id);
    } catch (error) {
      toast(error instanceof Error ? error.message : '导入失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  /** 确认重命名：重新读取完整作品再写回，避免用摘要覆盖掉对象与视点数据。 */
  const confirmRename = async () => {
    if (!renameTarget) return;
    const title = renameDraft.trim();
    if (!title) {
      toast('标题不能为空', 'error');
      return;
    }
    try {
      const deck = await getDeck(renameTarget.id);
      if (!deck) throw new Error('作品不存在');
      await putDeck({ ...deck, title: title.slice(0, LIMITS.titleChars), updatedAt: Date.now() });
      setRenameTarget(null);
      await load();
      toast('已重命名', 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : '重命名失败', 'error');
    }
  };

  /** 确认删除：从本地存储移除作品后重新拉取列表，一并清理其封面缓存展示。 */
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteDeck(deleteTarget.id);
      setDeleteTarget(null);
      await load();
      toast('作品已删除', 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : '删除失败', 'error');
    }
  };

  /** 打开作品；数据损坏（broken 有值）时提示原因而不是进入编辑器。 */
  const open = (summary: DeckSummary) => {
    if (summary.broken) {
      toast(`无法打开：${summary.broken}`, 'error');
      return;
    }
    onOpen(summary.id);
  };

  return (
    <div className="home">
      <header className="home-top">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="brand-name">3d-slide</span>
          <span className="brand-tag">空间演示</span>
        </div>
        <div className="home-actions">
          <input
            ref={importRef}
            type="file"
            accept=".slide,application/json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void importFile(file);
            }}
          />
          <button className="btn btn-ghost" disabled={busy} onClick={() => importRef.current?.click()}>
            <Icon name="upload" size={16} />
            导入
          </button>
          <button className="btn btn-ghost" onClick={onOpenAssets}>
            <Icon name="folder" size={16} />
            资源库
          </button>
          <a
            className="btn btn-ghost"
            href="docs/02-PRD-3d-slide.html"
            target="_blank"
            rel="noreferrer"
          >
            <Icon name="text" size={16} />
            产品说明
          </a>
          <button className="btn btn-primary" disabled={busy} onClick={() => void create()}>
            <Icon name="plus" size={16} />
            新建演示
          </button>
        </div>
      </header>

      <main className="home-main">
        <section className="home-hero">
          <div className="eyebrow">
            <span />
            OFFLINE · LOCAL FIRST
          </div>
          <h1>
            把内容放进同一个空间，
            <br />
            <em>用取景讲完它。</em>
          </h1>
          <p>
            所有对象都在一个连续的 3D 空间里，视点只记录相机怎么看你。编辑时的 16:9 安全框，就是演示时观众看到的画面。
          </p>
          <div className="home-facts">
            <span>
              <b>{decks?.length ?? '—'}</b> 份本地作品
            </span>
            <span>无需登录</span>
            <span>单文件 .slide 可离线带走</span>
          </div>
        </section>

        {decks !== null && !loadError && (
          <section className="deck-section template-section">
            <div className="deck-section-head">
              <h2>从模板开始</h2>
              <span>内置结构 · 一键生成对象与视点</span>
            </div>
            <div className="template-grid">
              {DECK_TEMPLATES.map((template, index) => (
                <button
                  key={template.id}
                  className="template-card"
                  disabled={busy}
                  onClick={() => void createFromTemplate(template)}
                  title={`使用「${template.name}」模板`}
                >
                  <span className="template-art" style={{ background: template.background }}>
                    <span className="template-glow" style={{ background: template.accent }} />
                    <span className="template-index">{String(index + 1).padStart(2, '0')}</span>
                    <span className="template-frame-count">{template.frameCount} 视点</span>
                  </span>
                  <span className="template-info">
                    <strong>{template.name}</strong>
                    <span>{template.description}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        {decks === null ? (
          <div className="deck-grid">
            {[0, 1, 2].map((key) => (
              <div className="deck-card deck-skeleton" key={key}>
                <div className="deck-thumb" />
                <div className="sku" />
                <div className="sku short" />
              </div>
            ))}
          </div>
        ) : loadError ? (
          <section className="home-empty">
            <div className="empty-mark" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
            <h2>无法读取本地作品</h2>
            <p>{loadError}</p>
            <div className="empty-actions">
              <button className="btn btn-ghost" disabled={busy} onClick={() => void load()}>
                <Icon name="reset" size={16} />
                重试
              </button>
            </div>
          </section>
        ) : decks.length === 0 ? (
          <section className="home-empty">
            <div className="empty-mark" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
            <h2>还没有作品</h2>
            <p>从一张空白空间开始。放好内容，捕获第一个视点，就能演示。</p>
            <div className="empty-actions">
              <button className="btn btn-primary" disabled={busy} onClick={() => void create()}>
                <Icon name="plus" size={16} />
                新建第一份演示
              </button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => importRef.current?.click()}>
                <Icon name="upload" size={16} />
                导入 .slide 文件
              </button>
            </div>
          </section>
        ) : (
          <section className="deck-section">
            <div className="deck-section-head">
              <h2>最近作品</h2>
              <span>按修改时间倒序 · {decks.length} 份</span>
            </div>
            <div className="deck-grid">
              {decks.map((summary) => (
                <article className={`deck-card ${summary.broken ? 'is-broken' : ''}`} key={summary.id}>
                  <button
                    className="deck-open"
                    onClick={() => open(summary)}
                    aria-label={summary.broken ? `${summary.title}，无法打开` : `打开 ${summary.title}`}
                  >
                    <DeckThumb summary={summary} cover={covers[summary.id]} />
                    <div className="deck-info">
                      <div className="deck-title-row">
                        <h3>{summary.title}</h3>
                        {summary.broken && <span className="broken-chip">无法打开</span>}
                        {!summary.broken && summary.frameCount > 0 && (
                          <span className="frame-chip">{summary.frameCount} 视点</span>
                        )}
                      </div>
                      <div className="deck-meta">
                        <span>{formatStamp(summary.updatedAt)}</span>
                        <span>{summary.objectCount} 个对象</span>
                        <span>{summary.frameCount} 个视点</span>
                      </div>
                    </div>
                  </button>
                  <div className="deck-card-actions">
                    <button
                      className="icon-btn"
                      aria-label="重命名"
                      title="重命名"
                      onClick={(event) => {
                        event.stopPropagation();
                        setRenameTarget(summary);
                        setRenameDraft(summary.title);
                      }}
                    >
                      <Icon name="edit" size={15} />
                    </button>
                    <button
                      className="icon-btn is-danger"
                      aria-label="删除"
                      title="删除"
                      onClick={(event) => {
                        event.stopPropagation();
                        setDeleteTarget(summary);
                      }}
                    >
                      <Icon name="trash" size={15} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}
      </main>

      <footer className="home-foot">
        <span>3d-slide · P0 MVP</span>
        <span>数据保存在当前浏览器 · 建议定期导出工程文件</span>
      </footer>

      {renameTarget && (
        <Modal
          title="重命名作品"
          eyebrow="TITLE"
          onClose={() => setRenameTarget(null)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setRenameTarget(null)}>
                取消
              </button>
              <button className="btn btn-primary" onClick={() => void confirmRename()}>
                保存
              </button>
            </>
          }
        >
          <label className="field-block">
            <span className="field-label">作品标题</span>
            <input
              className="text-input"
              autoFocus
              maxLength={LIMITS.titleChars}
              value={renameDraft}
              onChange={(event) => setRenameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void confirmRename();
              }}
            />
            <span className="field-hint">1–{LIMITS.titleChars} 个字符</span>
          </label>
        </Modal>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="删除这份作品？"
          danger
          confirmLabel="删除"
          message={
            <>
              将永久删除「<b>{deleteTarget.title}</b>」。删除后无法恢复，作品与视点路径都会被移除。
            </>
          }
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </div>
  );
}
