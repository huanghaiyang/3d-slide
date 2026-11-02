/**
 * ModelViewer.tsx —— 独立的三维模型预览器
 *
 * 组件职责：
 * - 在属性面板 / 资源详情中用一个独立的 WebGL 画布预览 3D 模型；
 * - 只负责预览：自带场景、相机、灯光与网格地面，不参与作品的实际渲染；
 * - 展示加载中 / 加载失败 / 就绪三种状态，就绪后提示拖拽旋转、滚轮缩放。
 *
 * 主要交互：
 * - 通过 OrbitControls 支持拖拽旋转、滚轮缩放，并默认开启缓慢自动旋转；
 * - 监听容器尺寸变化（ResizeObserver）同步画布与相机纵横比。
 *
 * 与其他模块的关系：
 * - 模型解析与释放逻辑来自 lib/model3d 的 loadModelGroup / disposeObject3D；
 * - 与作品中的场景对象（three/SceneManager）是两套独立的 Three.js 实例。
 */

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { ModelFormat } from '../types';
import { disposeObject3D, loadModelGroup } from '../lib/model3d';

interface ModelViewerProps {
  /** 模型资源地址（blob URL 或资源库 URL）。 */
  src: string;
  /** 模型格式，决定解析器选择。 */
  format: ModelFormat;
  /** 模型名称，作为加载失败等信息中的标识。 */
  name: string;
  /** 预览容器高度（像素），默认 420。 */
  height?: number;
}

/**
 * 模型预览组件。
 *
 * 每次 src / format / name 变化都会重建整个 Three.js 环境；
 * 卸载或重新加载时会取消动画帧、断开尺寸监听并释放几何体、材质、纹理与渲染器。
 * 通过 disposed 标记防止异步加载完成后向已卸载的组件写入状态。
 *
 * @param props 见 ModelViewerProps
 */
export function ModelViewer({ src, format, name, height = 420 }: ModelViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  // 加载状态机：loading -> ready / error；message 存错误原因
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState('');

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !src) return;
    // disposed 用于屏蔽「组件已卸载但异步加载才完成」的回调
    let disposed = false;
    setState('loading');
    setMessage('');
    // 预览用渲染器：开启抗锯齿，使用不透明背景与 sRGB 输出
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    host.appendChild(renderer.domElement);

    // 独立场景：深色背景 + 45 度视角相机，初始机位斜上方观察模型
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#10161F');
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    camera.position.set(1.5, 1.1, 1.7);
    // 轨道控制器：阻尼让拖拽停止后平滑减速，自动旋转让模型缓慢展示全貌
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 1.2;

    // 三灯布光：环境光打底，主光塑造体积，偏蓝补光避免暗面全黑
    scene.add(new THREE.AmbientLight(0xffffff, 1.2));
    const key = new THREE.DirectionalLight(0xffffff, 2);
    key.position.set(2.5, 3, 2);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x9fb7d4, 1);
    fill.position.set(-3, 1, -2);
    scene.add(fill);

    // 网格地面用于提供空间参照，略微下移避免与模型底面重叠
    const grid = new THREE.GridHelper(4, 20, 0x2f4a5e, 0x22333f);
    grid.position.y = -0.55;
    scene.add(grid);

    let model: THREE.Group | null = null;
    let raf = 0;
    let resizeObserver: ResizeObserver | null = null;

    // 尺寸同步：容器宽高变化时更新渲染尺寸与相机纵横比；
    // 第三参数 false 表示不改写 canvas 的 CSS 尺寸（已有 100% 样式）
    const resize = () => {
      const rect = host.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const h = Math.max(1, rect.height);
      renderer.setSize(width, h, false);
      camera.aspect = width / h;
      camera.updateProjectionMatrix();
    };
    resize();
    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);

    // 异步加载模型：成功则挂到场景并切到 ready；
    // 若此时组件已卸载 / 已换源，立即释放刚加载的 group，避免显存泄漏
    void loadModelGroup(src, format, name)
      .then(({ group }) => {
        if (disposed) {
          disposeObject3D(group);
          return;
        }
        model = group;
        scene.add(group);
        controls.autoRotateSpeed = 1.2;
        setState('ready');
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setState('error');
        setMessage(error instanceof Error ? error.message : '模型加载失败');
      });

    // 渲染循环：每帧先刷新控制器（阻尼 / 自动旋转需要持续 update），再绘制一帧
    const animate = () => {
      raf = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    // 清理：取消动画、断开尺寸监听、释放控制器 / 模型 / 网格 / 渲染器，
    // 并移除 canvas，防止重复挂载时出现多块画布
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      resizeObserver?.disconnect();
      controls.dispose();
      if (model) disposeObject3D(model);
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [src, format, name]);

  return (
    <div className="model-viewer" style={{ height }}>
      {/* Three.js 画布的实际挂载点 */}
      <div className="model-viewer-canvas" ref={hostRef} />
      {/* 未就绪时用覆盖层遮挡画布：加载中显示 spinner，失败显示原因 */}
      {state !== 'ready' && (
        <div className="model-viewer-overlay">
          {state === 'loading' ? (
            <>
              <span className="model-spinner" />
              <p>正在解析模型…</p>
            </>
          ) : (
            <>
              <b>模型无法加载</b>
              <p>{message}</p>
            </>
          )}
        </div>
      )}
      {/* 就绪后给出操作提示（悬停显示，不遮挡模型） */}
      {state === 'ready' && <span className="model-viewer-hint">拖拽旋转 · 滚轮缩放</span>}
    </div>
  );
}
