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

export type ObjectType = 'text' | 'image' | 'shape' | 'video' | 'audio' | 'model' | 'svg';
export type ShapeKind =
  | 'rect'
  | 'roundedRect'
  | 'ellipse'
  | 'triangle'
  | 'diamond'
  | 'star'
  | 'arrow'
  | 'line'
  | 'path';
export type FontPreset = 'sans' | 'serif' | 'round' | 'mono';
export type TextAlign = 'left' | 'center' | 'right';
export type ImageFit = 'contain' | 'cover';
export type MediaKind = 'video' | 'audio';
export type ModelFormat = 'glb' | 'gltf' | 'obj' | 'fbx' | 'stl' | 'ply' | 'dae' | '3mf' | 'usdz';

interface ObjectBase {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  /** 绕 Z 轴旋转（度） */
  rotation: number;
  /** 绕 X 轴倾斜（度） */
  rotationX?: number;
  /** 绕 Y 轴倾斜（度） */
  rotationY?: number;
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
  /** 3D 挤出厚度（0 表示平面文本） */
  depth3d?: number;
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
  /** 自由绘制路径：归一化坐标 [x0, y0, x1, y1, ...]（0–1，原点左上） */
  points?: number[];
}

export interface SvgObject extends ObjectBase {
  type: 'svg';
  src: string;
  fit: ImageFit;
  naturalWidth: number;
  naturalHeight: number;
}

export interface VideoObject extends ObjectBase {
  type: 'video';
  src: string;
  fit: ImageFit;
  naturalWidth: number;
  naturalHeight: number;
  /** 秒 */
  duration: number;
  loop: boolean;
  muted: boolean;
  /** 0–100 */
  volume: number;
  autoplay: boolean;
}

export interface AudioObject extends ObjectBase {
  type: 'audio';
  src: string;
  duration: number;
  loop: boolean;
  /** 0–100 */
  volume: number;
  autoplay: boolean;
}

export type MediaObject = VideoObject | AudioObject;

export interface ModelObject extends ObjectBase {
  type: 'model';
  src: string;
  format: ModelFormat;
  /** 演示与编辑时绕竖轴自动旋转 */
  autoRotate: boolean;
  /** 自转速度，度/秒 */
  rotateSpeed: number;
}

export type SlideObject =
  | TextObject
  | ImageObject
  | ShapeObject
  | VideoObject
  | AudioObject
  | ModelObject
  | SvgObject;

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
  video: '视频',
  audio: '音频',
  model: '3D 模型',
  svg: 'SVG 图形',
};

export const MODEL_FORMAT_LABELS: Record<ModelFormat, string> = {
  glb: 'GLB',
  gltf: 'glTF',
  obj: 'OBJ',
  fbx: 'FBX',
  stl: 'STL',
  ply: 'PLY',
  dae: 'DAE',
  '3mf': '3MF',
  usdz: 'USDZ',
};

export const SHAPE_LABELS: Record<ShapeKind, string> = {
  rect: '矩形',
  roundedRect: '圆角矩形',
  ellipse: '椭圆',
  triangle: '三角形',
  diamond: '菱形',
  star: '星形',
  arrow: '箭头',
  line: '直线',
  path: '自由路径',
};

export const FONT_LABELS: Record<FontPreset, string> = {
  sans: '系统黑体',
  serif: '宋体',
  round: '圆体',
  mono: '等宽',
};
