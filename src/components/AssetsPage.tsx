/**
 * AssetsPage.tsx —— 素材库页面与资源浏览器
 *
 * 职责：
 * - 提供素材的浏览、搜索、类型筛选、文件夹归类、回收站、上传、预览、重命名与移动等管理能力。
 * - 同一套 AssetBrowser 支持两种模式：manage（资源库页面）与 pick（编辑器内选择素材插入画板）。
 *
 * 数据流：
 * - 元数据（AssetMeta）与文件内容分开存储：元数据存于 IndexedDB，内容通过 src（dataURL）保存；
 *   listAssetMetas / listFolders 读取列表，getAssetSource 按需读取大文件内容，避免一次性加载全部素材。
 * - 上传使用 readAssetFile 解析类型、尺寸、时长并生成缩略图；解析失败的文件会单独报错，不阻断其他文件。
 * - Lottie 使用 lottie-web 动态加载渲染预览，并为旧版无缩略图的资源补渲染首帧。
 *
 * 依赖：
 * - lib/assets.ts：类型判断、标签、文件夹面包屑 / 后代查询、体积格式化与文件解析。
 * - lib/storage.ts：素材与文件夹的读写、回收站 / 彻底删除 / 还原。
 * - store/uiStore.ts 的 toast 用于操作反馈；ModelViewer 负责 3D 模型预览。
 */
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
import { parseLottieSource, renderLottieThumbnail } from '../lib/lottie';
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

/** 浏览器工作模式：manage 为完整管理，pick 为选择素材插入画板。 */
type BrowserMode = 'manage' | 'pick';

interface AssetBrowserProps {
  mode: BrowserMode;
  /** 选择模式下允许插入的类型，未限定则全部 */
  kinds?: AssetKind[];
  /** pick 模式确认插入时回调：asset 为元数据，src 为已读取的资源内容（dataURL）。 */
  onPick?: (asset: AssetMeta, src: string) => void;
}

/**
 * 当前弹出的对话框描述。
 * 用一个可辨识联合（type 字段）统一管理所有弹窗，保证同一时间只显示一个对话框。
 */
type Dialog =
  | { type: 'newFolder'; parentId: string | null }
  | { type: 'renameFolder'; folder: AssetFolder }
  | { type: 'renameAsset'; asset: AssetMeta }
  | { type: 'renameAssets'; ids: string[] }
  | { type: 'moveAssets'; ids: string[] }
  | { type: 'deleteFolder'; folder: AssetFolder }
  | { type: 'trashAssets'; ids: string[] }
  | { type: 'deleteForever'; ids: string[] }
  | { type: 'emptyTrash' }
  | null;

/**
 * 上传文件选择框接受的 MIME 类型集合：
 * 常见图片 / 视频 / 音频 + 3D 模型扩展名 + Lottie（.json / .lottie）。
 */
const ACCEPT_ALL = `image/png,image/jpeg,image/webp,image/gif,video/*,audio/*,${MODEL_ACCEPT},application/json,.json,.lottie`;

/** 资源网格每页展示数量：与插入面板高度匹配，一页基本无需滚动，也避免一次渲染过多缩略图。 */
const PAGE_SIZE = 16;

/**
 * 生成资源 / 文件夹 id。
 * 优先使用 crypto.randomUUID；在不支持的环境（旧浏览器、非安全上下文）退化为
 * 时间戳 + 随机串，保证本地唯一即可。
 */
