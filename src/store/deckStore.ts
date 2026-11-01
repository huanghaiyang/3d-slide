import { create } from 'zustand';
import type {
  CameraRequest,
  Deck,
  Frame,
  ImageObject,
  MediaKind,
  ModelFormat,
  SaveStatus,
  ShapeKind,
  ShapeObject,
  SlideObject,
  TextObject,
  ViewState,
} from '../types';
import { LIMITS, DEFAULT_VIEW, DEFAULT_SHAPE_COLOR } from '../lib/constants';
import {
  autoTextHeight,
  clampNumber,
  createAudioObject,
  createImageObject,
  createLottieObject,
  createModelObject,
  createShapeObject,
  createSvgObject,
  createTextObject,
  createVideoObject,
  nameForObject,
  nextDepth,
  nextFrameName,
} from '../lib/deck';
import { acquireDeckLock, getDeck, putDeck, releaseDeckLock } from '../lib/storage';
import { SHAPE_LABELS } from '../types';

type ObjectPatch = Partial<SlideObject>;

interface DeckStore {
  deck: Deck | null;
  view: ViewState;
  selectedObjectId: string | null;
  selectedIds: string[];
  selectedFrameId: string | null;
  currentFrameId: string | null;
  readonly: boolean;
  loading: boolean;
  loadError: string | null;
  saveStatus: SaveStatus;
  past: Deck[];
  future: Deck[];
  cameraRequest: CameraRequest | null;
  imageErrors: Record<string, string>;
  imageRetry: Record<string, number>;

  openDeck: (id: string) => Promise<void>;
  closeDeck: (force?: boolean) => Promise<boolean>;
  loadDeckForTest: (deck: Deck, readonly?: boolean) => void;

  setSaveStatus: (status: SaveStatus) => void;
  commitView: (view: ViewState) => void;
  requestCamera: (request: Omit<CameraRequest, 'id'>) => void;
  requestReset: () => void;
  requestFocus: (objectId: string) => void;

  selectObject: (id: string | null) => void;
  selectObjects: (ids: string[]) => void;
  toggleObjectSelection: (id: string) => void;
  removeObjects: (ids: string[]) => void;
  selectFrame: (id: string | null, fly?: boolean) => void;
  setCurrentFrame: (id: string | null) => void;

  renameDeck: (title: string) => void;
  updateDeckSettings: (patch: Partial<Pick<Deck, 'background' | 'defaultDuration' | 'showProgress'>>, historyKey?: string) => void;

  addText: () => string | null;
  addShape: (shape: ShapeKind) => string | null;
  addSvg: (src: string, naturalWidth: number, naturalHeight: number, point?: { x: number; y: number }) => string | null;
  addLottie: (
    src: string,
    naturalWidth: number,
    naturalHeight: number,
    duration: number,
    point?: { x: number; y: number },
  ) => string | null;
  addPath: (
    points: number[],
    box: { x: number; y: number; width: number; height: number },
    strokeWidth?: number,
  ) => string | null;
  addImage: (src: string, naturalWidth: number, naturalHeight: number, point?: { x: number; y: number }) => string | null;
  addMedia: (
    kind: MediaKind,
    src: string,
    meta: { width: number; height: number; duration: number },
    point?: { x: number; y: number },
  ) => string | null;
  addModel: (src: string, format: ModelFormat, point?: { x: number; y: number }) => string | null;
  updateObject: (id: string, patch: ObjectPatch, historyKey?: string) => void;
  removeObject: (id: string) => void;
  removeObjectSilent: (id: string) => void;
  swapDepth: (sourceId: string, targetId: string) => void;
  moveObjectLayer: (sourceId: string, targetId: string) => void;
  endHistoryCoalesce: () => void;

  captureFrame: (view: ViewState) => void;
  updateFrameView: (id: string, view: ViewState) => void;
  renameFrame: (id: string, name: string) => void;
  setFrameDuration: (id: string, duration: number) => void;
  deleteFrame: (id: string) => void;
  reorderFrame: (sourceId: string, targetId: string) => void;

  markImageError: (id: string, message: string) => void;
  retryImage: (id: string) => void;
  clearImageError: (id: string) => void;

