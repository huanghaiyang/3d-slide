import * as THREE from 'three';

interface Point {
  x: number;
  y: number;
}

interface Segment {
  a: Point;
  b: Point;
}

interface Contour {
  points: Point[];
  area: number;
  parent: number;
}

const MASK_MAX = 1024;
const ALPHA_THRESHOLD = 0.32;
const SIMPLIFY = 0.9;

/**
 * 用文字画布的 alpha 通道提取轮廓，再挤出为真正的 3D 文字几何体。
 * 正面使用原文字画布作为贴图，侧壁使用独立的暗色材质。
 */
export function buildTextExtrudeGeometry(
  canvas: HTMLCanvasElement,
  options: { width: number; height: number; depth: number },
): THREE.ExtrudeGeometry | null {
  const { width, height, depth } = options;
  const scale = Math.min(1, MASK_MAX / Math.max(canvas.width, canvas.height));
  const mw = Math.max(2, Math.round(canvas.width * scale));
  const mh = Math.max(2, Math.round(canvas.height * scale));
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = mw;
  maskCanvas.height = mh;
  const ctx = maskCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.clearRect(0, 0, mw, mh);
  ctx.drawImage(canvas, 0, 0, mw, mh);
  const data = ctx.getImageData(0, 0, mw, mh).data;

  const values = new Float32Array(mw * mh);
  for (let i = 0; i < values.length; i += 1) values[i] = data[i * 4 + 3] / 255;

  const segments = traceSegments(values, mw, mh);
  if (segments.length === 0) return null;
  const loops = chainSegments(segments);
  if (loops.length === 0) return null;

  const contours = classify(loops.map((loop) => simplifyClosed(loop, SIMPLIFY)));
  const outers = contours.filter((contour) => contour.parent < 0 && contour.points.length >= 3);
  if (outers.length === 0) return null;

  const toWorld = (point: Point) =>
    new THREE.Vector2(point.x * width / mw - width / 2, height / 2 - point.y * height / mh);

  const shapes: THREE.Shape[] = [];
  for (const outer of outers) {
    const shape = new THREE.Shape(outer.points.map(toWorld));
    const index = contours.indexOf(outer);
    for (const contour of contours) {
      if (contour.parent !== index) continue;
      if (contour.points.length < 3) continue;
      shape.holes.push(new THREE.Path(contour.points.map(toWorld)));
    }
    shapes.push(shape);
  }
  if (shapes.length === 0) return null;

  const bevel = Math.min(2.5, Math.max(1, depth * 0.08));
  const geometry = new THREE.ExtrudeGeometry(shapes, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel * 0.55,
    bevelSegments: 2,
    steps: 1,
    curveSegments: 1,
    UVGenerator: new TextUvGenerator(width, height),
  });
  const total = depth + (bevel > 0 ? bevel * 2 : 0);
  geometry.translate(0, 0, -total / 2);
  geometry.computeVertexNormals();
  return geometry;
}

class TextUvGenerator implements THREE.UVGenerator {
  constructor(private readonly width: number, private readonly height: number) {}

  private uv(x: number, y: number) {
    return new THREE.Vector2(x / this.width + 0.5, y / this.height + 0.5);
  }

  generateTopUV(_geometry: THREE.ExtrudeGeometry, vertices: number[], indexA: number, indexB: number, indexC: number) {
    return [
      this.uv(vertices[indexA * 3], vertices[indexA * 3 + 1]),
      this.uv(vertices[indexB * 3], vertices[indexB * 3 + 1]),
      this.uv(vertices[indexC * 3], vertices[indexC * 3 + 1]),
    ];
  }

  generateSideWallUV() {
    return [new THREE.Vector2(0, 0), new THREE.Vector2(0, 1), new THREE.Vector2(1, 1), new THREE.Vector2(1, 0)];
  }
}

function edgePoint(
  x: number,
  y: number,
  edge: 'top' | 'right' | 'bottom' | 'left',
  values: Float32Array,
  mw: number,
): Point {
  let p1x = x;
  let p1y = y;
  let p2x = x;
  let p2y = y;
  if (edge === 'top') {
    p2x = x + 1;
  } else if (edge === 'right') {
    p1x = x + 1;
    p2x = x + 1;
    p2y = y + 1;
  } else if (edge === 'bottom') {
    p1y = y + 1;
    p2x = x + 1;
    p2y = y + 1;
  } else {
    p2y = y + 1;
  }
  const v1 = values[p1y * mw + p1x];
  const v2 = values[p2y * mw + p2x];
  const delta = v2 - v1;
  let t = Math.abs(delta) < 1e-6 ? 0.5 : (ALPHA_THRESHOLD - v1) / delta;
  t = Math.max(0, Math.min(1, t));
  return { x: p1x + (p2x - p1x) * t, y: p1y + (p2y - p1y) * t };
}

