import { useEffect, useRef, useState } from 'react';
import type { ViewState } from '../types';
import { LIMITS } from '../lib/constants';
import { exportDeckFile } from '../lib/file';
import { formatBytes, readImageFile } from '../lib/image';
import { flushDeckSave, useDeckStore } from '../store/deckStore';
import { toast } from '../store/uiStore';
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
  const imageRetry = useDeckStore((state) => state.imageRetry);
  const canUndo = useDeckStore((state) => state.past.length > 0);
  const canRedo = useDeckStore((state) => state.future.length > 0);

  const stageRef = useRef<StageApi>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const pendingReplace = useRef<string | null>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [narrow, setNarrow] = useState(() => window.innerWidth < 1024);
  const [startChoice, setStartChoice] = useState(false);
  const [presentState, setPresentState] = useState<PresentState | null>(null);
  const [saveErrorOpen, setSaveErrorOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const modalOpen = Boolean(startChoice || saveErrorOpen || leaveOpen || presentState);
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
      if ((event.key === 'Delete' || event.key === 'Backspace') && state.selectedObjectId) {
        event.preventDefault();
        state.removeObject(state.selectedObjectId);
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

  const handleImageFile = async (file: File, replaceId: string | null, point?: { x: number; y: number }) => {
    try {
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
          readonly={readonly}
          collapsed={leftCollapsed}
          onToggleCollapsed={() => setLeftCollapsed((value) => !value)}
          onSelect={(id) => useDeckStore.getState().selectObject(id)}
          onToggleVisible={(id, visible) => useDeckStore.getState().updateObject(id, { visible })}
          onReorder={(source, target) => useDeckStore.getState().moveObjectLayer(source, target)}
          onAddText={() => useDeckStore.getState().addText()}
          onAddImage={() => pickImage()}
          onAddShape={() => useDeckStore.getState().addShape('rect')}
        />

        <main className="stage-column">
          <Stage
            ref={stageRef}
            deck={deck}
            mode={mode}
            selectedObjectId={selectedObjectId}
            cameraRequest={cameraRequest}
            imageRetry={imageRetry}
            initialView={deck.lastView}
            onViewChange={(next) => useDeckStore.getState().commitView(next)}
            onSelect={(id) => useDeckStore.getState().selectObject(id)}
            onMoveObject={(id, x, y) => useDeckStore.getState().updateObject(id, { x, y }, `move:${id}`)}
            onGestureEnd={() => useDeckStore.getState().endHistoryCoalesce()}
            onImageError={(id, message) => useDeckStore.getState().markImageError(id, message)}
            onAddText={() => useDeckStore.getState().addText()}
            onAddShape={(shape) => useDeckStore.getState().addShape(shape)}
            onAddImageFile={(file, point) => void handleImageFile(file, null, point)}
            onPickImage={() => pickImage()}
            onTextCommit={(id, text) => {
              if (!text.trim()) useDeckStore.getState().removeObject(id);
              else useDeckStore.getState().updateObject(id, { text });
            }}
          />
        </main>

        <Inspector
          readonly={readonly}
          onReplaceImage={(id) => pickImage(id)}
          onUpdateFrameView={updateFrameView}
        />
      </div>

      <FrameTrack readonly={readonly} onCapture={captureFrame} />

      <input
        ref={imageInput}
        type="file"
        hidden
        accept="image/png,image/jpeg,image/webp,image/gif"
        onChange={(event) => {
          const file = event.target.files?.[0];
          const replaceId = pendingReplace.current;
          pendingReplace.current = null;
          event.target.value = '';
          if (file) void handleImageFile(file, replaceId);
        }}
      />

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
