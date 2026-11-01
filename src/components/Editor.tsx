import { useEffect, useRef, useState } from 'react';
import type { ViewState } from '../types';
import type { AssetMeta } from '../lib/assets';
import { readAssetFile } from '../lib/assets';
import { LIMITS } from '../lib/constants';
import { exportDeckFile } from '../lib/file';
import { formatBytes, isAcceptedImage, readImageFile } from '../lib/image';
import { isLottieFile, readLottieFile } from '../lib/lottie';
import { mediaKindOf, readMediaFile } from '../lib/media';
import { isModelFile, modelFormatOf, MODEL_ACCEPT } from '../lib/model3d';
import { isSvgFile, readSvgFile } from '../lib/svg';
import { flushDeckSave, useDeckStore } from '../store/deckStore';
import { toast } from '../store/uiStore';
import { AssetPicker } from './AssetPicker';
import { AiPanel } from './AiPanel';
import { ExportDialog } from './ExportDialog';
import { FrameTrack } from './FrameTrack';
import { Icon } from './Icon';
import { Inspector } from './Inspector';
import { ObjectList } from './ObjectList';
import { Presentation } from './Presentation';
import { Stage, type StageApi } from './Stage';
import { TopBar } from './TopBar';
import { Modal } from './ui';

interface EditorProps {
  deckId: string;
  onBack: () => void;
}

interface PresentState {
  startIndex: number;
  entryView: ViewState;
  fullscreenFailed: boolean;
}

