import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AssetFolder, AssetKind, AssetMeta } from '../lib/assets';
import {
  ASSET_KIND_LABELS,
  ASSET_KIND_ORDER,
  folderBreadcrumb,
  folderDescendantIds,
  formatAssetSize,
  readAssetFile,
} from '../lib/assets';
import { formatStamp } from '../lib/file';
import { parseLottieSource } from '../lib/lottie';
import { formatDuration } from '../lib/media';
import { MODEL_ACCEPT } from '../lib/model3d';
import {
  deleteAssetsPermanently,
  deleteFolderRecords,
  emptyAssetTrash,
  getAssetSource,
  listAssetMetas,
  listFolders,
  putAssetMeta,
  putFolder,
  restoreAssets,
  trashAssets,
  updateAssetMeta,
} from '../lib/storage';
import { toast } from '../store/uiStore';
import type { AnimationItem } from 'lottie-web';
import { Icon } from './Icon';
import { ModelViewer } from './ModelViewer';
import { ConfirmDialog, Modal } from './ui';

type BrowserMode = 'manage' | 'pick';

interface AssetBrowserProps {
  mode: BrowserMode;
  /** 选择模式下允许插入的类型，未限定则全部 */
  kinds?: AssetKind[];
  onPick?: (asset: AssetMeta, src: string) => void;
}

type Dialog =
  | { type: 'newFolder'; parentId: string | null }
  | { type: 'renameFolder'; folder: AssetFolder }
  | { type: 'renameAsset'; asset: AssetMeta }
  | { type: 'moveAssets'; ids: string[] }
  | { type: 'deleteFolder'; folder: AssetFolder }
  | { type: 'trashAssets'; ids: string[] }
  | { type: 'deleteForever'; ids: string[] }
  | { type: 'emptyTrash' }
  | null;

const ACCEPT_ALL = `image/png,image/jpeg,image/webp,image/gif,video/*,audio/*,${MODEL_ACCEPT}`;

