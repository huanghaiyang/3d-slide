/**
 * text3d.ts —— 3D 文字几何生成
 *
 * 职责：
 * - 把二维文字画布（由 text.ts 排版绘制、背景透明）的 alpha 通道当作字形遮罩，
 *   提取轮廓并挤出为 Three.js 的 ExtrudeGeometry，实现有厚度、可打光的 3D 文字；
 * - 提供配套的 UV 生成器：正面采样原文字画布，侧壁使用独立的固定 UV。
 *
 * 处理流程：
 * 1. 按 MASK_MAX 限制采样画布尺寸，读取 alpha 并转为 0 ~ 1 的浮点高度场；
 * 2. 用 marching squares 在 ALPHA_THRESHOLD 等值线上逐格提取轮廓线段；
 * 3. 以端点为键把线段串成闭环，再用 Douglas-Peucker 简化顶点；
 * 4. 用有向面积与「点在多边形内」判定区分外轮廓与孔洞（如「口」「日」的内部）；
 * 5. 每个外轮廓生成 Shape，其孔洞挂到 Shape.holes，统一挤出并沿 Z 轴居中。
 *
 * 坐标与 UV 约定：
 * - 输入画布像素坐标 Y 向下，输出几何 Y 向上、原点位于文字中心；
 * - 正面 UV 以文字画布为参照（x / width + 0.5，y / height + 0.5），
 *   保证挤出体顶面顶点与原文字贴图逐像素对应。
 *
 * 失败降级：画布过小、2D 上下文不可用或未提取到有效轮廓时返回 null，
 * 调用方应退回普通平面贴图的文字渲染。
 */

import * as THREE from 'three';

/** 二维点：采样阶段为画布像素坐标，toWorld 换算后为世界坐标 */
interface Point {
  x: number;
  y: number;
}

/** 一条轮廓线段：由 marching squares 在单个网格内生成 */
interface Segment {
  a: Point;
  b: Point;
}

/** 闭合轮廓及其层级关系，用于区分外轮廓与孔洞 */
interface Contour {
  /** 轮廓顶点（首尾不重复） */
  points: Point[];
  /** 绝对面积，用于判断轮廓大小与父子归属 */
  area: number;
  /** 父轮廓下标；-1 表示最外层轮廓（会被挤出为实体） */
  parent: number;
}

/** alpha 采样画布的最大边长：超过则等比缩小，避免超大画布逐像素处理过慢 */
const MASK_MAX = 1024;
/** alpha 阈值（0 ~ 1）：大于该值视为字形内部，等值线即字形轮廓 */
const ALPHA_THRESHOLD = 0.32;
/** Douglas-Peucker 简化容差（采样像素单位）：越大轮廓越简、顶点越少 */
const SIMPLIFY = 0.9;

/**
 * 用文字画布的 alpha 通道提取轮廓，再挤出为真正的 3D 文字几何体。
 * 正面使用原文字画布作为贴图，侧壁使用独立的暗色材质。
 *
 * 实现要点：
 * - alpha 采样画布会被限制到 MASK_MAX 以内：轮廓精度足够，处理耗时有上界；
 * - 只有外轮廓会生成 Shape，内轮廓作为 holes 挖空，从而正确处理「口」「日」等字；
 * - 挤出后沿 Z 轴平移一半总深度，使几何体绕 Y 轴旋转时不会前后偏移；
 * - 带倒角时 ExtrudeGeometry 自带法线不够准确，最后统一重算顶点法线。
 *
 * @param canvas 已绘制好文字（透明背景）的二维画布
 * @param options width / height 为世界单位下的文字宽高，depth 为挤出深度
 * @returns 挤出几何体；无法提取有效轮廓或上下文不可用时返回 null
 */
