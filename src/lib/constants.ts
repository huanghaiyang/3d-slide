import type { ViewState } from '../types';

export const FOV = 50;
export const STAGE_WIDTH = 1920;
export const STAGE_HEIGHT = 1080;
export const ASPECT = STAGE_WIDTH / STAGE_HEIGHT;
/** 16:9 安全框在 z=0 平面恰好充满视口时的相机距离 */
export const DEFAULT_DISTANCE = STAGE_HEIGHT / 2 / Math.tan((FOV / 2) * (Math.PI / 180));

export const DEFAULT_VIEW: ViewState = {
  target: { x: 0, y: 0, z: 0 },
  distance: DEFAULT_DISTANCE,
  yaw: 0,
  pitch: 0,
};

export const LIMITS = {
  objects: 200,
  frames: 50,
  imageBytes: 20 * 1024 * 1024,
  mediaBytes: 100 * 1024 * 1024,
  projectBytes: 200 * 1024 * 1024,
  textChars: 5000,
  titleChars: 80,
  objectNameChars: 60,
  frameNameChars: 40,
  frameNotesChars: 2000,
  coord: 99999,
  depth: 10000,
  minSize: 8,
  maxSize: 20000,
  minFontSize: 8,
  maxFontSize: 400,
  minOpacity: 0,
  maxOpacity: 100,
  minRotation: -180,
  maxRotation: 180,
  maxTextDepth: 600,
  maxPathPoints: 2000,
  minLineHeight: 0.8,
  maxLineHeight: 3,
  minStroke: 0,
  maxStroke: 40,
  minDuration: 0.2,
  maxDuration: 5,
  minHold: 0.5,
  maxHold: 120,
} as const;

export const DEFAULT_BACKGROUND = '#10161F';
export const DEFAULT_DURATION = 1.2;
/** 自动播放时每个视点的默认停留时长（秒） */
export const DEFAULT_HOLD = 5;
export const DEFAULT_TEXT_COLOR = '#F3EEE4';
export const DEFAULT_SHAPE_COLOR = '#2DD4BF';
export const ACCENT = '#14B8A6';
export const FONT_STACKS: Record<string, string> = {
  sans: '"PingFang SC","Microsoft YaHei",system-ui,"Segoe UI",sans-serif',
  serif: '"Songti SC","Noto Serif SC","SimSun",Georgia,serif',
  round: '"Hiragino Maru Gothic ProN","Yuanti SC","PingFang SC",system-ui,sans-serif',
  mono: '"SFMono-Regular",Consolas,"Liberation Mono",monospace',
};