const CASES: [('top' | 'right' | 'bottom' | 'left'), ('top' | 'right' | 'bottom' | 'left')][][] = [
  [],
  [['left', 'top']],
  [['top', 'right']],
  [['left', 'right']],
  [['right', 'bottom']],
  [['left', 'top'], ['right', 'bottom']],
  [['top', 'bottom']],
  [['left', 'bottom']],
  [['bottom', 'left']],
  [['top', 'bottom']],
  [['top', 'right'], ['bottom', 'left']],
  [['right', 'bottom']],
  [['left', 'right']],
  [['top', 'right']],
  [['left', 'top']],
  [],
];

function traceSegments(values: Float32Array, mw: number, mh: number): Segment[] {
  const segments: Segment[] = [];
  for (let y = 0; y < mh - 1; y += 1) {
    for (let x = 0; x < mw - 1; x += 1) {
      const a = values[y * mw + x] > ALPHA_THRESHOLD ? 1 : 0;
      const b = values[y * mw + x + 1] > ALPHA_THRESHOLD ? 2 : 0;
      const c = values[(y + 1) * mw + x + 1] > ALPHA_THRESHOLD ? 4 : 0;
      const d = values[(y + 1) * mw + x] > ALPHA_THRESHOLD ? 8 : 0;
      const pairs = CASES[a | b | c | d];
      for (const pair of pairs) {
        segments.push({
          a: edgePoint(x, y, pair[0], values, mw),
          b: edgePoint(x, y, pair[1], values, mw),
        });
      }
    }
  }
  return segments;
}

function pointKey(point: Point): string {
  return `${Math.round(point.x * 1000)}:${Math.round(point.y * 1000)}`;
}

function chainSegments(segments: Segment[]): Point[][] {
  const adjacency = new Map<string, number[]>();
  const push = (key: string, index: number) => {
    const list = adjacency.get(key);
    if (list) list.push(index);
    else adjacency.set(key, [index]);
  };
  segments.forEach((segment, index) => {
    push(pointKey(segment.a), index);
    push(pointKey(segment.b), index);
  });

  const used = new Uint8Array(segments.length);
  const loops: Point[][] = [];
  for (let start = 0; start < segments.length; start += 1) {
    if (used[start]) continue;
    const loop: Point[] = [];
    let current = start;
    const startKey = pointKey(segments[start].a);
    let guard = segments.length + 4;

    while (guard > 0) {
      guard -= 1;
      used[current] = 1;
      loop.push(segments[current].a);
      const endKey = pointKey(segments[current].b);
      if (endKey === startKey) break;
      const candidates = adjacency.get(endKey) ?? [];
      let next = -1;
      for (const candidate of candidates) {
        if (!used[candidate]) {
          next = candidate;
          break;
        }
      }
      if (next < 0) break;
      if (pointKey(segments[next].a) !== endKey) segments[next] = { a: segments[next].b, b: segments[next].a };
      current = next;
    }

    if (loop.length >= 4) loops.push(loop);
  }
  return loops;
}

function simplifyClosed(points: Point[], epsilon: number): Point[] {
  if (points.length <= 4) return points;
  const closed = points.concat([points[0]]);
  const result = simplifyOpen(closed, epsilon);
  if (result.length > 1 && pointKey(result[result.length - 1]) === pointKey(result[0])) result.pop();
  return result;
}

function simplifyOpen(points: Point[], epsilon: number): Point[] {
  if (points.length <= 2) return points;
  const first = points[0];
  const last = points[points.length - 1];
  let maxDistance = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i += 1) {
    const distance = lineDistance(points[i], first, last);
    if (distance > maxDistance) {
      maxDistance = distance;
      index = i;
    }
  }
  if (maxDistance > epsilon) {
    const left = simplifyOpen(points.slice(0, index + 1), epsilon);
    const right = simplifyOpen(points.slice(index), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

function lineDistance(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return Math.hypot(point.x - start.x, point.y - start.y);
  return Math.abs(dy * point.x - dx * point.y + end.x * start.y - end.y * start.x) / length;
}

function signedArea(points: Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    sum += current.x * next.y - next.x * current.y;
  }
  return sum / 2;
}

function containsPoint(polygon: Point[], point: Point): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if (
      (a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || 1e-9) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function classify(points: Point[][]): Contour[] {
  const contours: Contour[] = points.map((item) => ({ points: item, area: Math.abs(signedArea(item)), parent: -1 }));
  for (let i = 0; i < contours.length; i += 1) {
    const contour = contours[i];
    if (contour.points.length < 3) continue;
    let parent = -1;
    let parentArea = Infinity;
    for (let j = 0; j < contours.length; j += 1) {
      if (i === j) continue;
      const candidate = contours[j];
      if (candidate.points.length < 3) continue;
      if (candidate.area <= contour.area * 1.02 || candidate.area >= parentArea) continue;
      if (!containsPoint(candidate.points, contour.points[0])) continue;
      parent = j;
      parentArea = candidate.area;
    }
    contour.parent = parent;
  }
  return contours;
}
