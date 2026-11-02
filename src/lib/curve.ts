/**
 * curve.ts —— 手绘路径的平滑与采样工具
 *
 * 用户手绘得到的是一串折线点（Line 对象或 Shape 的 path 点集），直接使用会看到
 * 明显棱角。本模块用 Catmull-Rom 样条的控制点公式，把折线转换成等价的三次贝塞尔
 * 曲线：既可直接输出 SVG path（`smoothPathD`），也可按段采样成密集点集
 * （`sampleBezierPath`），供 Three.js 生成有宽度的路径几何体。
 *
 * 两种输出都基于同一套每段控制点（`segmentControls`），因此 SVG 预览与 3D 渲染
 * 的形状保持一致。
 */

/** 二维点（世界坐标或归一化坐标均可，本模块不关心单位）。 */
export interface CurvePoint {
  x: number;
  y: number;
}

/**
 * 计算第 index 段（p1 -> p2）的三次贝塞尔控制点。
 *
 * 采用 Catmull-Rom 到贝塞尔的标准换算：控制点沿相邻点连线的方向偏移 1/6，
 * 即 c1 = p1 + (p2 - p0) / 6，c2 = p2 - (p3 - p1) / 6。
 * 两端缺少邻居时用首尾点自身补齐（clamp），保证端点为直线趋势、曲线不外翻。
 *
 * @param points 折线点列，至少需要 index 与 index + 1 两个点
 * @param index  当前段起点在数组中的下标
 * @returns 本段的起点 p1、终点 p2 与两个控制点 c1 / c2
 */
function segmentControls(points: CurvePoint[], index: number) {
  const p0 = points[Math.max(0, index - 1)];
  const p1 = points[index];
  const p2 = points[index + 1];
  const p3 = points[Math.min(points.length - 1, index + 2)];
  return {
    p1,
    p2,
    // 每个控制点偏移相邻点差值的三分之一再除以二（1/6），得到平滑但不过冲的曲线
    c1: { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 },
    c2: { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 },
  };
}

/**
 * 把折线点列转换成平滑的 SVG path 字符串（M + 多个 C 命令）。
 *
 * 输出的 path 可直接用于 SVG 图标或 DOM 预览；坐标原样输出，不做缩放。
 *
 * @param points 折线点列
 * @returns SVG path 的 d 属性；点数少于 2 时返回空串
 */
export function smoothPathD(points: CurvePoint[]): string {
  if (points.length < 2) return '';
  const parts = [`M ${points[0].x} ${points[0].y}`];
  for (let i = 0; i < points.length - 1; i += 1) {
    const { c1, c2, p2 } = segmentControls(points, i);
    parts.push(`C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${p2.x} ${p2.y}`);
  }
  return parts.join(' ');
}

/**
 * 沿平滑后的贝塞尔曲线按固定步数采样，得到更密集的点列。
 *
 * 每一段取 samples 个等 t 间隔的采样点（不含起点、包含终点，起点在循环外补齐），
 * 因此总点数约为 1 + (points.length - 1) * samples。采样点用于挤出带厚度的
 * 3D 路径，避免几何体只由少量折线点构成而出现生硬的拐角。
 *
 * 使用三次贝塞尔基函数 B(t) = (1-t)^3 P1 + 3(1-t)^2 t C1 + 3(1-t) t^2 C2 + t^3 P2，
 * 展开系数后逐点求值。
 *
 * @param points  原始折线点列
 * @param samples 每段的采样步数，越大曲线越平滑、点也越多
 * @returns 采样后的新点列（不修改原数组；点数少于 2 时原样返回传入数组）
 */
export function sampleBezierPath(points: CurvePoint[], samples = 5): CurvePoint[] {
  if (points.length < 2) return points;
  const output: CurvePoint[] = [{ ...points[0] }];
  for (let i = 0; i < points.length - 1; i += 1) {
    const { p1, p2, c1, c2 } = segmentControls(points, i);
    for (let step = 1; step <= samples; step += 1) {
      const t = step / samples;
      const mt = 1 - t;
      // 三次贝塞尔四个基函数系数：a 对应 P1，b 对应 c1，c 对应 c2，d 对应 P2
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
