import type {
  AudioObject,
  Deck,
  ImageObject,
  ModelFormat,
  ModelObject,
  ShapeKind,
  ShapeObject,
  SlideObject,
  SvgObject,
  TextObject,
  VideoObject,
  ViewState,
} from '../types';
import {
  DEFAULT_BACKGROUND,
  DEFAULT_DURATION,
  DEFAULT_SHAPE_COLOR,
  DEFAULT_TEXT_COLOR,
  DEFAULT_VIEW,
  LIMITS,
} from './constants';
import { viewCenterAtZ } from './camera';
import { layoutText } from './text';
import { defaultImageObject } from './validate';

export function createDeck(title: string): Deck {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title,
    background: DEFAULT_BACKGROUND,
    defaultDuration: DEFAULT_DURATION,
    showProgress: true,
    objects: [],
    frames: [],
    lastView: { ...DEFAULT_VIEW, target: { ...DEFAULT_VIEW.target } },
    counters: {},
    createdAt: now,
    updatedAt: now,
  };
}

export function nextDepth(objects: SlideObject[]): number {
  if (objects.length === 0) return 0;
  return Math.max(...objects.map((o) => o.z)) + 10;
}

function nextCounter(deck: Deck, key: string): number {
  return (deck.counters[key] ?? 0) + 1;
}

export function nameForObject(deck: Deck, key: string, label: string): string {
  return `${label} ${nextCounter(deck, key)}`;
}

export function createTextObject(
  id: string,
  name: string,
  view: ViewState,
  z: number,
): TextObject {
  const center = viewCenterAtZ(view, z);
  const width = 760;
  const fontSize = 48;
  const lineHeight = 1.4;
  const layout = layoutText('新文本', width, fontSize, 'sans', false, lineHeight);
  return {
    id,
    type: 'text',
    name,
    x: center.x,
    y: center.y,
    z,
    width,
    height: layout.height,
    rotation: 0,
    opacity: 100,
    visible: true,
    text: '新文本',
    fontSize,
    font: 'sans',
    bold: false,
    align: 'left',
    color: DEFAULT_TEXT_COLOR,
    lineHeight,
    depth3d: 0,
  };
}

export function createImageObject(
  id: string,
  name: string,
  src: string,
  naturalWidth: number,
  naturalHeight: number,
  view: ViewState,
  z: number,
): ImageObject {
  const center = viewCenterAtZ(view, z);
  return defaultImageObject(id, name, src, naturalWidth, naturalHeight, center.x, center.y, z);
}

function fitMediaSize(naturalWidth: number, naturalHeight: number, maxDim: number): { width: number; height: number } {
  const ratio = naturalWidth / naturalHeight || 16 / 9;
  let width = maxDim;
  let height = width / ratio;
  if (height > maxDim) {
    height = maxDim;
    width = height * ratio;
  }
  return { width: Math.round(width), height: Math.round(height) };
}

export function createVideoObject(
  id: string,
  name: string,
  src: string,
  naturalWidth: number,
  naturalHeight: number,
  duration: number,
  view: ViewState,
  z: number,
): VideoObject {
  const center = viewCenterAtZ(view, z);
  const size = fitMediaSize(naturalWidth || 1280, naturalHeight || 720, 960);
  return {
    id,
    type: 'video',
    name,
    x: center.x,
    y: center.y,
    z,
    width: size.width,
    height: size.height,
    rotation: 0,
    opacity: 100,
    visible: true,
    src,
    fit: 'contain',
    naturalWidth: Math.max(1, Math.round(naturalWidth || 1280)),
    naturalHeight: Math.max(1, Math.round(naturalHeight || 720)),
    duration,
    loop: true,
    muted: false,
    volume: 80,
    autoplay: false,
  };
}

export function createAudioObject(
  id: string,
  name: string,
  src: string,
  duration: number,
  view: ViewState,
  z: number,
): AudioObject {
  const center = viewCenterAtZ(view, z);
  return {
    id,
    type: 'audio',
    name,
    x: center.x,
    y: center.y,
    z,
    width: 560,
    height: 168,
    rotation: 0,
    opacity: 100,
    visible: true,
    src,
    duration,
    loop: true,
    volume: 80,
    autoplay: false,
  };
}

export function createModelObject(
  id: string,
  name: string,
  src: string,
  format: ModelFormat,
  view: ViewState,
  z: number,
): ModelObject {
  const center = viewCenterAtZ(view, z);
  return {
    id,
    type: 'model',
    name,
    x: center.x,
    y: center.y,
    z,
    width: 760,
    height: 760,
    rotation: 0,
    opacity: 100,
    visible: true,
    src,
    format,
    autoRotate: false,
    rotateSpeed: 45,
  };
}

export function createShapeObject(
  id: string,
  name: string,
  shape: ShapeKind,
  view: ViewState,
  z: number,
): ShapeObject {
  const center = viewCenterAtZ(view, z);
  const width = shape === 'line' ? 640 : 520;
  const height = shape === 'line' ? 8 : 340;
  return {
    id,
    type: 'shape',
    name,
    x: center.x,
    y: center.y,
    z,
    width,
    height,
    rotation: 0,
    opacity: 100,
    visible: true,
    shape,
    fill: DEFAULT_SHAPE_COLOR,
    stroke: shape === 'line' ? DEFAULT_SHAPE_COLOR : null,
    strokeWidth: shape === 'line' ? 6 : 0,
    points: shape === 'path' ? [] : undefined,
  };
}

export function createSvgObject(
  id: string,
  name: string,
  src: string,
  naturalWidth: number,
  naturalHeight: number,
  view: ViewState,
  z: number,
): SvgObject {
  const base = defaultImageObject(id, name, src, naturalWidth, naturalHeight, 0, 0, z);
  const center = viewCenterAtZ(view, z);
  return {
    ...base,
    type: 'svg',
    x: center.x,
    y: center.y,
  };
}

export function autoTextHeight(obj: TextObject, width = obj.width): number {
  const layout = layoutText(obj.text, width, obj.fontSize, obj.font, obj.bold, obj.lineHeight);
  return Math.max(LIMITS.minSize, layout.height);
}

export function nextFrameName(frames: Deck['frames']): string {
  let max = frames.length;
  for (const f of frames) {
    const match = /视点\s*(\d+)/.exec(f.name);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `视点 ${max + 1}`;
}

export function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}