function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `a-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

function kindIcon(kind: AssetKind): 'image' | 'video' | 'audio' | 'model' | 'text' {
  if (kind === 'image') return 'image';
  if (kind === 'video') return 'video';
  if (kind === 'audio') return 'audio';
  if (kind === 'model') return 'model';
  return 'text';
}

function PromptDialog({
  title,
  label,
  placeholder,
  value,
  onChange,
  onCancel,
  onConfirm,
}: {
  title: string;
  label: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onCancel}>
            取消
          </button>
          <button className="btn btn-primary" onClick={onConfirm}>
            确定
          </button>
        </>
      }
    >
      <label className="field-block">
        <span className="field-label">{label}</span>
        <input
          className="text-input"
          autoFocus
          maxLength={60}
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onConfirm();
          }}
        />
      </label>
    </Modal>
  );
}

function FolderTree({
  folders,
  activeId,
  trash,
  counts,
  disabled,
  onSelect,
  onRename,
  onDelete,
}: {
  folders: AssetFolder[];
  activeId: string | null;
  trash: boolean;
  counts: Map<string, number>;
  disabled: boolean;
  onSelect: (id: string | null) => void;
  onRename: (folder: AssetFolder) => void;
  onDelete: (folder: AssetFolder) => void;
}) {
  const renderNodes = (parentId: string | null, depth: number): ReactNode[] =>
    folders
      .filter((folder) => folder.parentId === parentId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((folder) => {
        const selected = !trash && activeId === folder.id;
        return (
          <div key={folder.id}>
            <div className={`folder-row ${selected ? 'is-active' : ''}`} style={{ paddingLeft: 8 + depth * 12 }}>
              <button className="folder-main" onClick={() => onSelect(folder.id)} title={folder.name}>
                <Icon name="folder" size={14} />
                <span>{folder.name}</span>
                <small>{counts.get(folder.id) ?? 0}</small>
              </button>
              <button
                className="icon-btn folder-act"
                aria-label={`重命名 ${folder.name}`}
                title="重命名文件夹"
                onClick={() => onRename(folder)}
              >
                <Icon name="edit" size={12} />
              </button>
              <button
                className="icon-btn folder-act is-danger"
                aria-label={`删除 ${folder.name}`}
                title="删除文件夹"
                onClick={() => onDelete(folder)}
              >
                <Icon name="trash" size={12} />
              </button>
            </div>
            {renderNodes(folder.id, depth + 1)}
          </div>
        );
      });

  return (
    <div className="folder-tree">
      <div className={`folder-row is-root ${!trash && activeId === null ? 'is-active' : ''}`}>
        <button className="folder-main" onClick={() => onSelect(null)} disabled={disabled}>
          <Icon name="folder" size={14} />
          <span>全部资源</span>
        </button>
      </div>
      {renderNodes(null, 0)}
      <div className={`folder-row is-trash ${trash ? 'is-active' : ''}`}>
        <button className="folder-main" onClick={() => onSelect('__trash__')} disabled={disabled}>
          <Icon name="trash" size={14} />
          <span>回收站</span>
        </button>
      </div>
    </div>
  );
}

function AssetThumb({ asset }: { asset: AssetMeta }) {
  if (asset.thumb) {
    return <img src={asset.thumb} alt="" loading="lazy" />;
  }
  return (
    <span className={`asset-thumb-fallback is-${asset.kind}`}>
      <Icon name={kindIcon(asset.kind)} size={30} />
      {asset.kind === 'video' && <Icon name="play" size={16} className="asset-thumb-play" />}
    </span>
  );
}

function LottiePreview({ src }: { src: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const data = parseLottieSource(src);
    if (!data) {
      setError('Lottie 数据无法解析');
      return;
    }
    setError(null);
    let cancelled = false;
    let animation: AnimationItem | null = null;
    void import('lottie-web')
      .then(({ default: lottie }) => {
        if (cancelled || !hostRef.current) return;
        animation = lottie.loadAnimation({
          container: host,
          renderer: 'canvas',
          loop: true,
          autoplay: true,
          animationData: data,
          rendererSettings: { clearCanvas: true, preserveAspectRatio: 'xMidYMid meet' },
        });
        animation.addEventListener('data_failed', () => setError('Lottie 加载失败'));
        animation.addEventListener('error', () => setError('Lottie 加载失败'));
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : 'Lottie 加载失败');
      });
    return () => {
      cancelled = true;
      animation?.destroy();
      animation = null;
    };
  }, [src]);

  if (error) {
    return (
      <div className="asset-preview-file">
        <Icon name="spark" size={38} />
        <p>{error}。资源文件仍已完整保存。</p>
      </div>
    );
  }
  return <div className="asset-preview-lottie" ref={hostRef} aria-label="Lottie 动画预览" />;
}

function AssetPreviewContent({ asset, src }: { asset: AssetMeta; src: string }) {
  if (asset.kind === 'image') {
    return <img className="asset-preview-img" src={src} alt={asset.name} />;
  }
  if (asset.kind === 'video') {
    return <video className="asset-preview-media" src={src} controls autoPlay playsInline />;
  }
  if (asset.kind === 'audio') {
    return (
      <div className="asset-preview-audio">
        <span className="asset-preview-audio-mark">
          <Icon name="audio" size={38} />
        </span>
        <audio src={src} controls autoPlay />
      </div>
    );
  }
  if (asset.kind === 'lottie') {
    return <LottiePreview src={src} />;
  }
  if (asset.kind === 'model' && asset.format) {
    return <ModelViewer src={src} format={asset.format} name={asset.name} height={440} />;
  }
  return (
    <div className="asset-preview-file">
      <Icon name="text" size={38} />
      <p>该类型暂不支持预览，但已完整保存。</p>
    </div>
  );
}

function AssetMetaGrid({ asset }: { asset: AssetMeta }) {
  const dims = asset.width && asset.height ? `${asset.width} × ${asset.height}` : '—';
  return (
    <div className="asset-meta-grid">
      <div>
        <b>{ASSET_KIND_LABELS[asset.kind]}</b>
        <span>类型</span>
      </div>
      <div>
        <b>{formatAssetSize(asset)}</b>
        <span>大小</span>
      </div>
      <div>
        <b>{dims}</b>
        <span>尺寸</span>
      </div>
      <div>
        <b>{asset.duration ? formatDuration(asset.duration) : '—'}</b>
        <span>时长</span>
      </div>
      <div>
        <b>{asset.format ? asset.format.toUpperCase() : asset.ext.toUpperCase() || '—'}</b>
        <span>格式</span>
      </div>
      <div>
        <b>{formatStamp(asset.createdAt)}</b>
        <span>添加时间</span>
      </div>
    </div>
  );
}

export function AssetBrowser({ mode, kinds, onPick }: AssetBrowserProps) {
  const [assets, setAssets] = useState<AssetMeta[]>([]);
  const [folders, setFolders] = useState<AssetFolder[]>([]);
  const [ready, setReady] = useState(false);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [trashMode, setTrashMode] = useState(false);
  const [kind, setKind] = useState<'all' | AssetKind>('all');
  const [query, setQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [draft, setDraft] = useState('');
  const [previewAsset, setPreviewAsset] = useState<AssetMeta | null>(null);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const reload = async () => {
    const [metas, nextFolders] = await Promise.all([listAssetMetas(), listFolders()]);
    setAssets(metas);
    setFolders(nextFolders);
  };

  useEffect(() => {
    void reload()
      .then(() => setReady(true))
      .catch((error: unknown) => {
        setReady(true);
        toast(error instanceof Error ? error.message : '资源库读取失败', 'error');
      });
  }, []);

  useEffect(() => {
    if (!previewAsset) {
      setPreviewSrc(null);
      return;
    }
    let cancelled = false;
    setPreviewSrc(null);
    void getAssetSource(previewAsset.id).then((src) => {
      if (!cancelled) setPreviewSrc(src ?? '');
    });
    return () => {
      cancelled = true;
    };
  }, [previewAsset]);

  const activeAssets = useMemo(() => assets.filter((asset) => asset.deletedAt === null), [assets]);
  const trashedAssets = useMemo(() => assets.filter((asset) => asset.deletedAt !== null), [assets]);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const asset of activeAssets) {
      if (asset.folderId) map.set(asset.folderId, (map.get(asset.folderId) ?? 0) + 1);
    }
    return map;
  }, [activeAssets]);

  const folderScope = useMemo(
    () => new Set(folderId ? folderDescendantIds(folders, folderId) : []),
    [folderId, folders],
  );

  const visible = useMemo(() => {
    const base = trashMode ? trashedAssets : activeAssets;
    const text = query.trim().toLowerCase();
    return base
      .filter((asset) => {
        if (trashMode) return true;
        if (!folderId) return true;
        return asset.folderId !== null && folderScope.has(asset.folderId);
      })
      .filter((asset) => (kind === 'all' ? true : asset.kind === kind))
      .filter((asset) => (text ? asset.name.toLowerCase().includes(text) : true))
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [trashMode, trashedAssets, activeAssets, folderId, folderScope, kind, query]);

  const allowedKinds = useMemo(() => new Set(kinds ?? []), [kinds]);
  const hasKindFilter = kinds !== undefined && kinds.length > 0;
  const kindOptions = useMemo(
    () => ['all' as const, ...(hasKindFilter ? kinds! : ASSET_KIND_ORDER)],
    [hasKindFilter, kinds],
  );

  useEffect(() => {
    setSelectedIds((prev) => {
      const next = prev.filter((id) => visible.some((asset) => asset.id === id));
      return next.length === prev.length ? prev : next;
    });
  }, [visible]);

  const canPick = (asset: AssetMeta) => !hasKindFilter || allowedKinds.has(asset.kind);

  const pickAsset = async (asset: AssetMeta) => {
    if (!onPick || !canPick(asset)) return;
    const src = await getAssetSource(asset.id);
    if (!src) {
      toast('资源内容缺失，请重新上传', 'error');
      return;
    }
    onPick(asset, src);
  };

  const toggleSelect = (asset: AssetMeta) => {
    setSelectedIds((prev) =>
      prev.includes(asset.id) ? prev.filter((id) => id !== asset.id) : [...prev, asset.id],
    );
  };

  const uploadFiles = async (files: FileList | null) => {
    if (!files || files.length === 0 || uploading) return;
    const list = Array.from(files);
    setUploading(true);
    let ok = 0;
    const failed: string[] = [];
    for (const file of list) {
      try {
        const payload = await readAssetFile(file);
        const now = Date.now();
        await putAssetMeta(
          {
            id: uid(),
            ...payload.meta,
            folderId: trashMode ? null : folderId,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          },
          payload.src,
        );
        ok += 1;
      } catch (error) {
        failed.push(`${file.name}：${error instanceof Error ? error.message : '读取失败'}`);
      }
    }
    await reload();
    setUploading(false);
    if (ok > 0) toast(`已上传 ${ok} 个资源`, 'success');
    if (failed.length > 0) toast(failed[0], 'error');
  };

  const submitPrompt = async () => {
    if (!dialog) return;
    const name = draft.trim();
    if (!name) {
      toast('名称不能为空', 'error');
      return;
    }
    try {
      if (dialog.type === 'newFolder') {
        await putFolder({ id: uid(), name: name.slice(0, 60), parentId: dialog.parentId, createdAt: Date.now() });
        toast('文件夹已创建', 'success');
      } else if (dialog.type === 'renameFolder') {
        await putFolder({ ...dialog.folder, name: name.slice(0, 60) });
        toast('文件夹已重命名', 'success');
      } else if (dialog.type === 'renameAsset') {
        await updateAssetMeta(dialog.asset.id, { name: name.slice(0, 60), updatedAt: Date.now() });
        toast('资源已重命名', 'success');
      }
      setDialog(null);
      await reload();
    } catch (error) {
      toast(error instanceof Error ? error.message : '操作失败', 'error');
    }
  };

  const moveAssets = async (targetId: string | null) => {
    if (!dialog || dialog.type !== 'moveAssets') return;
    try {
      for (const id of dialog.ids) {
        await updateAssetMeta(id, { folderId: targetId, updatedAt: Date.now() });
      }
      setDialog(null);
      setSelectedIds([]);
      await reload();
      toast(`已移动 ${dialog.ids.length} 个资源`, 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : '移动失败', 'error');
    }
  };

  const removeFolder = async (folder: AssetFolder) => {
    try {
      const ids = folderDescendantIds(folders, folder.id);
      for (const asset of assets) {
        if (asset.folderId && ids.includes(asset.folderId)) {
          await updateAssetMeta(asset.id, { folderId: null });
        }
      }
      await deleteFolderRecords(ids);
      if (folderId && ids.includes(folderId)) setFolderId(null);
      setDialog(null);
      await reload();
      toast('文件夹已删除，内部资源已移到全部资源', 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : '删除失败', 'error');
    }
  };

  const confirmTrash = async (ids: string[]) => {
    try {
      await trashAssets(ids);
      setDialog(null);
      setSelectedIds([]);
      await reload();
      toast(`已将 ${ids.length} 个资源移入回收站`, 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : '删除失败', 'error');
    }
  };

  const confirmDeleteForever = async (ids: string[]) => {
    try {
      await deleteAssetsPermanently(ids);
      setDialog(null);
      setSelectedIds([]);
      await reload();
      toast(`已彻底删除 ${ids.length} 个资源`, 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : '删除失败', 'error');
    }
  };

  const restoreSelected = async (ids: string[]) => {
    try {
      await restoreAssets(ids);
      setSelectedIds([]);
      await reload();
      toast(`已还原 ${ids.length} 个资源`, 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : '还原失败', 'error');
    }
  };

  const confirmEmptyTrash = async () => {
    try {
      const count = await emptyAssetTrash();
      setDialog(null);
      setSelectedIds([]);
      await reload();
      toast(count > 0 ? `已清空回收站（${count} 项）` : '回收站已经是空的', count > 0 ? 'success' : 'info');
    } catch (error) {
      toast(error instanceof Error ? error.message : '清空失败', 'error');
    }
  };

  const breadcrumb = folderBreadcrumb(folders, folderId);
  const activeFolder = folderId ? folders.find((folder) => folder.id === folderId) : null;
  const previewMeta = previewAsset;
  const previewReady = previewSrc !== null && previewSrc !== '';

  return (
    <div className={`asset-browser is-${mode}`}>
      <aside className="asset-side">
        <div className="asset-side-head">
          <div>
            <div className="pane-label">资源目录</div>
            <div className="pane-sub">{assets.length} 个资源</div>
          </div>
          <button
            className="icon-btn"
            aria-label="新建文件夹"
            title="新建文件夹"
            onClick={() => {
              setDraft('');
              setDialog({ type: 'newFolder', parentId: folderId });
            }}
          >
            <Icon name="plus" size={16} />
          </button>
        </div>
        <FolderTree
          folders={folders}
          activeId={folderId}
          trash={trashMode}
          counts={counts}
          disabled={uploading}
          onSelect={(id) => {
            setSelectedIds([]);
            if (id === '__trash__') {
              setTrashMode(true);
              return;
            }
            setTrashMode(false);
            setFolderId(id);
          }}
          onRename={(folder) => {
            setDraft(folder.name);
            setDialog({ type: 'renameFolder', folder });
          }}
          onDelete={(folder) => setDialog({ type: 'deleteFolder', folder })}
        />
        <div className="asset-side-foot">
          <span>回收站中 {trashedAssets.length} 项</span>
        </div>
      </aside>

      <section className="asset-content">
        <div className="asset-content-head">
          <div className="asset-crumbs">
            {trashMode ? (
              <span className="asset-crumb is-current">回收站</span>
            ) : (
              <>
                <button
                  className={`asset-crumb ${folderId === null ? 'is-current' : ''}`}
                  onClick={() => setFolderId(null)}
                >
                  全部资源
                </button>
                {breadcrumb.map((folder, index) => (
                  <span key={folder.id} className="asset-crumb-wrap">
                    <span className="asset-crumb-sep">/</span>
                    <button
                      className={`asset-crumb ${index === breadcrumb.length - 1 ? 'is-current' : ''}`}
                      onClick={() => setFolderId(folder.id)}
                    >
                      {folder.name}
                    </button>
                  </span>
                ))}
              </>
            )}
          </div>
          <div className="asset-head-actions">
            {trashMode ? (
              <>
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={trashedAssets.length === 0}
                  onClick={() => setDialog({ type: 'emptyTrash' })}
                >
                  <Icon name="trash" size={14} /> 清空回收站
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => setTrashMode(false)}>
                  返回资源
                </button>
              </>
            ) : (
              <>
                <input
                  ref={fileInput}
                  type="file"
                  hidden
                  multiple
                  accept={ACCEPT_ALL}
                  onChange={(event) => {
                    void uploadFiles(event.target.files);
                    event.target.value = '';
                  }}
                />
                <button
                  className="btn btn-primary btn-sm"
                  disabled={uploading}
                  onClick={() => fileInput.current?.click()}
                >
                  <Icon name="upload" size={15} />
                  {uploading ? '正在读取…' : '上传资源'}
                </button>
              </>
            )}
          </div>
        </div>

        <div className="asset-toolbar">
          <input
            className="text-input asset-search"
            placeholder="搜索资源名称"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="搜索资源名称"
          />
          <div className="asset-kindbar" role="group" aria-label="资源类型筛选">
            {kindOptions.map((option) => (
              <button
                key={option}
                className={`asset-kind ${option === kind ? 'is-active' : ''}`}
                onClick={() => setKind(option)}
              >
                {option === 'all' ? '全部' : ASSET_KIND_LABELS[option]}
              </button>
            ))}
          </div>
          <span className="asset-count">
            {activeFolder ? `${activeFolder.name} · ` : ''}
            {visible.length} 项
          </span>
        </div>

        {selectedIds.length > 0 && (
          <div className="asset-bulk">
            <span>已选 {selectedIds.length} 项</span>
            {trashMode ? (
              <>
                <button className="btn btn-light btn-sm" onClick={() => void restoreSelected(selectedIds)}>
                  <Icon name="restore" size={14} /> 还原
                </button>
                <button
                  className="btn btn-danger btn-sm"
                  onClick={() => setDialog({ type: 'deleteForever', ids: selectedIds })}
                >
                  <Icon name="trash" size={14} /> 彻底删除
                </button>
              </>
            ) : (
              <>
                <button
                  className="btn btn-light btn-sm"
                  onClick={() => setDialog({ type: 'moveAssets', ids: selectedIds })}
                >
                  <Icon name="folder" size={14} /> 移动到…
                </button>
                <button
                  className="btn btn-danger btn-sm"
                  onClick={() => setDialog({ type: 'trashAssets', ids: selectedIds })}
                >
                  <Icon name="trash" size={14} /> 移入回收站
                </button>
              </>
            )}
            <button className="btn btn-ghost btn-sm" onClick={() => setSelectedIds([])}>
              取消选择
            </button>
          </div>
        )}

        {!ready ? (
          <div className="asset-empty">
            <p>正在读取资源库…</p>
          </div>
        ) : visible.length === 0 ? (
          <div className="asset-empty">
            <span className="asset-empty-mark">
              <Icon name={trashMode ? 'trash' : 'image'} size={26} />
            </span>
            <p>{trashMode ? '回收站是空的。删除的资源会先来到这里。' : '这里还没有资源。上传图片、视频、音频或 3D 模型开始。'}</p>
          </div>
        ) : (
          <div className="asset-grid">
            {visible.map((asset) => {
              const selected = selectedIds.includes(asset.id);
              const pickable = canPick(asset);
              return (
                <article
                  key={asset.id}
                  className={`asset-card ${selected ? 'is-selected' : ''} ${!pickable ? 'is-disabled' : ''}`}
                  onClick={() => {
                    if (mode === 'pick') {
                      if (pickable) void pickAsset(asset);
                    } else {
                      toggleSelect(asset);
                    }
                  }}
                  onDoubleClick={() => setPreviewAsset(asset)}
                  title={mode === 'pick' && !pickable ? '该资源类型暂不支持插入' : asset.name}
                >
                  <div className="asset-thumb">
                    <AssetThumb asset={asset} />
                    {asset.kind !== 'image' && <span className="asset-badge">{ASSET_KIND_LABELS[asset.kind]}</span>}
                    {selected && (
                      <span className="asset-check">
                        <Icon name="check" size={12} />
                      </span>
                    )}
                    <div className="asset-card-actions" onClick={(event) => event.stopPropagation()}>
                      <button
                        className="icon-btn"
                        aria-label={`预览 ${asset.name}`}
                        title="预览"
                        onClick={() => setPreviewAsset(asset)}
                      >
                        <Icon name="eye" size={14} />
                      </button>
                      {mode === 'manage' && !trashMode && (
                        <>
                          <button
                            className="icon-btn"
                            aria-label={`重命名 ${asset.name}`}
                            title="重命名"
                            onClick={() => {
                              setDraft(asset.name);
                              setDialog({ type: 'renameAsset', asset });
                            }}
                          >
                            <Icon name="edit" size={14} />
                          </button>
                          <button
                            className="icon-btn"
                            aria-label={`移动 ${asset.name}`}
                            title="移动到文件夹"
                            onClick={() => setDialog({ type: 'moveAssets', ids: [asset.id] })}
                          >
                            <Icon name="folder" size={14} />
                          </button>
                          <button
                            className="icon-btn is-danger"
                            aria-label={`删除 ${asset.name}`}
                            title="移入回收站"
                            onClick={() => setDialog({ type: 'trashAssets', ids: [asset.id] })}
                          >
                            <Icon name="trash" size={14} />
                          </button>
                        </>
                      )}
                      {mode === 'manage' && trashMode && (
                        <>
                          <button
                            className="icon-btn"
                            aria-label={`还原 ${asset.name}`}
                            title="还原"
                            onClick={() => void restoreSelected([asset.id])}
                          >
                            <Icon name="restore" size={14} />
                          </button>
                          <button
                            className="icon-btn is-danger"
                            aria-label={`彻底删除 ${asset.name}`}
                            title="彻底删除"
                            onClick={() => setDialog({ type: 'deleteForever', ids: [asset.id] })}
                          >
                            <Icon name="trash" size={14} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="asset-info">
                    <b>{asset.name}</b>
                    <small>
                      {ASSET_KIND_LABELS[asset.kind]} · {formatAssetSize(asset)}
                      {asset.duration ? ` · ${formatDuration(asset.duration)}` : ''}
                    </small>
                  </div>
                  {mode === 'pick' && pickable && (
                    <span className="asset-use">
                      <Icon name="plus" size={12} /> 插入
                    </span>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      {previewMeta && (
        <Modal
          title={previewMeta.name}
          eyebrow={ASSET_KIND_LABELS[previewMeta.kind]}
          width={860}
          onClose={() => setPreviewAsset(null)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setPreviewAsset(null)}>
                关闭
              </button>
              {mode === 'pick' && onPick && canPick(previewMeta) && (
                <button
                  className="btn btn-primary"
                  disabled={!previewReady}
                  onClick={() => {
                    if (previewSrc) {
                      onPick(previewMeta, previewSrc);
                      setPreviewAsset(null);
                    }
                  }}
                >
                  插入到画板
                </button>
              )}
            </>
          }
        >
          <div className="asset-preview">
            {previewSrc === null ? (
              <div className="asset-preview-loading">正在读取资源内容…</div>
            ) : previewSrc === '' ? (
              <div className="asset-preview-loading">资源内容缺失，请重新上传。</div>
            ) : (
              <AssetPreviewContent asset={previewMeta} src={previewSrc} />
            )}
          </div>
          <AssetMetaGrid asset={previewMeta} />
        </Modal>
      )}

      {(dialog?.type === 'newFolder' || dialog?.type === 'renameFolder' || dialog?.type === 'renameAsset') && (
        <PromptDialog
          title={
            dialog.type === 'newFolder' ? '新建文件夹' : dialog.type === 'renameFolder' ? '重命名文件夹' : '重命名资源'
          }
          label={dialog.type === 'renameAsset' ? '资源名称' : '文件夹名称'}
          placeholder="输入名称"
          value={draft}
          onChange={setDraft}
          onCancel={() => setDialog(null)}
          onConfirm={() => void submitPrompt()}
        />
      )}

      {dialog?.type === 'moveAssets' && (
        <Modal
          title="移动到文件夹"
          eyebrow={`${dialog.ids.length} 项资源`}
          width={460}
          onClose={() => setDialog(null)}
          footer={
            <button className="btn btn-ghost" onClick={() => setDialog(null)}>
              取消
            </button>
          }
        >
          <div className="move-list">
            <button className="move-row" onClick={() => void moveAssets(null)}>
              <Icon name="folder" size={14} />
              <span>全部资源（根目录）</span>
            </button>
            {folders.map((folder) => (
              <button className="move-row" key={folder.id} onClick={() => void moveAssets(folder.id)}>
                <Icon name="folder" size={14} />
                <span>{folderBreadcrumb(folders, folder.id).map((item) => item.name).join(' / ')}</span>
              </button>
            ))}
          </div>
        </Modal>
      )}

      {dialog?.type === 'deleteFolder' && (
        <ConfirmDialog
          title="删除这个文件夹？"
          danger
          confirmLabel="删除文件夹"
          message={
            <>
              文件夹「<b>{dialog.folder.name}</b>」及其子文件夹会被删除，内部资源会移动到「全部资源」，不会被删除。
            </>
          }
          onCancel={() => setDialog(null)}
          onConfirm={() => void removeFolder(dialog.folder)}
        />
      )}

      {dialog?.type === 'trashAssets' && (
        <ConfirmDialog
          title="移入回收站？"
          danger
          confirmLabel="移入回收站"
          message={<>将移动 {dialog.ids.length} 个资源到回收站，之后可以还原或彻底删除。</>}
          onCancel={() => setDialog(null)}
          onConfirm={() => void confirmTrash(dialog.ids)}
        />
      )}

      {dialog?.type === 'deleteForever' && (
        <ConfirmDialog
          title="彻底删除这些资源？"
          danger
          confirmLabel="彻底删除"
          message={<>将永久删除 {dialog.ids.length} 个资源，无法恢复。已经插入画板的对象不受影响。</>}
          onCancel={() => setDialog(null)}
          onConfirm={() => void confirmDeleteForever(dialog.ids)}
        />
      )}

      {dialog?.type === 'emptyTrash' && (
        <ConfirmDialog
          title="清空回收站？"
          danger
          confirmLabel="清空回收站"
          message={<>将永久删除回收站中的 {trashedAssets.length} 个资源，无法恢复。</>}
          onCancel={() => setDialog(null)}
          onConfirm={() => void confirmEmptyTrash()}
        />
      )}
    </div>
  );
}

interface AssetsPageProps {
  onBack: () => void;
}

export function AssetsPage({ onBack }: AssetsPageProps) {
  return (
    <div className="assets-page">
      <header className="assets-top">
        <div className="assets-top-left">
          <button className="icon-btn" onClick={onBack} aria-label="返回首页" title="返回首页">
            <Icon name="back" size={18} />
          </button>
          <div>
            <div className="assets-title">资源库</div>
            <div className="assets-sub">图片、视频、音频与 3D 模型 · 保存在当前浏览器</div>
          </div>
        </div>
        <a className="btn btn-ghost btn-sm" href="docs/02-PRD-3d-slide.html" target="_blank" rel="noreferrer">
          <Icon name="text" size={15} />
          产品说明
        </a>
      </header>
      <main className="assets-body">
        <AssetBrowser mode="manage" />
      </main>
    </div>
  );
}