export function buildTextExtrudeGeometry(
  canvas: HTMLCanvasElement,
  options: { width: number; height: number; depth: number },
): THREE.ExtrudeGeometry | null {
  const { width, height, depth } = options;
  // 大画布按比例缩小后再采样：轮廓检测只需要字形边界，不需要原始分辨率
  const scale = Math.min(1, MASK_MAX / Math.max(canvas.width, canvas.height));
  const mw = Math.max(2, Math.round(canvas.width * scale));
  const mh = Math.max(2, Math.round(canvas.height * scale));
  // 离屏遮罩画布：只用来读 alpha，不存在于 DOM，用完即被 GC 回收
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = mw;
  maskCanvas.height = mh;
  // willReadFrequently 提示浏览器保留 CPU 侧后备画布，避免 getImageData 反复回读显存
  const ctx = maskCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.clearRect(0, 0, mw, mh);
  ctx.drawImage(canvas, 0, 0, mw, mh);
  const data = ctx.getImageData(0, 0, mw, mh).data;

  // 只保留 alpha 通道并归一化到 0 ~ 1；文字画布是透明底，RGB 对轮廓没有意义
  const values = new Float32Array(mw * mh);
  for (let i = 0; i < values.length; i += 1) values[i] = data[i * 4 + 3] / 255;

  // marching squares：逐格求 alpha 等值线，得到大量首尾可能相连的短线段
  const segments = traceSegments(values, mw, mh);
  if (segments.length === 0) return null;
  // 把端点重合的线段串成闭环；未闭合的碎片会被丢弃
  const loops = chainSegments(segments);
  if (loops.length === 0) return null;

  // 先简化再判层级：顶点更少，后续的点在多边形内判定也更快
  const contours = classify(loops.map((loop) => simplifyClosed(loop, SIMPLIFY)));
  // 只有最外层轮廓（parent < 0）会被挤出；顶点少于 3 个的退化轮廓直接忽略
  const outers = contours.filter((contour) => contour.parent < 0 && contour.points.length >= 3);
  if (outers.length === 0) return null;

  // 采样像素坐标 -> 世界坐标：按比例缩放，并把画布原点（左上）平移到文字中心；
  // 注意 Y 需要翻转（画布 Y 向下，几何 Y 向上），否则文字会上下颠倒
  const toWorld = (point: Point) =>
    new THREE.Vector2(point.x * width / mw - width / 2, height / 2 - point.y * height / mh);

  const shapes: THREE.Shape[] = [];
  for (const outer of outers) {
    const shape = new THREE.Shape(outer.points.map(toWorld));
    const index = contours.indexOf(outer);
    // 把直接子轮廓作为孔洞挂到当前外轮廓上（如「口」字中间的空腔）
    for (const contour of contours) {
      if (contour.parent !== index) continue;
      if (contour.points.length < 3) continue;
      shape.holes.push(new THREE.Path(contour.points.map(toWorld)));
    }
    shapes.push(shape);
  }
  if (shapes.length === 0) return null;

  // 倒角尺寸随挤出深度线性增加并夹在 1 ~ 2.5 之间：太薄没有立体感，太厚会吃掉笔画
  const bevel = Math.min(2.5, Math.max(1, depth * 0.08));
  const geometry = new THREE.ExtrudeGeometry(shapes, {
    depth,
    // bevel 为 0 时才关闭倒角；此处恒为正，保留开关以便未来调整
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel * 0.55,
    // 倒角分段与挤出步数都取最小值：文字轮廓已由简化保证平滑，无需额外细分
    bevelSegments: 2,
    steps: 1,
    // 轮廓是折线路径，曲线分段数不影响结果，取 1 以减少顶点
    curveSegments: 1,
    // 自定义 UV：顶面按顶点位置映射到原文字画布，侧壁使用固定 UV
    UVGenerator: new TextUvGenerator(width, height),
  });
  // 几何体默认从 z = 0 向正方向挤出，这里整体后移一半，使其以文字平面为中心
  const total = depth + (bevel > 0 ? bevel * 2 : 0);
  geometry.translate(0, 0, -total / 2);
  // 带倒角的挤出体需重算法线，否则侧壁受光会出现明显的明暗断层
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * 挤出文字的 UV 生成器。
 *
 * ExtrudeGeometry 默认会按世界包围盒生成 UV，那样正面贴图无法与原文字画布对齐；
 * 这里改用「几何坐标 -> 画布坐标」的线性映射，让顶面（正面 / 背面）直接采样原文字纹理。
 * width / height 为文字的世界单位尺寸，与挤出前的画布比例一致。
 */
class TextUvGenerator implements THREE.UVGenerator {
  constructor(private readonly width: number, private readonly height: number) {}

  /**
   * 世界坐标 -> UV。
   * 几何原点在文字中心，而 UV 原点在画布左上角，故各加 0.5 做中心对齐。
   */
  private uv(x: number, y: number) {
    return new THREE.Vector2(x / this.width + 0.5, y / this.height + 0.5);
  }

  /**
   * 顶面（正 / 背面）UV：按顶点的 x / y 坐标映射到文字画布。
   * vertices 是扁平化的顶点坐标数组，indexA / B / C 为三个顶点的下标。
   */
  generateTopUV(_geometry: THREE.ExtrudeGeometry, vertices: number[], indexA: number, indexB: number, indexC: number) {
    return [
      this.uv(vertices[indexA * 3], vertices[indexA * 3 + 1]),
      this.uv(vertices[indexB * 3], vertices[indexB * 3 + 1]),
      this.uv(vertices[indexC * 3], vertices[indexC * 3 + 1]),
    ];
  }

  /**
   * 侧壁 UV：侧壁不参与文字贴图，统一给一组固定四角 UV，
   * 实际颜色由 SceneManager 中的侧壁材质决定（通常取文字主色的暗色）。
   */
  generateSideWallUV() {
    return [new THREE.Vector2(0, 0), new THREE.Vector2(0, 1), new THREE.Vector2(1, 1), new THREE.Vector2(1, 0)];
  }
}

/**
 * 在网格单元 (x, y) 的指定边上，用两端 alpha 值线性插值求等值线交点。
 *
 * 网格由四个相邻采样点构成，边可能是上 / 右 / 下 / 左；
 * 交点位置就是 alpha 从阈值两侧穿过时的插值点，返回的还是采样画布像素坐标。
 */
function edgePoint(
  x: number,
  y: number,
  edge: 'top' | 'right' | 'bottom' | 'left',
  values: Float32Array,
  mw: number,
): Point {
  // 先把边的两个端点初始化为左上角，再按边类型移动到对应位置
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
  // 两端值几乎相等时取中点，避免除零；t 截断到 [0, 1] 保证交点落在边内
  let t = Math.abs(delta) < 1e-6 ? 0.5 : (ALPHA_THRESHOLD - v1) / delta;
  t = Math.max(0, Math.min(1, t));
  return { x: p1x + (p2x - p1x) * t, y: p1y + (p2y - p1y) * t };
}

/**
 * marching squares 查找表：16 种角点组合 -> 需要连接的边对。
 *
 * 索引位含义（4 个采样点是否在字形内部）：
 * - bit0 = 左上，bit1 = 右上，bit2 = 右下，bit3 = 左下；
 * - 每个条目列出 0 ~ 2 组边，每组表示一条等值线段的两个端点所在边。
 * 索引 5 / 10 是鞍点（对角两点在内部），这里采用固定拆法，
 * 相邻单元格使用同样的规则，保证线段仍然可以首尾相接。
 */
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

/**
 * 逐格扫描 alpha 高度场，用 marching squares 生成轮廓线段。
 *
 * 只遍历到 mw - 1 / mh - 1，因为每个格子需要右下方向的邻居采样点；
 * 相邻格子在同一条边上求出的交点坐标完全相同，后续可据此把线段串成闭环。
 *
 * @param values 长度 mw * mh 的 alpha 数组，行优先存储
 * @param mw 采样画布宽度
 * @param mh 采样画布高度
 */
function traceSegments(values: Float32Array, mw: number, mh: number): Segment[] {
  const segments: Segment[] = [];
  for (let y = 0; y < mh - 1; y += 1) {
    for (let x = 0; x < mw - 1; x += 1) {
      // 四个角点分别映射到 bit0 ~ bit3，得到 0 ~ 15 的查找表下标
      const a = values[y * mw + x] > ALPHA_THRESHOLD ? 1 : 0;
      const b = values[y * mw + x + 1] > ALPHA_THRESHOLD ? 2 : 0;
      const c = values[(y + 1) * mw + x + 1] > ALPHA_THRESHOLD ? 4 : 0;
      const d = values[(y + 1) * mw + x] > ALPHA_THRESHOLD ? 8 : 0;
      const pairs = CASES[a | b | c | d];
      // 每个 case 最多产生两条线段（鞍点情况），逐条求出两端交点
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

/**
 * 端点坐标 -> 字符串键。
 * 坐标先按 1/1000 精度四舍五入，容忍浮点误差，让相邻格子算出的同一交点可以匹配上。
 */
function pointKey(point: Point): string {
  return `${Math.round(point.x * 1000)}:${Math.round(point.y * 1000)}`;
}

/**
 * 把无序的轮廓线段按端点邻接关系串成闭环。
 *
 * 实现方式：
 * 1. 建立「端点键 -> 线段下标数组」的邻接表；
 * 2. 从任意未使用的线段出发，不断寻找共享同一端点的下一条线段；
 * 3. 若下一条线段的方向相反则就地翻转，保证路径首尾一致；
 * 4. 走回起点即闭合，顶点数达到 4 才保留，过短的噪声碎片被丢弃。
 *
 * @returns 闭环顶点数组列表；每个闭环不重复首点
 */
function chainSegments(segments: Segment[]): Point[][] {
  const adjacency = new Map<string, number[]>();
  const push = (key: string, index: number) => {
    const list = adjacency.get(key);
    if (list) list.push(index);
    else adjacency.set(key, [index]);
  };
  // 每条线段对两个端点各登记一次，正反方向都能查到相邻线段
  segments.forEach((segment, index) => {
    push(pointKey(segment.a), index);
    push(pointKey(segment.b), index);
  });

  // used 记录已消费的线段，避免重复串线或陷入死循环
  const used = new Uint8Array(segments.length);
  const loops: Point[][] = [];
  for (let start = 0; start < segments.length; start += 1) {
    if (used[start]) continue;
    const loop: Point[] = [];
    let current = start;
    const startKey = pointKey(segments[start].a);
    // guard 是异常数据的兜底：最多走「线段数 + 4」步，防止邻接表被破坏时死循环
    let guard = segments.length + 4;

    while (guard > 0) {
      guard -= 1;
      used[current] = 1;
      loop.push(segments[current].a);
      const endKey = pointKey(segments[current].b);
      // 回到出发点说明闭合，闭环结束
      if (endKey === startKey) break;
      const candidates = adjacency.get(endKey) ?? [];
      let next = -1;
      for (const candidate of candidates) {
        if (!used[candidate]) {
          next = candidate;
          break;
        }
      }
      // 找不到可接续的线段：轮廓在此断开，丢弃这条不完整的链
      if (next < 0) break;
      // 下一条线段可能以 b 为起点，方向相反时就地交换两个端点
      if (pointKey(segments[next].a) !== endKey) segments[next] = { a: segments[next].b, b: segments[next].a };
      current = next;
    }

    // 少于 4 条的闭环通常是采样噪声或退化图形，不作为有效轮廓
    if (loop.length >= 4) loops.push(loop);
  }
  return loops;
}

/**
 * 简化闭合轮廓（Douglas-Peucker）。
 * 首尾补上起点把闭环视作一条折线，简化后再去掉重复的末点还原为闭合形式。
 */
function simplifyClosed(points: Point[], epsilon: number): Point[] {
  // 顶点太少时无需简化，直接原样返回
  if (points.length <= 4) return points;
  const closed = points.concat([points[0]]);
  const result = simplifyOpen(closed, epsilon);
  // 简化结果通常仍保留首尾同点，去掉末尾重复项，避免后续面积 / 包含判定重复计数
  if (result.length > 1 && pointKey(result[result.length - 1]) === pointKey(result[0])) result.pop();
  return result;
}

/**
 * 简化开放折线（Douglas-Peucker）。
 *
 * 找到距离首尾连线最远的点，若其偏离超过 epsilon 则保留该点并递归处理左右两段，
 * 否则整段用首尾两点的直线近似。
 */
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
    // 保留最远点，再分别简化左右两段；left 的末点与 right 的首点是同一个，拼接时去重
    const left = simplifyOpen(points.slice(0, index + 1), epsilon);
    const right = simplifyOpen(points.slice(index), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

/**
 * 点到直线（首尾两点确定的无限直线）的距离。
 * Douglas-Peucker 用它对偏离程度做比较，不需要把点裁剪到线段范围内。
 */
function lineDistance(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  // 首尾重合时退化为点到点的距离，避免除零
  if (length < 1e-6) return Math.hypot(point.x - start.x, point.y - start.y);
  // 二维叉积的绝对值 / 底边长 = 高，即点到直线的垂直距离
  return Math.abs(dy * point.x - dx * point.y + end.x * start.y - end.y * start.x) / length;
}

/**
 * 用鞋带公式求多边形的有向面积。
 * 返回值带符号，符号反映顶点绕向；本模块只用绝对值比较轮廓大小，
 * 绕向本身不做约束（Three.js 的 Shape 会自动处理孔洞方向）。
 */
function signedArea(points: Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    sum += current.x * next.y - next.x * current.y;
  }
  return sum / 2;
}

/**
 * 判断点是否在多边形内部（射线法）。
 * 从待测点向 +X 方向发射射线，统计与多边形边的交点数量：奇数在内部、偶数在外部。
 * 邻边预处理成闭区间（j 从最后一点开始），水平边通过 y 比较条件自动跳过。
 */
function containsPoint(polygon: Point[], point: Point): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    // 先判断射线所在水平线是否穿过该边（y 区间跨越），再比较交点是否在点的右侧
    if (
      (a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || 1e-9) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * 判断每条轮廓的父子关系，用于区分外轮廓与孔洞。
 *
 * 规则：若轮廓 A 的所有点都落在轮廓 B 内部，且 B 面积更大，则 B 是 A 的父轮廓；
 * 取满足条件的面积最小的那个作为直接父级（排除嵌套中间层）。
 * parent = -1 表示最外层轮廓，会被挤出为实体；其余轮廓作为 holes 挖空。
 *
 * 面积比较留了 1.02 的容差：避免两条几乎等大的轮廓（如描边重复）互相认作父子。
 */
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
      // 父轮廓必须显著更大；同时只保留面积最接近（最小）的那个作为直接父级
      if (candidate.area <= contour.area * 1.02 || candidate.area >= parentArea) continue;
      // 只需要检查轮廓的一个代表点：闭包之间不会相交，落在内部即整体被包含
      if (!containsPoint(candidate.points, contour.points[0])) continue;
      parent = j;
      parentArea = candidate.area;
    }
    contour.parent = parent;
  }
  return contours;
}
