import { useEffect, useRef, useState } from 'react';
import type { SlideObject } from '../types';
import { LIMITS } from '../lib/constants';
import { createDeck } from '../lib/deck';
import { formatStamp } from '../lib/file';
import { formatBytes } from '../lib/image';
import { deleteDeck, getDeck, listDecks, putDeck, type DeckSummary } from '../lib/storage';
import { parseSlideFile, uniqueTitle } from '../lib/validate';
import { toast } from '../store/uiStore';
import { Icon } from './Icon';
import { ConfirmDialog, Modal } from './ui';

interface HomeProps {
  onOpen: (id: string) => void;
}

function DeckThumb({ summary }: { summary: DeckSummary }) {
  const objects = summary.objects.filter((object) => object.visible);
  const bounds = objects.reduce(
    (acc, object) => ({
      minX: Math.min(acc.minX, object.x - object.width / 2),
      maxX: Math.max(acc.maxX, object.x + object.width / 2),
      minY: Math.min(acc.minY, object.y - object.height / 2),
      maxY: Math.max(acc.maxY, object.y + object.height / 2),
    }),
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
  );
  const spanX = Math.max(bounds.maxX - bounds.minX, 1600) * 1.12;
  const centerX = Number.isFinite(bounds.minX) ? (bounds.minX + bounds.maxX) / 2 : 0;
  const centerY = Number.isFinite(bounds.minY) ? (bounds.minY + bounds.maxY) / 2 : 0;
  const spanY = spanX * 0.5625;
  const ordered = [...objects].sort((a, b) => a.z - b.z);

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
        if (object.type === 'image') {
          return (
            <div className="thumb-object" key={object.id} style={place(object)}>
              <img src={object.src} alt="" />
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

export function Home({ onOpen }: HomeProps) {
  const [decks, setDecks] = useState<DeckSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [renameTarget, setRenameTarget] = useState<DeckSummary | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<DeckSummary | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      setDecks(await listDecks());
    } catch (error) {
      setDecks([]);
      toast(error instanceof Error ? error.message : '作品列表读取失败', 'error');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const titles = () => (decks ?? []).map((item) => item.title);

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
                    <DeckThumb summary={summary} />
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