  undo: () => void;
  redo: () => void;
}

let autosaveTimer: number | undefined;
let requestSeq = 0;
let lastHistoryKey: string | null = null;
let lastHistoryAt = 0;
let savingPromise: Promise<boolean> | null = null;

const EMPTY_STATUS: SaveStatus = { state: 'saved', at: 0 };

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function historyAllowed(key?: string): boolean {
  if (!key) {
    lastHistoryKey = null;
    lastHistoryAt = 0;
    return true;
  }
  const now = Date.now();
  if (key === lastHistoryKey && now - lastHistoryAt < 1000) {
    lastHistoryAt = now;
    return false;
  }
  lastHistoryKey = key;
  lastHistoryAt = now;
  return true;
}

function validId<T extends { id: string }>(list: T[], id: string | null): string | null {
  if (!id) return null;
  return list.some((item) => item.id === id) ? id : null;
}

function selectedObjectFallback(deck: Deck, id: string | null): string[] {
  const valid = validId(deck.objects, id);
  return valid ? [valid] : [];
}

function clearTimer() {
  if (autosaveTimer !== undefined) {
    window.clearTimeout(autosaveTimer);
    autosaveTimer = undefined;
  }
}

function markDirty() {
  const { saveStatus } = useDeckStore.getState();
  if (saveStatus.state === 'error' || saveStatus.state === 'saving') return;
  useDeckStore.setState({ saveStatus: { state: 'dirty' } });
}

function scheduleAutosave() {
  const state = useDeckStore.getState();
  if (state.readonly || !state.deck) return;
  if (state.saveStatus.state === 'error') return;
  clearTimer();
  autosaveTimer = window.setTimeout(() => {
    autosaveTimer = undefined;
    void saveNow();
  }, 2000);
}

async function saveNow(): Promise<boolean> {
  const state = useDeckStore.getState();
  if (!state.deck || state.readonly) return true;
  if (savingPromise) return savingPromise;
  if (state.saveStatus.state === 'saved') return true;

  const snapshot = state.deck;
  useDeckStore.setState({ saveStatus: { state: 'saving' } });
  savingPromise = (async () => {
    try {
      await putDeck(snapshot);
      const current = useDeckStore.getState();
      if (current.deck === snapshot) {
        useDeckStore.setState({ saveStatus: { state: 'saved', at: Date.now() } });
      } else if (current.deck) {
        if (current.saveStatus.state !== 'error') {
          useDeckStore.setState({ saveStatus: { state: 'dirty' } });
          scheduleAutosave();
        }
      }
      return true;
    } catch (error) {
      useDeckStore.setState({
        saveStatus: { state: 'error', message: errorMessage(error, '保存失败') },
      });
      return false;
    } finally {
      savingPromise = null;
    }
  })();
  return savingPromise;
}

export async function flushDeckSave(): Promise<boolean> {
  const first = await saveNow();
  if (!first) return false;
  const state = useDeckStore.getState();
  if (state.saveStatus.state === 'dirty') return saveNow();
  return true;
}