export function Editor({ deckId, onBack }: EditorProps) {
  const deck = useDeckStore((state) => state.deck);
  const loading = useDeckStore((state) => state.loading);
  const loadError = useDeckStore((state) => state.loadError);
  const readonly = useDeckStore((state) => state.readonly);
  const saveStatus = useDeckStore((state) => state.saveStatus);
  const cameraRequest = useDeckStore((state) => state.cameraRequest);
  const selectedObjectId = useDeckStore((state) => state.selectedObjectId);
  const selectedIds = useDeckStore((state) => state.selectedIds);
  const imageRetry = useDeckStore((state) => state.imageRetry);
  const canUndo = useDeckStore((state) => state.past.length > 0);
  const canRedo = useDeckStore((state) => state.future.length > 0);

  const stageRef = useRef<StageApi>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const mediaInput = useRef<HTMLInputElement>(null);
  const modelInput = useRef<HTMLInputElement>(null);
  const lottieInput = useRef<HTMLInputElement>(null);
  const pendingReplace = useRef<string | null>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [narrow, setNarrow] = useState(() => window.innerWidth < 1024);
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [startChoice, setStartChoice] = useState(false);
  const [presentState, setPresentState] = useState<PresentState | null>(null);
  const [saveErrorOpen, setSaveErrorOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [exportView, setExportView] = useState<ViewState | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const modalOpen = Boolean(
    startChoice || saveErrorOpen || leaveOpen || presentState || assetsOpen || exportView || aiOpen,
  );
  const modalOpenRef = useRef(modalOpen);
  modalOpenRef.current = modalOpen;

  const capture = (): ViewState => stageRef.current?.captureView() ?? useDeckStore.getState().view;

  useEffect(() => {
    void useDeckStore.getState().openDeck(deckId);
    return () => {
      void useDeckStore.getState().closeDeck(true);
    };
  }, [deckId]);

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 1024);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    const flush = () => {
      void flushDeckSave();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const unsaved = !readonly && saveStatus.state !== 'saved';
  const unsavedRef = useRef(unsaved);
  unsavedRef.current = unsaved;

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!unsavedRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (modalOpenRef.current) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      const state = useDeckStore.getState();
      if (state.readonly) return;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) state.redo();
        else state.undo();
        return;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && (state.selectedIds.length > 0 || state.selectedObjectId)) {
        event.preventDefault();
        const ids = state.selectedIds.length > 0 ? state.selectedIds : state.selectedObjectId ? [state.selectedObjectId] : [];
        state.removeObjects(ids);
        return;
      }
      if (mod && event.key.toLowerCase() === 'a' && !event.shiftKey) {
        event.preventDefault();
        state.selectObjects(state.deck?.objects.map((object) => object.id) ?? []);
        return;
      }
      if ((event.key === 'f' || event.key === 'F') && state.selectedObjectId) {
        event.preventDefault();
        state.requestFocus(state.selectedObjectId);
        return;
      }
      if (event.key === 'Escape' && state.selectedObjectId) {
        event.preventDefault();
        state.selectObject(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleBack = async () => {
    const ok = await useDeckStore.getState().closeDeck();
    if (!ok) {
      setLeaveOpen(true);
      return;
    }
    onBack();
  };

  const retrySave = async () => {
    if (retrying) return;
    setRetrying(true);
    const ok = await flushDeckSave();
    setRetrying(false);
    if (ok) {
      setSaveErrorOpen(false);
      setLeaveOpen(false);
      toast('已保存', 'success');
    } else {
      toast(useDeckStore.getState().saveStatus.message ?? '保存失败', 'error');
    }
  };

  const handleExport = () => {
    const current = useDeckStore.getState().deck;
    if (!current) return;
    const result = exportDeckFile(current);
    if (result.ok) {
      toast(`已导出 · ${result.filename} · ${formatBytes(result.size)}`, 'success');
    } else {
      toast(result.message, 'error');
    }
  };

  const handleSvgFile = async (file: File, replaceId: string | null, point?: { x: number; y: number }) => {
    try {
      const result = await readSvgFile(file);
      const state = useDeckStore.getState();
      if (replaceId) {
        const object = state.deck?.objects.find((item) => item.id === replaceId);
        if (!object || (object.type !== 'image' && object.type !== 'svg')) return;
        state.updateObject(replaceId, {
          src: result.src,
          naturalWidth: result.naturalWidth,
          naturalHeight: result.naturalHeight,
        });
        toast('SVG 已替换', 'success');
        return;
      }
      const id = state.addSvg(result.src, result.naturalWidth, result.naturalHeight, point);
      if (!id) {
        toast(`已达到单作品 ${LIMITS.objects} 个对象上限`, 'error');
        return;
      }
      toast('SVG 图形已添加到画板', 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'SVG 添加失败', 'error');
    }
  };

  const handleImageFile = async (file: File, replaceId: string | null, point?: { x: number; y: number }) => {
    try {
      if (isSvgFile(file)) {
        await handleSvgFile(file, replaceId, point);
        return;
      }
      const result = await readImageFile(file);
      const state = useDeckStore.getState();
      if (replaceId) {
        const object = state.deck?.objects.find((item) => item.id === replaceId);
        if (!object) return;
        state.updateObject(replaceId, {
          src: result.src,
          naturalWidth: result.naturalWidth,
          naturalHeight: result.naturalHeight,
        });
        toast('图片已替换', 'success');
      } else {
        const id = state.addImage(result.src, result.naturalWidth, result.naturalHeight, point);
        if (!id) {
          toast(`已达到单作品 ${LIMITS.objects} 个对象上限`, 'error');
          return;
        }
      }
      if (!result.decoded) toast(result.error ?? '图片解码失败，已用占位图显示', 'error');
    } catch (error) {
      toast(error instanceof Error ? error.message : '图片添加失败', 'error');
    }
  };

  const pickImage = (replaceId?: string) => {
    pendingReplace.current = replaceId ?? null;
    imageInput.current?.click();
  };

  const handleMediaFile = async (file: File, replaceId: string | null, point?: { x: number; y: number }) => {
    try {
      const result = await readMediaFile(file);
      const state = useDeckStore.getState();
      if (replaceId) {
        const object = state.deck?.objects.find((item) => item.id === replaceId);
        if (!object || (object.type !== 'video' && object.type !== 'audio')) return;
        if (object.type !== result.kind) {
          toast('素材类型不一致，视频对象只能替换视频，音频对象只能替换音频', 'error');
          return;
        }
        const patch =
          result.kind === 'video'
            ? {
                src: result.src,
                naturalWidth: result.width,
                naturalHeight: result.height,
                duration: result.duration,
              }
            : { src: result.src, duration: result.duration };
        state.updateObject(replaceId, patch);
        toast('媒体已替换', 'success');
      } else {
        const id = state.addMedia(
          result.kind,
          result.src,
          { width: result.width, height: result.height, duration: result.duration },
          point,
        );
        if (!id) {
          toast(`已达到单作品 ${LIMITS.objects} 个对象上限`, 'error');
          return;
        }
      }
      if (result.error) toast(result.error, 'error');
    } catch (error) {
      toast(error instanceof Error ? error.message : '媒体添加失败', 'error');
    }
  };

  const pickMedia = (replaceId?: string) => {
    pendingReplace.current = replaceId ?? null;
    mediaInput.current?.click();
  };

  const handleModelFile = async (file: File, replaceId: string | null, point?: { x: number; y: number }) => {
    try {
      const payload = await readAssetFile(file);
      const format = payload.meta.format ?? modelFormatOf(file.name);
      if (!format) throw new Error('无法识别该模型格式');
      const state = useDeckStore.getState();
      if (replaceId) {
        const object = state.deck?.objects.find((item) => item.id === replaceId);
        if (!object || object.type !== 'model') return;
        state.updateObject(replaceId, { src: payload.src, format });
        toast('模型已替换', 'success');
      } else {
        const id = state.addModel(payload.src, format, point);
        if (!id) {
          toast(`已达到单作品 ${LIMITS.objects} 个对象上限`, 'error');
          return;
        }
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : '模型添加失败', 'error');
    }
  };

  const pickModel = (replaceId?: string) => {
    pendingReplace.current = replaceId ?? null;
    modelInput.current?.click();
  };

  const handleLottieFile = async (file: File, replaceId: string | null, point?: { x: number; y: number }) => {
    try {
      const payload = await readLottieFile(file);
      const state = useDeckStore.getState();
      if (replaceId) {
        const object = state.deck?.objects.find((item) => item.id === replaceId);
        if (!object || object.type !== 'lottie') return;
        state.updateObject(replaceId, {
          src: payload.src,
          naturalWidth: payload.naturalWidth,
          naturalHeight: payload.naturalHeight,
          duration: payload.duration,
        });
        toast('Lottie 动画已替换', 'success');
        return;
      }
      const id = state.addLottie(
        payload.src,
        payload.naturalWidth,
        payload.naturalHeight,
        payload.duration,
        point,
      );
      if (!id) {
        toast(`已达到单作品 ${LIMITS.objects} 个对象上限`, 'error');
        return;
      }
      toast('Lottie 动画已添加到画板', 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Lottie 添加失败', 'error');
    }
  };

  const pickLottie = (replaceId?: string) => {
    pendingReplace.current = replaceId ?? null;
    lottieInput.current?.click();
  };

  const handleAssetPick = (asset: AssetMeta, src: string) => {
    const state = useDeckStore.getState();
    if (!state.deck) return;
    let id: string | null = null;
    if (asset.kind === 'image') {
      const isSvg = asset.mime === 'image/svg+xml' || asset.ext === 'svg';
      id = isSvg
        ? state.addSvg(src, asset.width || 800, asset.height || 600)
        : state.addImage(src, asset.width || 1600, asset.height || 900);
    } else if (asset.kind === 'video' || asset.kind === 'audio') {
      id = state.addMedia(
        asset.kind,
        src,
        { width: asset.width || 1280, height: asset.height || 720, duration: asset.duration },
      );
    } else if (asset.kind === 'model') {
      const format = asset.format ?? modelFormatOf(asset.name);
      if (!format) {
        toast('无法识别该模型格式', 'error');
        return;
      }
      id = state.addModel(src, format);
    } else if (asset.kind === 'lottie') {
      id = state.addLottie(src, asset.width || 800, asset.height || 600, asset.duration);
    } else {
      toast('该资源类型暂不支持插入画板', 'error');
      return;
    }
    if (!id) {
      toast(`已达到单作品 ${LIMITS.objects} 个对象上限`, 'error');
      return;
    }
    toast(`已插入「${asset.name}」`, 'success');
  };

  const handleFile = (file: File, replaceId: string | null, point?: { x: number; y: number }) => {
    if (isSvgFile(file)) void handleSvgFile(file, replaceId, point);
    else if (isAcceptedImage(file)) void handleImageFile(file, replaceId, point);
    else if (isModelFile(file)) void handleModelFile(file, replaceId, point);
    else if (mediaKindOf(file)) void handleMediaFile(file, replaceId, point);
    else if (isLottieFile(file)) void handleLottieFile(file, replaceId, point);
    else toast('不支持的文件类型', 'error');
  };

  const captureFrame = () => {
    const state = useDeckStore.getState();
    if (!state.deck) return;
    if (state.deck.frames.length >= LIMITS.frames) {
      toast(`已达到 ${LIMITS.frames} 个视点上限，删除后可继续添加`, 'error');
      return;
    }
    state.captureFrame(capture());
    toast('已捕获当前视图作为一个视点', 'success');
  };

  const updateFrameView = (id: string) => {
    useDeckStore.getState().updateFrameView(id, capture());
    toast('已用当前视图更新该视点', 'success');
  };

  const startPresentation = (startIndex: number) => {
    setStartChoice(false);
    const entryView = capture();
    let failed = false;
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      try {
        const request = document.documentElement.requestFullscreen();
        if (request) {
          request.catch(() => {
            setPresentState((current) => (current ? { ...current, fullscreenFailed: true } : current));
          });
        }
      } catch {
        failed = true;
      }
    }
    setPresentState({ startIndex, entryView, fullscreenFailed: failed });
  };

  const handlePresent = () => {
    const state = useDeckStore.getState();
    if (!state.deck) return;
    if (state.deck.frames.length === 0) {
      toast('作品还没有视点，已从当前视图开始', 'info');
      startPresentation(-1);
      return;
    }
    setStartChoice(true);
  };

  const exitPresentation = (finalView: ViewState, frameId: string | null) => {
    const state = useDeckStore.getState();
    state.commitView(finalView);
    useDeckStore.setState({
      selectedObjectId: null,
      selectedIds: [],
      selectedFrameId: null,
      currentFrameId: frameId,
    });
    setPresentState(null);
    void stageRef.current?.flyTo(finalView, 0.01);
  };

  if (loadError) {
    return (
      <div className="screen-center">
        <div className="screen-card">
          <Icon name="alert" size={26} />
          <h2>作品无法打开</h2>
          <p>{loadError}</p>
          <div className="button-row center">
            <button className="btn btn-ghost" onClick={onBack}>
              返回首页
            </button>
            <button className="btn btn-primary" onClick={() => void useDeckStore.getState().openDeck(deckId)}>
              重试
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (loading || !deck) {
    return (
      <div className="screen-center">
        <div className="loading-mark" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <p>正在读取作品…</p>
      </div>
    );
  }

  const mode = readonly ? 'view' : 'edit';

  return (
    <div className="editor">
      {narrow && (
        <div className="narrow-banner">
          <Icon name="alert" size={14} />
          <span>建议使用更宽的窗口（≥ 1024px）。编辑功能保留，部分面板可能需要滚动。</span>
        </div>
      )}
      <TopBar
        deck={deck}
        readonly={readonly}
        saveStatus={saveStatus}
        canUndo={canUndo}
        canRedo={canRedo}
        onBack={() => void handleBack()}
        onRename={(title) => useDeckStore.getState().renameDeck(title)}
        onUndo={() => useDeckStore.getState().undo()}
        onRedo={() => useDeckStore.getState().redo()}
        onPresent={handlePresent}
        onExport={handleExport}
        onExportVideo={() => setExportView(capture())}
        onOpenAi={() => setAiOpen(true)}
        onOpenAssets={() => setAssetsOpen(true)}
        onShowSaveError={() => setSaveErrorOpen(true)}
      />
      {readonly && (
        <div className="readonly-banner">
          <Icon name="lock" size={14} />
          <span>该作品已在另一窗口编辑，当前为只读。关闭原窗口后刷新即可恢复编辑。</span>
        </div>
      )}

      <div className={`editor-body${leftCollapsed ? ' is-left-collapsed' : ''}`}>
        <ObjectList
          objects={deck.objects}
          selectedId={selectedObjectId}
          selectedIds={selectedIds}
          readonly={readonly}
          collapsed={leftCollapsed}
          onToggleCollapsed={() => setLeftCollapsed((value) => !value)}
          onSelect={(id, additive) => {
            if (additive) useDeckStore.getState().toggleObjectSelection(id);
            else useDeckStore.getState().selectObject(id);
          }}
          onRangeSelect={(ids) => useDeckStore.getState().selectObjects(ids)}
          onToggleVisible={(id, visible) => useDeckStore.getState().updateObject(id, { visible })}
          onReorder={(source, target) => useDeckStore.getState().moveObjectLayer(source, target)}
          onAddText={() => useDeckStore.getState().addText()}
          onAddImage={() => pickImage()}
          onAddVideo={() => pickMedia()}
          onAddAudio={() => pickMedia()}
          onAddModel={() => pickModel()}
          onAddLottie={() => pickLottie()}
          onAddShape={() => useDeckStore.getState().addShape('rect')}
        />

        <main className="stage-column">
          <Stage
            ref={stageRef}
            deck={deck}
            mode={mode}
            selectedObjectId={selectedObjectId}
            selectedObjectIds={selectedIds}
            cameraRequest={cameraRequest}
            imageRetry={imageRetry}
            initialView={deck.lastView}
            onViewChange={(next) => useDeckStore.getState().commitView(next)}
            onSelectMany={(ids) => useDeckStore.getState().selectObjects(ids)}
            onMoveObject={(id, x, y) => useDeckStore.getState().updateObject(id, { x, y }, `move:${id}`)}
            onResizeObject={(id, patch) => useDeckStore.getState().updateObject(id, patch, `resize:${id}`)}
            onGestureEnd={() => useDeckStore.getState().endHistoryCoalesce()}
            onImageError={(id, message) => useDeckStore.getState().markImageError(id, message)}
            onAddText={() => useDeckStore.getState().addText()}
            onAddShape={(shape) => useDeckStore.getState().addShape(shape)}
            onAddFile={(file, point) => handleFile(file, null, point)}
            onPickImage={() => pickImage()}
            onDrawPath={(points, box, strokeWidth) => {
              const id = useDeckStore.getState().addPath(points, box, strokeWidth);
              if (!id) toast('路径点太少，无法生成图形', 'error');
            }}
            onTextCommit={(id, text) => {
              if (!text.trim()) useDeckStore.getState().removeObject(id);
              else useDeckStore.getState().updateObject(id, { text });
            }}
          />
        </main>

        <Inspector
          readonly={readonly}
          onReplaceImage={(id) => pickImage(id)}
          onReplaceMedia={(id) => pickMedia(id)}
          onReplaceModel={(id) => pickModel(id)}
          onReplaceLottie={(id) => pickLottie(id)}
          onUpdateFrameView={updateFrameView}
        />
      </div>

      <FrameTrack readonly={readonly} onCapture={captureFrame} />

      <input
        ref={imageInput}
        type="file"
        hidden
        accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,.svg"
        onChange={(event) => {
          const file = event.target.files?.[0];
          const replaceId = pendingReplace.current;
          pendingReplace.current = null;
          event.target.value = '';
          if (file) void handleImageFile(file, replaceId);
        }}
      />

      <input
        ref={mediaInput}
        type="file"
        hidden
        accept="video/*,audio/*,.mkv,.avi,.mov,.flv,.wmv,.mp3,.wav,.flac,.m4a,.aac,.ogg,.opus"
        onChange={(event) => {
          const file = event.target.files?.[0];
          const replaceId = pendingReplace.current;
          pendingReplace.current = null;
          event.target.value = '';
          if (file) void handleMediaFile(file, replaceId);
        }}
      />

      <input
        ref={modelInput}
        type="file"
        hidden
        accept={MODEL_ACCEPT}
        onChange={(event) => {
          const file = event.target.files?.[0];
          const replaceId = pendingReplace.current;
          pendingReplace.current = null;
          event.target.value = '';
          if (file) void handleModelFile(file, replaceId);
        }}
      />

      <input
        ref={lottieInput}
        type="file"
        hidden
        accept=".json,.lottie,application/json"
        onChange={(event) => {
          const file = event.target.files?.[0];
          const replaceId = pendingReplace.current;
          pendingReplace.current = null;
          event.target.value = '';
          if (file) void handleLottieFile(file, replaceId);
        }}
      />

      {exportView && deck && (
        <ExportDialog deck={deck} view={exportView} onClose={() => setExportView(null)} />
      )}

      {aiOpen && deck && <AiPanel deck={deck} onClose={() => setAiOpen(false)} />}

      {assetsOpen && (
        <AssetPicker
          kinds={['image', 'video', 'audio', 'model', 'lottie']}
          onPick={handleAssetPick}
          onClose={() => setAssetsOpen(false)}
        />
      )}

      {startChoice && deck.frames.length > 0 && (
        <Modal
          title="从哪里开始演示？"
          eyebrow="PRESENT"
          onClose={() => setStartChoice(false)}
          width={500}
          footer={
            <button className="btn btn-ghost" onClick={() => setStartChoice(false)}>
              取消
            </button>
          }
        >
          <div className="start-options">
            <button className="start-option is-primary" onClick={() => startPresentation(0)}>
              <span className="start-option-icon">
                <Icon name="play" size={18} />
              </span>
              <span>
                <b>从第一个视点开始</b>
                <small>
                  {deck.frames[0].name} · 共 {deck.frames.length} 个视点
                </small>
              </span>
            </button>
            <button className="start-option" onClick={() => startPresentation(-1)}>
              <span className="start-option-icon">
                <Icon name="focus" size={18} />
              </span>
              <span>
                <b>从当前视图开始</b>
                <small>按当前取景直接开始，之后可用 → 进入第一个视点</small>
              </span>
            </button>
          </div>
          <p className="modal-note">
            演示中可自由拖拽环绕、滚轮缩放；双击舞台或按 R 回到当前视点，Esc 退出并回到编辑器。
          </p>
        </Modal>
      )}

      {saveErrorOpen && (
        <Modal
          title="保存失败"
          eyebrow="SAVE ERROR"
          onClose={() => setSaveErrorOpen(false)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setSaveErrorOpen(false)}>
                稍后处理
              </button>
              <button className="btn btn-light" onClick={handleExport}>
                <Icon name="download" size={15} /> 导出工程
              </button>
              <button className="btn btn-primary" disabled={retrying} onClick={() => void retrySave()}>
                {retrying ? '正在重试…' : '重试保存'}
              </button>
            </>
          }
        >
          <p>当前编辑状态仍保留在页面中，但尚未写入浏览器本地存储。</p>
          <p className="error-note">{saveStatus.message ?? '未知错误'}</p>
          <p className="modal-note">
            可以先导出工程文件避免丢失；本地空间不足时，可删除不再需要的作品后重试。
          </p>
        </Modal>
      )}

      {leaveOpen && (
        <Modal
          title="保存失败，仍要离开？"
          eyebrow="UNSAVED"
          onClose={() => setLeaveOpen(false)}
          footer={
            <div className="leave-actions">
              <button className="btn btn-ghost" onClick={() => setLeaveOpen(false)}>
                留下
              </button>
              <button className="btn btn-light" onClick={handleExport}>
                导出工程
              </button>
              <button className="btn btn-light" disabled={retrying} onClick={() => void retrySave()}>
                重试保存
              </button>
              <button
                className="btn btn-danger"
                onClick={() => {
                  void useDeckStore.getState().closeDeck(true).then(() => onBack());
                }}
              >
                仍然离开
              </button>
            </div>
          }
        >
          <p>离开后，尚未保存的修改可能丢失。建议先导出工程或重试保存。</p>
          <p className="error-note">{saveStatus.message ?? '保存失败'}</p>
        </Modal>
      )}

      {presentState && (
        <Presentation
          deck={deck}
          startIndex={presentState.startIndex}
          entryView={presentState.entryView}
          fullscreenFailed={presentState.fullscreenFailed}
          onExit={exitPresentation}
        />
      )}
    </div>
  );
}
