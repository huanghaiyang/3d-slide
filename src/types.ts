export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 相机取景快照：看向点 + 距离 + 朝向 */
export interface ViewState {
  target: Vec3;
  distance: number;
  yaw: number;
  pitch: number;
}

export type ObjectType = 'text' | 'image' | 'shape';
export type ShapeKind = 'rect' | 'ellipse' | 'line';
export type FontPreset = 'sans' | 'serif' | 'round' | 'mono';
export type TextAlign = 'left' | 'center' | 'right';
export type ImageFit = 'contain' | 'cover';

interface ObjectBase {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  rotation: number;
  /** 0–100 */
  opacity: number;
  visible: boolean;
}

export interface TextObject extends ObjectBase {
  type: 'text';
  text: string;
  fontSize: number;
  font: FontPreset;
  bold: boolean;
  align: TextAlign;
  color: string;
  lineHeight: number;
}

export interface ImageObject extends ObjectBase {
  type: 'image';
  src: string;
  fit: ImageFit;
  aspectLocked: boolean;
  naturalWidth: number;
  naturalHeight: number;
}

export interface ShapeObject extends ObjectBase {
  type: 'shape';
  shape: ShapeKind;
  fill: string;
  stroke: string | null;
  strokeWidth: number;
}

export type SlideObject = TextObject | ImageObject | ShapeObject;

export interface Frame {
  id: string;
  name: string;
  /** 被进入时的过渡时长（秒） */
  duration: number;
  view: ViewState;
}

export interface Deck {
  id: string;
  title: string;
  background: string;
  /** 作品默认过渡时长（秒） */
  defaultDuration: number;
  showProgress: boolean;
  objects: SlideObject[];
  frames: Frame[];
  /** 最后一次编辑视图 */
  lastView: ViewState;
  /** 默认名称计数，删除后不回收 */
  counters: Record<string, number>;
  createdAt: number;
  updatedAt: number;
}

export type SaveState = 'dirty' | 'saving' | 'saved' | 'error';

export interface SaveStatus {
  state: SaveState;
  at?: number;
  message?: string;
}

export type CameraRequestType = 'reset' | 'focus' | 'frame';

export interface CameraRequest {
  id: number;
  type: CameraRequestType;
  /** 视点飞行目标 */
  view?: ViewState;
  objectId?: string;
  duration?: number;
}

export type DeckSummary = {
  deck: Deck;
  broken?: string;
};

export const OBJECT_LABELS: Record<ObjectType, string> = {
  text: '文本',
  image: '图片',
  shape: '形状',
};

export const SHAPE_LABELS: Record<ShapeKind, string> = {
  rect: '矩形',
  ellipse: '椭圆',
  line: '直线',
};

export const FONT_LABELS: Record<FontPreset, string> = {
  sans: '系统黑体',
  serif: '宋体',
  round: '圆体',
  mono: '等宽',
};