function normalizeEditedObject(object: SlideObject, patch: ObjectPatch): SlideObject {
  const next = { ...object, ...patch } as SlideObject;
  next.name = String(next.name || object.name).slice(0, LIMITS.objectNameChars) || object.name;
  next.x = clampNumber(next.x, -LIMITS.coord, LIMITS.coord, object.x);
  next.y = clampNumber(next.y, -LIMITS.coord, LIMITS.coord, object.y);
  next.z = clampNumber(next.z, -LIMITS.depth, LIMITS.depth, object.z);
  next.width = clampNumber(next.width, LIMITS.minSize, LIMITS.maxSize, object.width);
  next.height = clampNumber(next.height, LIMITS.minSize, LIMITS.maxSize, object.height);
  next.rotation = clampNumber(next.rotation, LIMITS.minRotation, LIMITS.maxRotation, object.rotation);
  next.rotationX = clampNumber(next.rotationX ?? 0, LIMITS.minRotation, LIMITS.maxRotation, 0);
  next.rotationY = clampNumber(next.rotationY ?? 0, LIMITS.minRotation, LIMITS.maxRotation, 0);
  next.opacity = clampNumber(next.opacity, 0, 100, object.opacity);

  if (next.type === 'text') {
    const text = next as TextObject;
    text.text = text.text.slice(0, LIMITS.textChars);
    text.fontSize = clampNumber(text.fontSize, LIMITS.minFontSize, LIMITS.maxFontSize, 48);
    text.lineHeight = clampNumber(text.lineHeight, LIMITS.minLineHeight, LIMITS.maxLineHeight, 1.4);
    text.depth3d = clampNumber(text.depth3d ?? 0, 0, LIMITS.maxTextDepth, 0);
    text.height = autoTextHeight(text);
  } else if (next.type === 'image') {
    const image = next as ImageObject;
    const widthChanged = patch.width !== undefined;
    const heightChanged = patch.height !== undefined;
    if (image.aspectLocked && image.naturalWidth > 0 && image.naturalHeight > 0) {
      const ratio = image.naturalWidth / image.naturalHeight;
      if (widthChanged && !heightChanged) image.height = image.width / ratio;
      else if (heightChanged && !widthChanged) image.width = image.height * ratio;
    }
  }
  return next;
}

