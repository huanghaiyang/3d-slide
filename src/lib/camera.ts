/**
 * camera.ts —— 相机视角的数学换算工具
 *
 * 本模块只负责纯计算，不接触 Three.js 对象与 React 状态，供 3D 场景、运镜动画、
 * 属性面板（缩放百分比）等多处复用。
 *
 * 视角约定（ViewState）：
 * - target：相机看向的世界坐标点（画面中心落在该点附近）；
 * - distance：相机到 target 的直线距离；
 * - yaw：绕 Y 轴的水平旋转角（弧度），0 表示相机位于 target 的 +Z 方向；
 * - pitch：俯仰角（弧度），正值表示相机下沉、向上仰视，负值表示相机升高、向下俯视。
 *
 * 世界坐标约定：Y 轴向上、Z 轴朝向默认观察者，1 单位约等于 1 像素（舞台宽 1920）。
 * 所有角度均为弧度制，对外展示时才换算成角度或百分比。
 */

import type { ViewState, Vec3 } from '../types';
import { DEFAULT_DISTANCE, FOV } from './constants';

/**
 * 由视角参数计算相机在世界坐标中的位置。
 *
 * 计算方式：先按 pitch 把距离投影到水平面（cos(pitch)），再按 yaw 分解到 X/Z 轴；
 * 垂直分量用 -sin(pitch)，因此 pitch 为正时相机位于 target 下方。
 *
 * @param view 当前视角（含 target、distance、yaw、pitch）
 * @returns 相机位置；yaw 与 pitch 都为 0 时返回 target + (0, 0, distance)
 */
export function cameraPosition(view: ViewState): Vec3 {
  const cp = Math.cos(view.pitch);
  return {
    x: view.target.x + view.distance * Math.sin(view.yaw) * cp,
    y: view.target.y - view.distance * Math.sin(view.pitch),
    z: view.target.z + view.distance * Math.cos(view.yaw) * cp,
  };
}

/**
 * 把俯仰角限制在 ±82 度以内。
 *
 * 接近 ±90 度时视线与「上方向」几乎平行，lookAt 会退化并导致画面翻滚，
 * 因此预留 8 度余量。角度在内部以弧度参与运算。
 *
 * @param pitch 原始俯仰角（弧度）
 * @returns 裁剪后的俯仰角（弧度）
 */
export function clampPitch(pitch: number): number {
  const limit = (82 * Math.PI) / 180;
  return Math.max(-limit, Math.min(limit, pitch));
}

/**
 * 求视口中心射线与指定深度平面（z = 常量）的交点。
 *
 * 新增对象时需要把屏幕中心映射到对象所在的 z 平面，避免不同层级上的对象看起来
 * 偏离画面中心。做法是把「相机 -> target」这条射线参数化：
 * P(t) = cam + t * (target - cam)，令其 z 分量为给定 z 解出 t，再取 x / y。
 * 注意 t 可以大于 1（平面位于 target 之后）或为负（平面位于相机之后）。
 *
 * @param view 当前视角
 * @param z    目标深度平面的 z 坐标
 * @returns 该平面上视口中心对应的世界坐标 x / y；
 *          射线与平面近乎平行（无交点）时退回到 target 的 x / y
 */
export function viewCenterAtZ(view: ViewState, z: number): { x: number; y: number } {
  const cam = cameraPosition(view);
  // 射线方向的 z 分量；接近 0 说明相机与 target 的深度几乎相同，平面无法与射线相交
  const dz = view.target.z - cam.z;
  if (Math.abs(dz) < 1e-6) return { x: view.target.x, y: view.target.y };
  const t = (z - cam.z) / dz;
  return {
    x: cam.x + (view.target.x - cam.x) * t,
    y: cam.y + (view.target.y - cam.y) * t,
  };
}