function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `a-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

/** 把资源类型映射为图标名；lottie / file 统一用文本图标兜底。 */
function kindIcon(kind: AssetKind): 'image' | 'video' | 'audio' | 'model' | 'text' {
  if (kind === 'image') return 'image';
  if (kind === 'video') return 'video';
  if (kind === 'audio') return 'audio';
  if (kind === 'model') return 'model';
  return 'text';
}

/**
 * 计算批量改名后的单个名称。
 *
 * 规则：保留原文件后缀（名称里没有后缀时用元数据里的 ext 补回），
 * 前缀后追加两位序号（-01、-02…），整体不超过存储层 60 字的名称上限。
 *
 * @param name 原名称（可能包含后缀）
 * @param ext 元数据中的小写后缀（不含点）
 * @param base 用户输入的名称前缀
 * @param index 在选中列表中的序号（从 1 开始）
 */
function bulkRenameName(name: string, ext: string, base: string, index: number): string {
  const dot = name.lastIndexOf('.');
  const suffix = dot > 0 && dot < name.length - 1 ? name.slice(dot) : ext ? `.${ext}` : '';
  const serial = `-${String(index).padStart(2, '0')}`;
  // 前缀优先让位于序号与后缀，避免末尾编号被截断
  const room = Math.max(1, 60 - serial.length - suffix.length);
  return `${base.slice(0, room)}${serial}${suffix}`;
}

/**
 * 通用单输入框对话框：用于新建文件夹、重命名文件夹 / 资源。
 * 名称由外部 draft 状态统一持有，回车等同确认；maxLength 与存储层的名称上限保持一致。
 */
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

/**
 * 左侧文件夹树：递归渲染文件夹层级，并附带根目录「全部资源」和「回收站」入口。
 *
 * counts 为每个文件夹直接包含的资源数（不含子文件夹）；
 * depth 用于控制缩进，每层增加 12px，不额外维护树形数据结构。
 */
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
      // 先按 parentId 找直接子级，再按创建时间升序保持稳定顺序；递归时重复同样的过滤逻辑。
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

/**
 * 资源卡片缩略图：优先显示上传时生成的缩略 dataURL；
 * 没有缩略图（旧资源 / 解析失败）时退化为类型图标，视频额外叠加播放角标。
 */
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

/**
 * Lottie 动画预览：解析资源内容后用 lottie-web 的 canvas 渲染器循环播放。
 *
 * 副作用与生命周期：
 * - 动态 import('lottie-web')，避免主包体积过大；加载期间组件可能已卸载，用 cancelled 标记丢弃结果。
 * - 动画实例在清理函数中 destroy，防止切换预览时残留 RAF 与 canvas 引用。
 * - 解析或加载失败时只显示错误文案，资源文件本身仍完整保存在库中。
 */
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
        // 异步加载完成时若已卸载或宿主节点消失，则不再创建动画。
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
      // 卸载或切换资源时销毁动画实例，并置空引用避免再次访问。
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

/** 文本类后缀：预览弹窗里直接读取内容展示，避免只能看到「不支持预览」。 */
const TEXT_PREVIEW_EXTS = new Set([
  'txt', 'md', 'csv', 'tsv', 'json', 'log', 'yml', 'yaml', 'xml', 'html', 'css', 'js', 'ts', 'tsx', 'ini', 'conf',
]);

/** 把 dataURL 解码为文本片段（base64 / 百分号编码都支持），失败时返回 null。 */
function dataUrlText(src: string, max = 6000): string | null {
  try {
    if (!src.startsWith('data:')) return src.slice(0, max);
    const comma = src.indexOf(',');
    if (comma < 0) return null;
    const head = src.slice(0, comma);
    const body = src.slice(comma + 1);
    // 只解码前 1MB 的 base64 片段，足够展示预览且避免大文件阻塞主线程
    const text = head.includes('base64') ? atob(body.slice(0, 1_400_000)) : decodeURIComponent(body);
    return text.slice(0, max);
  } catch {
    return null;
  }
}

/**
 * 普通文件预览：文本类展示内容片段，其他类型给出说明，并统一提供原文件下载。
 * 这样任何类型的资源在「预览」弹窗里都有可见结果，而不是只有一句「不支持」。
 */
function FilePreview({ asset, src }: { asset: AssetMeta; src: string }) {
  const text = TEXT_PREVIEW_EXTS.has(asset.ext) ? dataUrlText(src) : null;
  return (
    <div className="asset-preview-filewrap">
      {text !== null ? (
        <pre className="asset-preview-text">{text || '（空文件）'}</pre>
      ) : (
        <div className="asset-preview-file">
          <Icon name="text" size={38} />
          <p>该文件无法内联预览，可下载后在本地查看。</p>
        </div>
      )}
      <a className="btn btn-light btn-sm asset-preview-download" href={src} download={asset.name}>
        <Icon name="download" size={14} /> 下载原文件
      </a>
    </div>
  );
}

/**
 * 根据资源类型渲染预览内容：
 * 图片 / 视频 / 音频直接使用 src；Lottie 交给 LottiePreview；模型交给 ModelViewer；
 * 其余类型走通用文件预览（文本片段 + 下载）。
 */
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
  return <FilePreview asset={asset} src={src} />;
}

/**
 * 预览弹窗底部的元数据网格：类型、大小、尺寸、时长、格式与添加时间。
 * 缺失信息统一显示为破折号，避免出现 undefined / NaN 字样。
 */
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

/**
 * 页码窗口：总页数不超过 7 时全部展示；否则固定显示首尾页，
 * 并在当前页附近展开 5 个页码，超出部分用省略号代替，避免按钮无限增长。
 */
function pageWindow(current: number, total: number): Array<number | '…'> {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const start = Math.max(2, Math.min(current - 1, total - 4));
  const end = Math.min(total - 1, Math.max(current + 1, 5));
  const pages: Array<number | '…'> = [1];
  if (start > 2) pages.push('…');
  for (let p = start; p <= end; p += 1) pages.push(p);
  if (end < total - 1) pages.push('…');
  pages.push(total);
  return pages;
}

/** 资源网格底部的分页条：总数量、上一页 / 页码 / 下一页与当前页信息。 */
function AssetPager({
  page,
  pageCount,
  total,
  onChange,
}: {
  page: number;
  pageCount: number;
  total: number;
  onChange: (page: number) => void;
}) {
  return (
    <div className="asset-pager">
      <span className="asset-pager-count">共 {total} 个资源</span>
      {pageCount > 1 && (
        <div className="asset-pager-pages">
          <button className="asset-page-btn is-text" disabled={page <= 1} onClick={() => onChange(page - 1)}>
            上一页
          </button>
          {pageWindow(page, pageCount).map((item, index) =>
            item === '…' ? (
              <span className="asset-page-gap" key={`gap-${index}`}>
                …
              </span>
            ) : (
              <button
                key={item}
                className={`asset-page-btn ${item === page ? 'is-active' : ''}`}
                onClick={() => onChange(item)}
              >
                {item}
              </button>
            ),
          )}
          <button
            className="asset-page-btn is-text"
            disabled={page >= pageCount}
            onClick={() => onChange(page + 1)}
          >
            下一页
          </button>
        </div>
      )}
      {pageCount > 1 && (
        <span className="asset-pager-info">
          第 {page} / {pageCount} 页
        </span>
      )}
    </div>
  );
}

/**
 * 资源浏览器主组件。
 *
 * 状态分组：
 * - 数据：assets / folders（全量元数据），ready 表示首次读取完成。
 * - 位置与筛选：folderId / trashMode / kind / query 决定当前可见列表。
 * - 交互：selectedIds（多选）、dialog（当前弹窗）、draft（输入框草稿）、
 *   previewAsset / previewSrc（预览资源及其按需读取的内容）。
 * - uploading 用于禁用上传按钮与文件夹操作，防止并发写入造成列表错乱。
 */
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
  const thumbBackfill = useRef(new Set<string>());

  /** 重新读取全部元数据与文件夹，用于每次写操作后刷新界面。 */
  const reload = async () => {
    // 两个列表互不依赖，并行读取减少一次等待；由调用方统一 setState。
    const [metas, nextFolders] = await Promise.all([listAssetMetas(), listFolders()]);
    setAssets(metas);
    setFolders(nextFolders);
  };

  useEffect(() => {
    void reload()
      .then(() => setReady(true))
      .catch((error: unknown) => {
        // 即使读取失败也要结束 loading 状态，否则界面会一直停留在「正在读取资源库…」。
        setReady(true);
        toast(error instanceof Error ? error.message : '资源库读取失败', 'error');
      });
  }, []);

  useEffect(() => {
    if (!previewAsset) {
      setPreviewSrc(null);
      return;
    }
    // 切换预览对象时先清空旧内容，避免短暂显示上一个资源；
    // cancelled 防止快速切换时旧请求晚到并覆盖新资源。
    let cancelled = false;
    setPreviewSrc(null);
    void getAssetSource(previewAsset.id).then((src) => {
      if (!cancelled) setPreviewSrc(src ?? '');
    });
    return () => {
      cancelled = true;
    };
  }, [previewAsset]);

  // 按删除标记拆分为「正常资源」与「回收站资源」，后续列表与计数都基于这两份派生数据。
  const activeAssets = useMemo(() => assets.filter((asset) => asset.deletedAt === null), [assets]);
  const trashedAssets = useMemo(() => assets.filter((asset) => asset.deletedAt !== null), [assets]);

  // 旧版上传的 Lottie 没有首帧缩略图，读取资源内容后补渲染一帧并回填
  useEffect(() => {
    // thumbBackfill 记录已尝试过的 id：activeAssets 每次更新都会触发本 effect，
    // 用 Set 防止对同一资源重复读取与渲染。
    const missing = activeAssets.filter(
      (asset) => asset.kind === 'lottie' && !asset.thumb && !thumbBackfill.current.has(asset.id),
    );
    if (missing.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const asset of missing) {
        if (cancelled) return;
        // 先登记再处理，避免本轮中途再次触发 effect 时重复。
        thumbBackfill.current.add(asset.id);
        const src = await getAssetSource(asset.id);
        if (!src) continue;
        const thumb = await renderLottieThumbnail(src);
        if (cancelled || !thumb) continue;
        await updateAssetMeta(asset.id, { thumb });
        // 局部更新列表而不是整表 reload，减少一次 IndexedDB 全量读取。
        setAssets((prev) => prev.map((item) => (item.id === asset.id ? { ...item, thumb } : item)));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeAssets]);

  // 每个文件夹直接包含的资源数量（不含子文件夹），用于树节点的计数角标。
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const asset of activeAssets) {
      if (asset.folderId) map.set(asset.folderId, (map.get(asset.folderId) ?? 0) + 1);
    }
    return map;
  }, [activeAssets]);

  // 当前文件夹及其所有后代文件夹的 id 集合；选中父文件夹时连同子文件夹资源一起展示。
  const folderScope = useMemo(
    () => new Set(folderId ? folderDescendantIds(folders, folderId) : []),
    [folderId, folders],
  );

  // 可见列表的计算顺序：来源（回收站 / 正常）→ 文件夹范围 → 类型 → 名称搜索 → 按添加时间倒序。
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

  // 分页：按固定页大小切片渲染；筛选条件变化时回到第一页，删除后页码自动收敛到有效范围。
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pagedVisible = useMemo(
    () => visible.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [visible, currentPage],
  );

  // 批量改名的目标：按当前列表顺序排列（选中集始终是可见列表的子集）。
  const renameTargets = useMemo(
    () => (dialog?.type === 'renameAssets' ? visible.filter((asset) => dialog.ids.includes(asset.id)) : []),
    [dialog, visible],
  );

  useEffect(() => {
    setPage(1);
  }, [trashMode, folderId, kind, query]);

  const allowedKinds = useMemo(() => new Set(kinds ?? []), [kinds]);
  // pick 模式可能限定可插入类型：有筛选时类型栏只展示允许项，无筛选时展示全部类型。
  const hasKindFilter = kinds !== undefined && kinds.length > 0;
  const kindOptions = useMemo(
    () => ['all' as const, ...(hasKindFilter ? kinds! : ASSET_KIND_ORDER)],
    [hasKindFilter, kinds],
  );

  useEffect(() => {
    // 列表变化（删除、筛选、切换文件夹）后剔除已不可见的选中项；长度不变则保持原引用避免重渲染。
    setSelectedIds((prev) => {
      const next = prev.filter((id) => visible.some((asset) => asset.id === id));
      return next.length === prev.length ? prev : next;
    });
  }, [visible]);

  /** 判断该资源在当前模式下是否可插入（未限定类型时恒为 true）。 */
  const canPick = (asset: AssetMeta) => !hasKindFilter || allowedKinds.has(asset.kind);

  /** 切换单个资源的选中状态（多选模式下的点击行为）。 */
  const toggleSelect = (asset: AssetMeta) => {
    setSelectedIds((prev) =>
      prev.includes(asset.id) ? prev.filter((id) => id !== asset.id) : [...prev, asset.id],
    );
  };

  /**
   * 上传并解析一批文件。
   *
   * 流程：逐个 readAssetFile（读取内容、类型、尺寸 / 时长，并生成缩略图）
   * → 生成元数据（newFolder 为当前文件夹，回收站中上传则落到根目录）
   * → putAssetMeta 分别写入元数据与内容 → 全部结束后统一 reload。
   *
   * 单个文件失败只记录错误、不中断后续文件；最后只弹第一条错误提示，避免刷屏。
   */
  const uploadFiles = async (files: FileList | null) => {
    if (!files || files.length === 0 || uploading) return;
    const list = Array.from(files);
    setUploading(true);
    let ok = 0;
    const failed: string[] = [];
    for (const file of list) {
      try {
        // readAssetFile 承担大部分素材解析：MIME 判断、dataURL 读取、图片 / 视频尺寸与缩略图。
        const payload = await readAssetFile(file);
        const now = Date.now();
        await putAssetMeta(
          {
            id: uid(),
            ...payload.meta,
            // 在回收站界面里上传时没有有效文件夹上下文，直接放到根目录。
            folderId: trashMode ? null : folderId,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          },
          payload.src,
        );
        ok += 1;
      } catch (error) {
        // 记录「文件名：原因」，方便用户判断是哪个文件解析失败。
        failed.push(`${file.name}：${error instanceof Error ? error.message : '读取失败'}`);
      }
    }
    await reload();
    setUploading(false);
    if (ok > 0) toast(`已上传 ${ok} 个资源`, 'success');
    if (failed.length > 0) toast(failed[0], 'error');
  };

  /**
   * 提交名称类对话框（新建 / 重命名文件夹、重命名资源）。
   * 名称统一 trim 并截断到 60 字；成功后关闭弹窗并重新读取列表。
   */
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
      } else if (dialog.type === 'renameAssets') {
        // 批量改名：保留各自后缀，按当前列表顺序追加序号
        const targets = visible.filter((asset) => dialog.ids.includes(asset.id));
        for (const [index, asset] of targets.entries()) {
          await updateAssetMeta(asset.id, {
            name: bulkRenameName(asset.name, asset.ext, name, index + 1),
            updatedAt: Date.now(),
          });
        }
        setSelectedIds([]);
        toast(`已重命名 ${targets.length} 个资源`, 'success');
      }
      setDialog(null);
      await reload();
    } catch (error) {
      toast(error instanceof Error ? error.message : '操作失败', 'error');
    }
  };

  /** 批量移动资源到目标文件夹（null 表示根目录），随后清空选中并刷新。 */
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

  /**
   * 删除文件夹：先收集该文件夹及所有后代 id，把其中资源移到根目录，
   * 再删除文件夹记录；若当前正停留在被删目录，则退回「全部资源」。
   */
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

  /** 移入回收站（软删除）：只标记 deletedAt，内容与元数据保留，可还原。 */
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

  /** 彻底删除（物理删除）：元数据与资源内容一并清除，无法恢复。 */
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

  /** 从回收站还原资源：清除 deletedAt 标记，资源回到原来的文件夹。 */
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

  /** 清空回收站：物理删除所有已标记删除的资源，返回实际清理数量。 */
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
            {/* 批量操作栏：回收站中提供还原 / 彻底删除，正常目录中提供移动 / 移入回收站 */}
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
                  onClick={() => {
                    setDraft('');
                    setDialog({ type: 'renameAssets', ids: selectedIds });
                  }}
                >
                  <Icon name="edit" size={14} /> 批量改名
                </button>
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
            <p>{trashMode ? '回收站是空的。删除的资源会先来到这里。' : '这里还没有资源。上传图片、视频、音频、Lottie 或 3D 模型开始。'}</p>
          </div>
        ) : (
          <>
            <div className="asset-grid">
              {pagedVisible.map((asset) => {
              const selected = selectedIds.includes(asset.id);
              const pickable = canPick(asset);
              // 双击始终打开预览；卡片右上角操作区会阻止冒泡，避免触发选择逻辑。
              return (
                <article
                  key={asset.id}
                  className={`asset-card ${selected ? 'is-selected' : ''} ${!pickable ? 'is-disabled' : ''}`}
                  onClick={() => {
                    // 卡片单击语义：pick 模式打开预览准备插入；manage 模式切换多选。
                    if (mode === 'pick') {
                      setPreviewAsset(asset);
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
                      <Icon name="eye" size={12} /> 预览
                    </span>
                  )}
                </article>
              );
            })}
            </div>
            <AssetPager page={currentPage} pageCount={pageCount} total={visible.length} onChange={setPage} />
          </>
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
            {/* previewSrc 三态：null 读取中 / '' 内容缺失 / 非空可预览 */}
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

      {dialog?.type === 'renameAssets' && (
        <Modal
          title="批量改名"
          eyebrow={`已选 ${renameTargets.length} 项`}
          width={520}
          onClose={() => setDialog(null)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setDialog(null)}>
                取消
              </button>
              <button className="btn btn-primary" onClick={() => void submitPrompt()}>
                重命名
              </button>
            </>
          }
        >
          <label className="field-block">
            <span className="field-label">名称前缀</span>
            <input
              className="text-input"
              autoFocus
              maxLength={60}
              placeholder="例如：宣传图"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submitPrompt();
              }}
            />
          </label>
          <p className="bulk-rename-tip">按当前列表顺序编号，并保留各自的文件后缀，例如「宣传图-01.png」。</p>
          {renameTargets.length > 0 && (
            <ul className="bulk-rename-list">
              {renameTargets.slice(0, 5).map((asset, index) => (
                <li key={asset.id}>
                  <span className="old">{asset.name}</span>
                  <span className="arrow">→</span>
                  <span className="new">
                    {draft.trim() ? bulkRenameName(asset.name, asset.ext, draft.trim(), index + 1) : '等待输入前缀'}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {renameTargets.length > 5 && (
            <p className="bulk-rename-tip">另有 {renameTargets.length - 5} 项将按同样规则一并改名。</p>
          )}
        </Modal>
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

/**
 * 素材库独立页面：顶部标题栏 + 完整管理模式的资源浏览器。
 * 该页面不依赖 deckStore，仅操作本地 IndexedDB 中的素材数据。
 */
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
            <div className="assets-sub">图片、视频、音频、Lottie 与 3D 模型 · 保存在当前浏览器</div>
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
