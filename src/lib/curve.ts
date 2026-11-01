export interface CurvePoint {
  x: number;
  y: number;
}

function segmentControls(points: CurvePoint[], index: number) {
  const p0 = points[Math.max(0, index - 1)];
  const p1 = points[index];
  const p2 = points[index + 1];
  const p3 = points[Math.min(points.length - 1, index + 2)];
  return {
    p1,
    p2,
    c1: { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 },
    c2: { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 },
  };
}

/** 把折线点列转成三次贝塞尔 SVG path（Catmull-Rom 等价控制点） */
export function smoothPathD(points: CurvePoint[]): string {
  if (points.length < 2) return '';
  const parts = [`M ${points[0].x} ${points[0].y}`];
  for (let i = 0; i < points.length - 1; i += 1) {
    const { c1, c2, p2 } = segmentControls(points, i);
    parts.push(`C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${p2.x} ${p2.y}`);
  }
  return parts.join(' ');
}

/** 按三次贝塞尔采样平滑点列，用于绘制带宽度路径的几何体 */
export function sampleBezierPath(points: CurvePoint[], samples = 5): CurvePoint[] {
  if (points.length < 2) return points;
  const output: CurvePoint[] = [{ ...points[0] }];
  for (let i = 0; i < points.length - 1; i += 1) {
    const { p1, p2, c1, c2 } = segmentControls(points, i);
    for (let step = 1; step <= samples; step += 1) {
      const t = step / samples;
      const mt = 1 - t;
      const a = mt * mt * mt;
      const b = 3 * mt * mt * t;
      const c = 3 * mt * t * t;
      const d = t * t * t;
      output.push({
        x: a * p1.x + b * c1.x + c * c2.x + d * p2.x,
        y: a * p1.y + b * c1.y + c * c2.y + d * p2.y,
      });
    }
  }
  return output;
}
