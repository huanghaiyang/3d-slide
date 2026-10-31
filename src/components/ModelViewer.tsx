import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { ModelFormat } from '../types';
import { disposeObject3D, loadModelGroup } from '../lib/model3d';

interface ModelViewerProps {
  src: string;
  format: ModelFormat;
  name: string;
  height?: number;
}

export function ModelViewer({ src, format, name, height = 420 }: ModelViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState('');

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !src) return;
    let disposed = false;
    setState('loading');
    setMessage('');
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#10161F');
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    camera.position.set(1.5, 1.1, 1.7);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 1.2;

    scene.add(new THREE.AmbientLight(0xffffff, 1.2));
    const key = new THREE.DirectionalLight(0xffffff, 2);
    key.position.set(2.5, 3, 2);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x9fb7d4, 1);
    fill.position.set(-3, 1, -2);
    scene.add(fill);

    const grid = new THREE.GridHelper(4, 20, 0x2f4a5e, 0x22333f);
    grid.position.y = -0.55;
    scene.add(grid);

    let model: THREE.Group | null = null;
    let raf = 0;
    let resizeObserver: ResizeObserver | null = null;

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

    const animate = () => {
      raf = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

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
      <div className="model-viewer-canvas" ref={hostRef} />
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
      {state === 'ready' && <span className="model-viewer-hint">拖拽旋转 · 滚轮缩放</span>}
    </div>
  );
}
