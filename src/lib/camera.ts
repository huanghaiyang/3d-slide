import type { ViewState, Vec3 } from '../types';
import { DEFAULT_DISTANCE, FOV } from './constants';

export function cameraPosition(view: ViewState): Vec3 {
  const cp = Math.cos(view.pitch);
  return {
    x: view.target.x + view.distance * Math.sin(view.yaw) * cp,
    y: view.target.y - view.distance * Math.sin(view.pitch),
    z: view.target.z + view.distance * Math.cos(view.yaw) * cp,
  };
}

export function clampPitch(pitch: number): number {
  const limit = (82 * Math.PI) / 180;
  return Math.max(-limit, Math.min(limit, pitch));
}

/** 视口中心射线在指定深度平面上的世界坐标 */
export function viewCenterAtZ(view: ViewState, z: number): { x: number; y: number } {
  const cam = cameraPosition(view);
  const dz = view.target.z - cam.z;
  if (Math.abs(dz) < 1e-6) return { x: view.target.x, y: view.target.y };
  const t = (z - cam.z) / dz;
  return {
    x: cam.x + (view.target.x - cam.x) * t,
    y: cam.y + (view.target.y - cam.y) * t,
  };
}

export function shortestAngle(from: number, to: number): number {
  const twoPi = Math.PI * 2;
  let delta = (to - from) % twoPi;
  if (delta > Math.PI) delta -= twoPi;
  if (delta < -Math.PI) delta += twoPi;
  return delta;
}

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

export function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function fitDistance(width: number, height: number, margin = 1.18): number {
  const tanHalf = Math.tan((FOV / 2) * (Math.PI / 180));
  const distH = (height * margin) / 2 / tanHalf;
  const distW = (width * margin) / 2 / (tanHalf * (16 / 9));
  return Math.max(distH, distW, 40);
}

/** 视口相对初始 16:9 取景的缩放百分比 */
export function zoomPercent(distance: number): number {
  return Math.round((DEFAULT_DISTANCE / distance) * 100);
}

export function formatZoom(distance: number): string {
  return `${Math.max(1, zoomPercent(distance))}%`;
}