export const useDeckStore = create<DeckStore>((set, get) => {
  function applyDeck(
    updater: (deck: Deck) => Deck,
    options: { historyKey?: string; noHistory?: boolean } = {},
  ): boolean {
    const state = get();
    if (!state.deck || state.readonly) return false;
    const previous = state.deck;
    const next = updater(previous);
    if (next === previous) return false;
    const pushHistory =
      !options.noHistory && historyAllowed(options.historyKey);
    const past = pushHistory ? [...state.past, previous].slice(-50) : state.past;
    const future = pushHistory ? [] : state.future;
    set({
      deck: { ...next, updatedAt: Date.now() },
      past,
      future,
    });
    markDirty();
    scheduleAutosave();
    return true;
  }

  function replaceDeckFromHistory(deck: Deck) {
    const state = get();
    const restored: Deck = { ...deck, lastView: state.view, updatedAt: Date.now() };
    const selectedIds = state.selectedIds.filter((id) => validId(restored.objects, id));
    set({
      deck: restored,
      selectedObjectId: validId(restored.objects, state.selectedObjectId),
      selectedIds: selectedIds.length > 0 ? selectedIds : selectedObjectFallback(restored, state.selectedObjectId),
      selectedFrameId: validId(restored.frames, state.selectedFrameId),
      currentFrameId: validId(restored.frames, state.currentFrameId),
    });
    markDirty();
    scheduleAutosave();
  }

  return {
    deck: null,
    view: { ...DEFAULT_VIEW, target: { ...DEFAULT_VIEW.target } },
    selectedObjectId: null,
    selectedIds: [],
    selectedFrameId: null,
    currentFrameId: null,
    readonly: false,
    loading: false,
    loadError: null,
    saveStatus: EMPTY_STATUS,
    past: [],
    future: [],
    cameraRequest: null,
    imageErrors: {},
    imageRetry: {},

    openDeck: async (id) => {
      clearTimer();
      releaseDeckLock();
      lastHistoryKey = null;
      lastHistoryAt = 0;
      set({
        loading: true,
        loadError: null,
        deck: null,
        selectedObjectId: null,
        selectedIds: [],
        selectedFrameId: null,
        currentFrameId: null,
        past: [],
        future: [],
        cameraRequest: null,
        imageErrors: {},
        imageRetry: {},
        readonly: false,
      });
      try {
        const deck = await getDeck(id);
        if (!deck) throw new Error('作品不存在或已被删除');
        const writable = acquireDeckLock(id);
        set({
          deck,
          view: deck.lastView,
          loading: false,
          readonly: !writable,
          saveStatus: { state: 'saved', at: Date.now() },
        });
      } catch (error) {
        set({
          loading: false,
          loadError: errorMessage(error, '作品数据无法读取'),
          readonly: true,
        });
      }
    },

    closeDeck: async (force = false) => {
      const state = get();
      if (state.deck && !state.readonly && state.saveStatus.state !== 'saved') {
        const ok = await flushDeckSave();
        if (!ok && !force) return false;
      }
      clearTimer();
      releaseDeckLock();
      set({
        deck: null,
        view: { ...DEFAULT_VIEW, target: { ...DEFAULT_VIEW.target } },
        selectedObjectId: null,
        selectedIds: [],
        selectedFrameId: null,
        currentFrameId: null,
        readonly: false,
        loading: false,
        loadError: null,
        saveStatus: EMPTY_STATUS,
        past: [],
        future: [],
        cameraRequest: null,
        imageErrors: {},
        imageRetry: {},
      });
      return true;
    },

    loadDeckForTest: (deck, readonly = false) => {
      set({
        deck,
        view: deck.lastView,
        readonly,
        saveStatus: { state: 'saved', at: Date.now() },
        past: [],
        future: [],
        selectedObjectId: null,
        selectedIds: [],
        selectedFrameId: null,
        currentFrameId: null,
      });
    },

    setSaveStatus: (status) => set({ saveStatus: status }),

    commitView: (view) => {
      const state = get();
      if (!state.deck) return;
      const last = state.deck.lastView;
      const changed =
        Math.abs(last.distance - view.distance) > 0.01 ||
        Math.abs(last.target.x - view.target.x) > 0.01 ||
        Math.abs(last.target.y - view.target.y) > 0.01 ||
        Math.abs(last.target.z - view.target.z) > 0.01 ||
        Math.abs(last.yaw - view.yaw) > 0.001 ||
        Math.abs(last.pitch - view.pitch) > 0.001;
      set({ view });
      if (state.readonly || !changed) return;
      set({
        deck: { ...state.deck, lastView: view, updatedAt: Date.now() },
      });
      markDirty();
      scheduleAutosave();
    },

    requestCamera: (request) => {
      requestSeq += 1;
      set({ cameraRequest: { ...request, id: requestSeq } });
    },

    requestReset: () => {
      requestSeq += 1;
      set({ cameraRequest: { id: requestSeq, type: 'reset' } });
    },

    requestFocus: (objectId) => {
      requestSeq += 1;
      set({ cameraRequest: { id: requestSeq, type: 'focus', objectId } });
    },

    selectObject: (id) => {
      if (!id) {
        set({ selectedObjectId: null, selectedIds: [] });
        return;
      }
      set({ selectedObjectId: id, selectedIds: [id], selectedFrameId: null });
    },

    selectObjects: (ids) => {
      const unique = [...new Set(ids)];
      if (unique.length === 0) {
        set({ selectedObjectId: null, selectedIds: [], selectedFrameId: null });
        return;
      }
      set({ selectedObjectId: unique[0], selectedIds: unique, selectedFrameId: null });
    },

    toggleObjectSelection: (id) => {
      const state = get();
      if (!state.deck) return;
      const exists = state.selectedIds.includes(id);
      if (exists) {
        const next = state.selectedIds.filter((item) => item !== id);
        set({
          selectedIds: next,
          selectedObjectId: next[0] ?? null,
          selectedFrameId: null,
        });
      } else {
        const next = [...state.selectedIds, id];
        set({ selectedIds: next, selectedObjectId: next[0], selectedFrameId: null });
      }
    },

    removeObjects: (ids) => {
      const state = get();
      if (!state.deck || ids.length === 0) return;
      const selected = state.selectedIds.filter((id) => !ids.includes(id));
      const applied = applyDeck((deck) => ({
        ...deck,
        objects: deck.objects.filter((object) => !ids.includes(object.id)),
      }));
      if (applied) {
        set({
          selectedIds: selected,
          selectedObjectId: selected[0] ?? null,
          selectedFrameId: state.selectedFrameId,
        });
      }
    },

    selectFrame: (id, fly = true) => {
      if (!id) {
        set({ selectedFrameId: null });
        return;
      }
      const frame = get().deck?.frames.find((f) => f.id === id);
      set({
        selectedFrameId: id,
        selectedObjectId: null,
        selectedIds: [],
        currentFrameId: id,
      });
      if (fly && frame) {
        requestSeq += 1;
        set({
          cameraRequest: { id: requestSeq, type: 'frame', view: frame.view, duration: 0.4 },
          view: frame.view,
        });
      }
    },

    setCurrentFrame: (id) => set({ currentFrameId: id }),

    renameDeck: (title) => {
      const trimmed = title.trim();
      if (!trimmed) return;
      applyDeck((deck) => ({ ...deck, title: trimmed.slice(0, LIMITS.titleChars) }));
    },

    updateDeckSettings: (patch, historyKey) => {
      applyDeck((deck) => ({ ...deck, ...patch }), { historyKey });
    },

    addText: () => {
      const state = get();
      if (!state.deck) return null;
      if (state.deck.objects.length >= LIMITS.objects) return null;
      const deckAtStart = state.deck;
      const z = nextDepth(deckAtStart.objects);
      const count = (deckAtStart.counters.text ?? 0) + 1;
      const name = nameForObject(deckAtStart, 'text', '文本');
      const id = crypto.randomUUID();
      const object = createTextObject(id, name, state.view, z);
      const applied = applyDeck((deck) => ({
        ...deck,
        objects: [...deck.objects, object],
        counters: { ...deck.counters, text: count },
      }));
      if (!applied) return null;
      set({ selectedObjectId: id, selectedIds: [id], selectedFrameId: null });
      return id;
    },

    addShape: (shape) => {
      const state = get();
      if (!state.deck) return null;
      if (state.deck.objects.length >= LIMITS.objects) return null;
      const deckAtStart = state.deck;
      const z = nextDepth(deckAtStart.objects);
      const count = (deckAtStart.counters[shape] ?? 0) + 1;
      const id = crypto.randomUUID();
      const name = nameForObject(deckAtStart, shape, SHAPE_LABELS[shape]);
      const object = createShapeObject(id, name, shape, state.view, z);
      const applied = applyDeck((deck) => ({
        ...deck,
        objects: [...deck.objects, object],
        counters: { ...deck.counters, [shape]: count },
      }));
      if (!applied) return null;
      set({ selectedObjectId: id, selectedIds: [id], selectedFrameId: null });
      return id;
    },

    addSvg: (src, naturalWidth, naturalHeight, point) => {
      const state = get();
      if (!state.deck) return null;
      if (state.deck.objects.length >= LIMITS.objects) return null;
      const deckAtStart = state.deck;
      const z = nextDepth(deckAtStart.objects);
      const count = (deckAtStart.counters.svg ?? 0) + 1;
      const name = nameForObject(deckAtStart, 'svg', 'SVG');
      const id = crypto.randomUUID();
      const object = createSvgObject(id, name, src, naturalWidth, naturalHeight, state.view, z);
      if (point) {
        object.x = clampNumber(point.x, -LIMITS.coord, LIMITS.coord, object.x);
        object.y = clampNumber(point.y, -LIMITS.coord, LIMITS.coord, object.y);
      }
      const applied = applyDeck((deck) => ({
        ...deck,
        objects: [...deck.objects, object],
        counters: { ...deck.counters, svg: count },
      }));
      if (!applied) return null;
      set({ selectedObjectId: id, selectedIds: [id], selectedFrameId: null });
      return id;
    },

    addLottie: (src, naturalWidth, naturalHeight, duration, point) => {
      const state = get();
      if (!state.deck) return null;
      if (state.deck.objects.length >= LIMITS.objects) return null;
      const deckAtStart = state.deck;
      const z = nextDepth(deckAtStart.objects);
      const count = (deckAtStart.counters.lottie ?? 0) + 1;
      const name = nameForObject(deckAtStart, 'lottie', 'Lottie');
      const id = crypto.randomUUID();
      const object = createLottieObject(id, name, src, naturalWidth, naturalHeight, duration, state.view, z);
      if (point) {
        object.x = clampNumber(point.x, -LIMITS.coord, LIMITS.coord, object.x);
        object.y = clampNumber(point.y, -LIMITS.coord, LIMITS.coord, object.y);
      }
      const applied = applyDeck((deck) => ({
        ...deck,
        objects: [...deck.objects, object],
        counters: { ...deck.counters, lottie: count },
      }));
      if (!applied) return null;
      set({ selectedObjectId: id, selectedIds: [id], selectedFrameId: null });
      return id;
    },

    addPath: (points, box, strokeWidth = 6) => {
      const state = get();
      if (!state.deck || points.length < 4) return null;
      if (state.deck.objects.length >= LIMITS.objects) return null;
      const deckAtStart = state.deck;
      const z = nextDepth(deckAtStart.objects);
      const count = (deckAtStart.counters.path ?? 0) + 1;
      const id = crypto.randomUUID();
      const safeWidth = Math.max(LIMITS.minSize, box.width);
      const safeHeight = Math.max(LIMITS.minSize, box.height);
      const object: ShapeObject = {
        id,
        type: 'shape',
        name: nameForObject(deckAtStart, 'path', '手绘'),
        x: clampNumber(box.x + safeWidth / 2, -LIMITS.coord, LIMITS.coord, 0),
        y: clampNumber(box.y + safeHeight / 2, -LIMITS.coord, LIMITS.coord, 0),
        z,
        width: clampNumber(safeWidth, LIMITS.minSize, LIMITS.maxSize, 400),
        height: clampNumber(safeHeight, LIMITS.minSize, LIMITS.maxSize, 300),
        rotation: 0,
        rotationX: 0,
        rotationY: 0,
        opacity: 100,
        visible: true,
        shape: 'path',
        fill: DEFAULT_SHAPE_COLOR,
        stroke: DEFAULT_SHAPE_COLOR,
        strokeWidth: clampNumber(strokeWidth, 1, LIMITS.maxStroke, 6),
        points: points.slice(0, LIMITS.maxPathPoints * 2).map((value) => clampNumber(value, 0, 1, 0)),
      };
      const applied = applyDeck((deck) => ({
        ...deck,
        objects: [...deck.objects, object],
        counters: { ...deck.counters, path: count },
      }));
      if (!applied) return null;
      set({ selectedObjectId: id, selectedIds: [id], selectedFrameId: null });
      return id;
    },

    addImage: (src, naturalWidth, naturalHeight, point) => {
      const state = get();
      if (!state.deck) return null;
      if (state.deck.objects.length >= LIMITS.objects) return null;
      const deckAtStart = state.deck;
      const z = nextDepth(deckAtStart.objects);
      const count = (deckAtStart.counters.image ?? 0) + 1;
      const name = nameForObject(deckAtStart, 'image', '图片');
      const id = crypto.randomUUID();
      const object = createImageObject(id, name, src, naturalWidth, naturalHeight, state.view, z);
      if (point) {
        object.x = clampNumber(point.x, -LIMITS.coord, LIMITS.coord, object.x);
        object.y = clampNumber(point.y, -LIMITS.coord, LIMITS.coord, object.y);
      }
      const applied = applyDeck((deck) => ({
        ...deck,
        objects: [...deck.objects, object],
        counters: { ...deck.counters, image: count },
      }));
      if (!applied) return null;
      set({ selectedObjectId: id, selectedIds: [id], selectedFrameId: null });
      return id;
    },

    addMedia: (kind, src, meta, point) => {
      const state = get();
      if (!state.deck) return null;
      if (state.deck.objects.length >= LIMITS.objects) return null;
      const deckAtStart = state.deck;
      const z = nextDepth(deckAtStart.objects);
      const label = kind === 'video' ? '视频' : '音频';
      const name = nameForObject(deckAtStart, kind, label);
      const id = crypto.randomUUID();
      const object =
        kind === 'video'
          ? createVideoObject(id, name, src, meta.width, meta.height, meta.duration, state.view, z)
          : createAudioObject(id, name, src, meta.duration, state.view, z);
      if (point) {
        object.x = clampNumber(point.x, -LIMITS.coord, LIMITS.coord, object.x);
        object.y = clampNumber(point.y, -LIMITS.coord, LIMITS.coord, object.y);
      }
      const applied = applyDeck((deck) => ({
        ...deck,
        objects: [...deck.objects, object],
        counters: { ...deck.counters, [kind]: (deck.counters[kind] ?? 0) + 1 },
      }));
      if (!applied) return null;
      set({ selectedObjectId: id, selectedIds: [id], selectedFrameId: null });
      return id;
    },

    addModel: (src, format, point) => {
      const state = get();
      if (!state.deck) return null;
      if (state.deck.objects.length >= LIMITS.objects) return null;
      const deckAtStart = state.deck;
      const z = nextDepth(deckAtStart.objects);
      const name = nameForObject(deckAtStart, 'model', '模型');
      const id = crypto.randomUUID();
      const object = createModelObject(id, name, src, format, state.view, z);
      if (point) {
        object.x = clampNumber(point.x, -LIMITS.coord, LIMITS.coord, object.x);
        object.y = clampNumber(point.y, -LIMITS.coord, LIMITS.coord, object.y);
      }
      const applied = applyDeck((deck) => ({
        ...deck,
        objects: [...deck.objects, object],
        counters: { ...deck.counters, model: (deck.counters.model ?? 0) + 1 },
      }));
      if (!applied) return null;
      set({ selectedObjectId: id, selectedIds: [id], selectedFrameId: null });
      return id;
    },

    updateObject: (id, patch, historyKey) => {
      const state = get();
      if (!state.deck) return;
      applyDeck(
        (deck) => ({
          ...deck,
          objects: deck.objects.map((object) =>
            object.id === id ? normalizeEditedObject(object, patch) : object,
          ),
        }),
        { historyKey },
      );
      if ('src' in patch) {
        const errors = { ...state.imageErrors };
        delete errors[id];
        if (Object.keys(errors).length !== Object.keys(state.imageErrors).length) {
          set({ imageErrors: errors });
        }
      }
    },

    removeObject: (id) => {
      const state = get();
      if (!state.deck) return;
      const frameStillSelected = state.selectedFrameId;
      const applied = applyDeck((deck) => ({
        ...deck,
        objects: deck.objects.filter((object) => object.id !== id),
      }));
      if (applied) {
        set({
          selectedObjectId: null,
          selectedIds: [],
          selectedFrameId: frameStillSelected,
        });
      }
    },

    removeObjectSilent: (id) => {
      const state = get();
      if (!state.deck) return;
      applyDeck((deck) => ({
        ...deck,
        objects: deck.objects.filter((object) => object.id !== id),
      }));
      if (state.selectedObjectId === id) {
        const selected = state.selectedIds.filter((item) => item !== id);
        set({ selectedObjectId: selected[0] ?? null, selectedIds: selected });
      }
    },

    swapDepth: (sourceId, targetId) => {
      if (sourceId === targetId) return;
      applyDeck((deck) => {
        const source = deck.objects.find((object) => object.id === sourceId);
        const target = deck.objects.find((object) => object.id === targetId);
        if (!source || !target) return deck;
        return {
          ...deck,
          objects: deck.objects.map((object) => {
            if (object.id === sourceId) return { ...object, z: target.z };
            if (object.id === targetId) return { ...object, z: source.z };
            return object;
          }),
        };
      });
    },

    moveObjectLayer: (sourceId, targetId) => {
      if (sourceId === targetId) return;
      applyDeck((deck) => {
        const sorted = [...deck.objects].sort((a, b) => b.z - a.z);
        const from = sorted.findIndex((object) => object.id === sourceId);
        const to = sorted.findIndex((object) => object.id === targetId);
        if (from < 0 || to < 0) return deck;
        const originalZ = sorted.map((object) => object.z);
        const [moved] = sorted.splice(from, 1);
        sorted.splice(to, 0, moved);
        const order = new Map(sorted.map((object, index) => [object.id, index]));
        return {
          ...deck,
          objects: deck.objects.map((object) => {
            const index = order.get(object.id);
            if (index === undefined) return object;
            return { ...object, z: originalZ[index] };
          }),
        };
      });
    },

    endHistoryCoalesce: () => {
      lastHistoryKey = null;
      lastHistoryAt = 0;
    },

    captureFrame: (view) => {
      const state = get();
      if (!state.deck || state.deck.frames.length >= LIMITS.frames) return;
      const deckAtStart = state.deck;
      const frameId = crypto.randomUUID();
      const frame: Frame = {
        id: frameId,
        name: nextFrameName(deckAtStart.frames),
        duration: deckAtStart.defaultDuration,
        view: { ...view, target: { ...view.target } },
      };
      const applied = applyDeck(
        (deck) => ({ ...deck, frames: [...deck.frames, frame] }),
      );
      if (applied) {
        set({
          selectedFrameId: frameId,
          currentFrameId: frameId,
          selectedObjectId: null,
          selectedIds: [],
        });
      }
    },

    updateFrameView: (id, view) => {
      applyDeck((deck) => ({
        ...deck,
        frames: deck.frames.map((frame) =>
          frame.id === id ? { ...frame, view: { ...view, target: { ...view.target } } } : frame,
        ),
      }));
    },

    renameFrame: (id, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      applyDeck((deck) => ({
        ...deck,
        frames: deck.frames.map((frame) =>
          frame.id === id ? { ...frame, name: trimmed.slice(0, LIMITS.frameNameChars) } : frame,
        ),
      }));
    },

    setFrameDuration: (id, duration) => {
      applyDeck(
        (deck) => ({
          ...deck,
          frames: deck.frames.map((frame) =>
            frame.id === id
              ? {
                  ...frame,
                  duration: clampNumber(duration, LIMITS.minDuration, LIMITS.maxDuration, frame.duration),
                }
              : frame,
          ),
        }),
        { historyKey: `frame-duration:${id}` },
      );
    },

    deleteFrame: (id) => {
      const state = get();
      const deck = state.deck;
      if (!deck) return;
      const index = deck.frames.findIndex((frame) => frame.id === id);
      if (index < 0) return;
      const neighbor = deck.frames[index + 1] ?? deck.frames[index - 1] ?? null;
      const applied = applyDeck((oldDeck) => ({
        ...oldDeck,
        frames: oldDeck.frames.filter((frame) => frame.id !== id),
      }));
      if (!applied) return;
      set({
        selectedFrameId: neighbor?.id ?? null,
        currentFrameId: neighbor?.id ?? null,
      });
    },

    reorderFrame: (sourceId, targetId) => {
      if (sourceId === targetId) return;
      applyDeck((deck) => {
        const sourceIndex = deck.frames.findIndex((frame) => frame.id === sourceId);
        const targetIndex = deck.frames.findIndex((frame) => frame.id === targetId);
        if (sourceIndex < 0 || targetIndex < 0) return deck;
        const frames = [...deck.frames];
        const [moved] = frames.splice(sourceIndex, 1);
        frames.splice(targetIndex, 0, moved);
        return { ...deck, frames };
      });
    },

    markImageError: (id, message) => {
      const state = get();
      if (state.imageErrors[id] === message) return;
      set({ imageErrors: { ...state.imageErrors, [id]: message } });
    },

    retryImage: (id) => {
      const state = get();
      const errors = { ...state.imageErrors };
      delete errors[id];
      set({
        imageErrors: errors,
        imageRetry: { ...state.imageRetry, [id]: (state.imageRetry[id] ?? 0) + 1 },
      });
    },

    clearImageError: (id) => {
      const state = get();
      if (!state.imageErrors[id]) return;
      const errors = { ...state.imageErrors };
      delete errors[id];
      set({ imageErrors: errors });
    },

    undo: () => {
      const state = get();
      if (!state.deck || state.readonly || state.past.length === 0) return;
      const previous = state.past[state.past.length - 1];
      const current = state.deck;
      lastHistoryKey = null;
      set({
        past: state.past.slice(0, -1),
        future: [current, ...state.future].slice(0, 50),
      });
      replaceDeckFromHistory(previous);
    },

    redo: () => {
      const state = get();
      if (!state.deck || state.readonly || state.future.length === 0) return;
      const next = state.future[0];
      const current = state.deck;
      lastHistoryKey = null;
      set({
        future: state.future.slice(1),
        past: [...state.past, current].slice(-50),
      });
      replaceDeckFromHistory(next);
    },
  };
});

export { saveNow, flushDeckSave as flushSave };