/**
 * 计算两个角度之间的最短有向差值，用于运镜时选择更短的旋转方向。
 *
 * 先把差值规整到 (-2π, 2π)，再收敛到 (-π, π]：例如从 170 度转到 -170 度时
 * 返回 +20 度而不是 -340 度，避免相机绕远路转一整圈。
 *
 * @param from 起始角（弧度）
 * @param to   目标角（弧度）
 * @returns 最短有向差值（弧度），正值表示逆时针方向
 */
export function shortestAngle(from: number, to: number): number {
  const twoPi = Math.PI * 2;
  let delta = (to - from) % twoPi;
  if (delta > Math.PI) delta -= twoPi;
  if (delta < -Math.PI) delta += twoPi;
  return delta;
}

/**
 * 在两个视角之间做线性插值，是相机飞行动画每一帧的核心计算。
 *
 * target、distance、pitch 直接线性插值；yaw 使用最短角差，保证水平旋转方向合理。
 * 不修改传入对象，返回全新的 ViewState（target 也是新对象）。
 *
 * @param from 起始视角
 * @param to   目标视角
 * @param t    进度，通常为 0–1（0 返回起始视角，1 返回目标视角）
 * @returns 插值得到的中间视角
 */
export function lerpView(from: ViewState, to: ViewState, t: number): ViewState {
  return {
    target: {
      x: from.target.x + (to.target.x - from.target.x) * t,
      y: from.target.y + (to.target.y - from.target.y) * t,
      z: from.target.z + (to.target.z - from.target.z) * t,
    },
    distance: from.distance + (to.distance - from.distance) * t,
    yaw: from.yaw + shortestAngle(from.yaw, to.yaw) * t,
    pitch: from.pitch + (to.pitch - from.pitch) * t,
  };
}

/**
 * 三次缓入缓出函数（easeInOutCubic）。
 *
 * 前后各一半时间用于加速与减速，中间速度最快，用于让运镜开始 / 结束更柔和。
 *
 * @param t 线性进度，通常为 0–1
 * @returns 缓动后的进度，0–1；t 超出范围时按公式外推
 */
export function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * 计算让指定宽高的矩形完整进入画面所需的相机距离。
 *
 * 推导：FOV 是垂直视场角，半角正切为 tanHalf，因此高度方向所需距离为
 * (height * margin) / 2 / tanHalf；画面固定 16:9，水平半角正切为
 * tanHalf * (16 / 9)，宽度方向同理。取两者较大值才能保证宽高都不越界。
 *
 * @param width  需要完整可见的内容宽度（世界单位）
 * @param height 需要完整可见的内容高度（世界单位）
 * @param margin 留白系数，1.18 表示四周额外留出约 18% 的安全边距
 * @returns 相机到目标点的距离；并设置 40 的下限防止贴得过近
 */
export function fitDistance(width: number, height: number, margin = 1.18): number {
  // FOV 以度为单位，这里换算为弧度后取半角正切
  const tanHalf = Math.tan((FOV / 2) * (Math.PI / 180));
  const distH = (height * margin) / 2 / tanHalf;
  const distW = (width * margin) / 2 / (tanHalf * (16 / 9));
  return Math.max(distH, distW, 40);
}

/**
 * 把相机距离换算成「相对初始 16:9 取景」的缩放百分比。
 *
 * 距离越小画面越大，因此用 DEFAULT_DISTANCE / distance 表示放大倍数：
 * 默认距离时为 100%，距离减半时为 200%。
 *
 * @param distance 当前相机到目标的距离
 * @returns 四舍五入后的百分比数值（未附加 % 号）
 */
export function zoomPercent(distance: number): number {
  return Math.round((DEFAULT_DISTANCE / distance) * 100);
}

/**
 * 生成用于界面展示的缩放文案（如 "150%"）。
 *
 * 距离极远时百分比可能小于 1，这里统一取整为 1% 起，避免出现 "0%" 之类的无效值。
 *
 * @param distance 当前相机距离
 * @returns 带百分号的缩放字符串
 */
export function formatZoom(distance: number): string {
  return `${Math.max(1, zoomPercent(distance))}%`;
}
