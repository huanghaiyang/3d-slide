import * as THREE from 'three';
import type { Deck, ImageObject, ShapeObject, SlideObject, TextObject, ViewState } from '../types';
import { ACCENT, ASPECT, FOV } from '../lib/constants';
import { cameraPosition, clampPitch, lerpView } from '../lib/camera';
import { fontCss, layoutText } from '../lib/text';

export type StageMode = 'edit' | 'view' | 'present';

interface SceneCallbacks {
  onImageError: (id: string, message: string) => void;
}

interface ImageState {
  src: string;
  status: 'pending' | 'loaded' | 'error';
  texture?: THREE.Texture;
}

interface ObjectNode {
  group: THREE.Group;
  content: THREE.Group | null;
  outline: THREE.LineSegments;
  handles: THREE.Points;
  materials: THREE.Material[];
  ownedTextures: THREE.Texture[];
  visualKey: string;
  outlineWidth: number;
  outlineHeight: number;
  imageState: ImageState | null;
  data: SlideObject;
  objectId: string;
  pickRoot: THREE.Group | null;
}

type CacheEntry = THREE.Texture | 'loading' | 'error';

function disposeMaterial(material: THREE.Material) {
  material.dispose();
}

export class SceneManager {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private view: ViewState;
  private mode: StageMode;
  private callbacks: SceneCallbacks;
  private objectsRoot = new THREE.Group();
  private nodes = new Map<string, ObjectNode>();
  private selectedId: string | null = null;
  private showGrid = true;
  private grid: THREE.LineSegments | null = null;
  private gridKey = '';
  private width = 960;
  private height = 540;
  private raf = 0;
  private disposed = false;
  private animation: {
    from: ViewState;
    to: ViewState;
    start: number;
    duration: number;
    resolve: () => void;
  } | null = null;
  private imageCache = new Map<string, CacheEntry>();
  private imagePending = new Set<string>();
  private placeholderTexture: THREE.Texture;
  private solidAccent: THREE.LineBasicMaterial;
  private dashedAccent: THREE.LineDashedMaterial;
  private dashedGray: THREE.LineDashedMaterial;
  private handleMaterial: THREE.PointsMaterial;
  private maxAnisotropy = 4;

  constructor(
    container: HTMLElement,
    background: string,
    initialView: ViewState,
    mode: StageMode,
    callbacks: SceneCallbacks,
  ) {
    this.mode = mode;
    this.callbacks = callbacks;
    this.view = { ...initialView, target: { ...initialView.target } };

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    container.appendChild(this.renderer.domElement);
    this.maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(background);
    this.camera = new THREE.PerspectiveCamera(FOV, ASPECT, 0.1, 200000);
    this.camera.up.set(0, -1, 0);
    this.scene.add(this.objectsRoot);

    this.solidAccent = new THREE.LineBasicMaterial({
      color: ACCENT,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
    });
    this.dashedAccent = new THREE.LineDashedMaterial({
      color: ACCENT,
      dashSize: 10,
      gapSize: 6,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false,
    });
    this.dashedGray = new THREE.LineDashedMaterial({
      color: 0x8c94a2,
      dashSize: 9,
      gapSize: 7,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
      depthWrite: false,
    });
    this.handleMaterial = new THREE.PointsMaterial({
      color: ACCENT,
      size: 6,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
    });
    this.placeholderTexture = this.createPlaceholderTexture();

    this.applyView(this.view);
    this.resize(this.width, this.height);
    this.tick = this.tick.bind(this);
    this.raf = requestAnimationFrame(this.tick);
  }

  private createPlaceholderTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 576;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#1A2532';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = 'rgba(140,148,162,.5)';
    ctx.setLineDash([14, 10]);
    ctx.lineWidth = 3;
    ctx.strokeRect(18, 18, canvas.width - 36, canvas.height - 36);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(201,210,223,.55)';
    ctx.font = '500 34px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('图片无法加载', canvas.width / 2, canvas.height / 2 - 20);
    ctx.font = '400 24px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.fillText('可重试、替换或删除该对象', canvas.width / 2, canvas.height / 2 + 34);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  setBackground(color: string) {
    (this.scene.background as THREE.Color).set(color);
  }

  setMode(mode: StageMode) {
    this.mode = mode;
    for (const node of this.nodes.values()) this.applyNodeAppearance(node);
    this.gridDirty();
  }

  setShowGrid(show: boolean) {
    this.showGrid = show;
    this.gridDirty();
  }

  setSelected(id: string | null) {
    if (this.selectedId === id) return;
    this.selectedId = id;
    for (const node of this.nodes.values()) {
      this.applyOutline(node, node.data.visible);
      this.applyNodeAppearance(node);
    }
  }

  resize(width: number, height: number) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = ASPECT;
    this.camera.updateProjectionMatrix();
    this.gridDirty();
  }

  getView(): ViewState {
    return { ...this.view, target: { ...this.view.target } };
  }

  sync(deck: Deck, selectedId: string | null, mode: StageMode) {
    this.mode = mode;
    this.selectedId = selectedId;
    this.setBackground(deck.background);
    const live = new Set(deck.objects.map((object) => object.id));
    for (const [id, node] of this.nodes) {
      if (!live.has(id)) {
        this.removeNode(node);
        this.nodes.delete(id);
      }
    }
    const sorted = [...deck.objects].sort((a, b) => a.z - b.z);
    sorted.forEach((object, index) => {
      let node = this.nodes.get(object.id);
      if (!node) {
        node = this.createNode(object);
        this.nodes.set(object.id, node);
        this.objectsRoot.add(node.group);
      }
      node.data = object;
      node.group.position.set(object.x, object.y, object.z);
      node.group.rotation.z = (object.rotation * Math.PI) / 180;
      node.group.renderOrder = index;
      node.group.visible =
        mode === 'present' || mode === 'view' ? object.visible : true;
      if (mode === 'present' || mode === 'view') {
        if (!object.visible) {
          node.group.visible = false;
          return;
        }
      }
      const key = this.visualKey(object);
      if (key !== node.visualKey) {
        node.visualKey = key;
        this.rebuildContent(node);
      }
      this.applyOutline(node, object.visible);
      this.applyNodeAppearance(node);
    });
    this.gridDirty();
  }

  private visualKey(object: SlideObject): string {
    if (object.type === 'text') {
      const t = object as TextObject;
      return [
        'text', t.text, t.width, t.height, t.fontSize, t.font, t.bold, t.align, t.color, t.lineHeight,
      ].join('|');
    }
    if (object.type === 'image') {
      const image = object as ImageObject;
      return ['image', image.src, image.width, image.height, image.fit].join('|');
    }
    const shape = object as ShapeObject;
    return ['shape', shape.shape, shape.width, shape.height, shape.fill, shape.stroke ?? '', shape.strokeWidth].join('|');
  }

  private createNode(object: SlideObject): ObjectNode {
    const group = new THREE.Group();
    group.userData.objectId = object.id;
    group.userData.nodeRoot = true;
    const outlineGeometry = this.outlineGeometry(object.width, Math.max(object.height, 8));
    const outline = new THREE.LineSegments(outlineGeometry, this.solidAccent);
    outline.computeLineDistances();
    outline.renderOrder = 1000;
    outline.visible = false;
    group.add(outline);
    const handleGeometry = new THREE.BufferGeometry();
    handleGeometry.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
    const handles = new THREE.Points(handleGeometry, this.handleMaterial);
    handles.renderOrder = 1001;
    handles.visible = false;
    group.add(handles);
    const node: ObjectNode = {
      group,
      content: null,
      outline,
      handles,
      materials: [],
      ownedTextures: [],
      visualKey: '',
      outlineWidth: object.width,
      outlineHeight: Math.max(object.height, 8),
      imageState: null,
      data: object,
      objectId: object.id,
      pickRoot: null,
    };
    this.rebuildContent(node);
    return node;
  }

  private outlineGeometry(width: number, height: number): THREE.BufferGeometry {
    const w = width / 2;
    const h = height / 2;
    const positions = [
      -w, -h, 0, w, -h, 0,
      w, -h, 0, w, h, 0,
      w, h, 0, -w, h, 0,
      -w, h, 0, -w, -h, 0,
    ];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return geometry;
  }

  private handleGeometry(width: number, height: number): THREE.BufferGeometry {
    const w = width / 2;
    const h = height / 2;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-w, -h, 0, w, -h, 0, w, h, 0, -w, h, 0], 3),
    );
    return geometry;
  }

  private applyOutline(node: ObjectNode, visibleObject: boolean) {
    const isSelected = this.mode === 'edit' && this.selectedId === node.objectId;
    const showHidden = this.mode === 'edit' && !visibleObject;
    if (node.outlineWidth !== node.data.width || node.outlineHeight !== Math.max(node.data.height, 8)) {
      node.outlineWidth = node.data.width;
      node.outlineHeight = Math.max(node.data.height, 8);
      node.outline.geometry.dispose();
      node.outline.geometry = this.outlineGeometry(node.outlineWidth, node.outlineHeight);
      node.outline.computeLineDistances();
      node.handles.geometry.dispose();
      node.handles.geometry = this.handleGeometry(node.outlineWidth, node.outlineHeight);
    }
    node.outline.visible = isSelected || showHidden;
    node.handles.visible = isSelected;
    if (isSelected) node.outline.material = this.solidAccent;
    else if (showHidden) node.outline.material = this.dashedGray;
    else node.outline.material = this.dashedAccent;
  }

  private applyNodeAppearance(node: ObjectNode) {
    const object = node.data;
    const hiddenInEdit = this.mode === 'edit' && !object.visible;
    const base = Math.max(0, Math.min(100, object.opacity)) / 100;
    const opacity = hiddenInEdit ? Math.min(base, 0.24) : base;
    const needsTransparent = opacity < 1 || object.type === 'text' || object.type === 'image' || hiddenInEdit;
    for (const material of node.materials) {
      const mat = material as THREE.MeshBasicMaterial;
      mat.opacity = opacity;
      mat.transparent = needsTransparent;
      mat.depthWrite = !needsTransparent;
    }
    this.applyOutline(node, object.visible);
  }

  private clearContent(node: ObjectNode) {
    if (node.content) {
      node.group.remove(node.content);
      node.content.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) material.forEach(disposeMaterial);
        else if (material) disposeMaterial(material);
      });
      node.content = null;
    }
    for (const texture of node.ownedTextures) texture.dispose();
    node.ownedTextures = [];
    node.materials = [];
    node.pickRoot = null;
  }

  private pickRoots(): THREE.Object3D[] {
    const roots: THREE.Object3D[] = [];
    for (const node of this.nodes.values()) {
      if (node.pickRoot) roots.push(node.pickRoot);
    }
    return roots;
  }

  private rebuildContent(node: ObjectNode) {
    this.clearContent(node);
    const object = node.data;
    const group = new THREE.Group();
    group.userData.objectId = object.id;
    this.buildInto(group, object, node);
    group.traverse((child) => {
      child.userData.objectId = object.id;
    });
    node.group.add(group);
    node.content = group;
    node.pickRoot = group;
    node.visualKey = this.visualKey(node.data);
    this.applyNodeAppearance(node);
    this.applyOutline(node, node.data.visible);
    node.outline.computeLineDistances();
  }

  private buildInto(group: THREE.Group, object: SlideObject, node: ObjectNode) {
    if (object.type === 'text') {
      this.buildText(group, object as TextObject, node);
      return;
    }
    if (object.type === 'image') {
      this.buildImage(group, object as ImageObject, node);
      return;
    }
    this.buildShape(group, object as ShapeObject, node);
  }

  private buildText(group: THREE.Group, object: TextObject, node: ObjectNode) {
    const texture = this.createTextTexture(object, node);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(object.width, object.height), material);
    group.add(mesh);
    node.materials.push(material);
  }

  private createTextTexture(object: TextObject, node: ObjectNode): THREE.CanvasTexture {
    const density = Math.min(
      2,
      4096 / Math.max(1, object.width),
      4096 / Math.max(1, object.height),
    );
    const canvasWidth = Math.max(1, Math.round(object.width * density));
    const canvasHeight = Math.max(1, Math.round(object.height * density));
    const canvas = document.createElement('canvas');
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const ctx = canvas.getContext('2d')!;
    const layout = layoutText(object.text, object.width, object.fontSize, object.font, object.bold, object.lineHeight);
    const fontPx = object.fontSize * density;
    ctx.font = fontCss(object.font, object.fontSize, object.bold, density);
    ctx.fillStyle = object.color;
    ctx.textBaseline = 'alphabetic';
    const lineHeightPx = fontPx * object.lineHeight;
    const paddingTop = fontPx * 0.3;
    ctx.textAlign = object.align === 'center' ? 'center' : object.align === 'right' ? 'right' : 'left';
    const x = object.align === 'center' ? canvasWidth / 2 : object.align === 'right' ? canvasWidth : 0;
    layout.lines.forEach((line, index) => {
      ctx.fillText(line, x, paddingTop + fontPx * 0.8 + index * lineHeightPx);
    });
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.anisotropy = this.maxAnisotropy;
    node.ownedTextures.push(texture);
    return texture;
  }

  private ensureImage(node: ObjectNode, object: ImageObject) {
    if (node.imageState && node.imageState.src === object.src) return;
    node.imageState = null;
    if (!object.src) {
      node.imageState = { src: '', status: 'error' };
      return;
    }
    const cached = this.imageCache.get(object.src);
    if (cached === 'error') {
      node.imageState = { src: object.src, status: 'error' };
      this.callbacks.onImageError(node.objectId, '图片无法加载');
      return;
    }
    if (cached && cached !== 'loading') {
      node.imageState = { src: object.src, status: 'loaded', texture: cached };
      return;
    }
    node.imageState = { src: object.src, status: 'pending' };
    if (this.imagePending.has(object.src)) return;
    this.imagePending.add(object.src);
    this.imageCache.set(object.src, 'loading');
    const loader = new THREE.TextureLoader();
    loader.load(
      object.src,
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = this.maxAnisotropy;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        this.imageCache.set(object.src, texture);
        this.imagePending.delete(object.src);
        for (const other of this.nodes.values()) {
          if (other.imageState?.src === object.src && other.imageState.status === 'pending') {
            other.imageState = { src: object.src, status: 'loaded', texture };
            other.visualKey = '';
            this.rebuildContent(other);
          }
        }
      },
      undefined,
      () => {
        this.imageCache.set(object.src, 'error');
        this.imagePending.delete(object.src);
        for (const other of this.nodes.values()) {
          if (other.imageState?.src === object.src && other.imageState.status === 'pending') {
            other.imageState = { src: object.src, status: 'error' };
            this.callbacks.onImageError(other.objectId, '图片无法加载');
            other.visualKey = '';
            this.rebuildContent(other);
          }
        }
      },
    );
  }

  retryImage(id: string) {
    const node = this.nodes.get(id);
    if (!node) return;
    const src = node.imageState?.src;
    if (src) {
      this.imageCache.delete(src);
      this.imagePending.delete(src);
    }
    node.imageState = null;
    node.visualKey = '';
    this.rebuildContent(node);
  }

  private buildImage(group: THREE.Group, object: ImageObject, node: ObjectNode) {
    this.ensureImage(node, object);
    const loaded = node.imageState?.status === 'loaded' && node.imageState.texture;
    let texture: THREE.Texture = this.placeholderTexture;
    let drawWidth = object.width;
    let drawHeight = object.height;
    let clone: THREE.Texture | null = null;

    if (loaded) {
      const source = node.imageState!.texture!;
      const imageAspect = object.naturalWidth / object.naturalHeight || 1;
      if (object.fit === 'contain') {
        const boxAspect = object.width / object.height;
        if (imageAspect >= boxAspect) {
          drawWidth = object.width;
          drawHeight = object.width / imageAspect;
        } else {
          drawHeight = object.height;
          drawWidth = object.height * imageAspect;
        }
        texture = source;
      } else {
        clone = source.clone();
        clone.needsUpdate = true;
        clone.wrapS = THREE.ClampToEdgeWrapping;
        clone.wrapT = THREE.ClampToEdgeWrapping;
        const boxAspect = object.width / object.height;
        if (imageAspect >= boxAspect) {
          const repeatX = boxAspect / imageAspect;
          clone.repeat.set(repeatX, 1);
          clone.offset.set((1 - repeatX) / 2, 0);
        } else {
          const repeatY = imageAspect / boxAspect;
          clone.repeat.set(1, repeatY);
          clone.offset.set(0, (1 - repeatY) / 2);
        }
        texture = clone;
        node.ownedTextures.push(clone);
      }
    }

    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const geometry = new THREE.PlaneGeometry(drawWidth, drawHeight);
    const mesh = new THREE.Mesh(geometry, material);
    group.add(mesh);
    node.materials.push(material);
  }

  private buildShape(group: THREE.Group, object: ShapeObject, node: ObjectNode) {
    const strokeEnabled = object.stroke !== null && object.strokeWidth > 0;
    const strokeColor = object.stroke ?? object.fill;
    if (object.shape === 'line') {
      const thickness = Math.max(2, object.strokeWidth || object.height);
      const material = new THREE.MeshBasicMaterial({ color: strokeColor, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(object.width, thickness), material);
      group.add(mesh);
      node.materials.push(material);
      return;
    }
    if (object.shape === 'rect') {
      if (strokeEnabled && object.stroke) {
        const strokeMaterial = new THREE.MeshBasicMaterial({ color: object.stroke, side: THREE.DoubleSide });
        group.add(new THREE.Mesh(new THREE.PlaneGeometry(object.width, object.height), strokeMaterial));
        node.materials.push(strokeMaterial);
        const innerWidth = Math.max(1, object.width - object.strokeWidth * 2);
        const innerHeight = Math.max(1, object.height - object.strokeWidth * 2);
        const fillMaterial = new THREE.MeshBasicMaterial({ color: object.fill, side: THREE.DoubleSide });
        const fill = new THREE.Mesh(new THREE.PlaneGeometry(innerWidth, innerHeight), fillMaterial);
        fill.position.z = 0.05;
        group.add(fill);
        node.materials.push(fillMaterial);
      } else {
        const material = new THREE.MeshBasicMaterial({ color: object.fill, side: THREE.DoubleSide });
        group.add(new THREE.Mesh(new THREE.PlaneGeometry(object.width, object.height), material));
        node.materials.push(material);
      }
      return;
    }
    // ellipse
    if (strokeEnabled && object.stroke) {
      const strokeMaterial = new THREE.MeshBasicMaterial({ color: object.stroke, side: THREE.DoubleSide });
      const outer = new THREE.Mesh(new THREE.CircleGeometry(0.5, 64), strokeMaterial);
      outer.scale.set(object.width, object.height, 1);
      group.add(outer);
      node.materials.push(strokeMaterial);
      const fillMaterial = new THREE.MeshBasicMaterial({ color: object.fill, side: THREE.DoubleSide });
      const inner = new THREE.Mesh(new THREE.CircleGeometry(0.5, 64), fillMaterial);
      inner.scale.set(
        Math.max(1, object.width - object.strokeWidth * 2),
        Math.max(1, object.height - object.strokeWidth * 2),
        1,
      );
      inner.position.z = 0.05;
      group.add(inner);
      node.materials.push(fillMaterial);
    } else {
      const material = new THREE.MeshBasicMaterial({ color: object.fill, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(new THREE.CircleGeometry(0.5, 64), material);
      mesh.scale.set(object.width, object.height, 1);
      group.add(mesh);
      node.materials.push(material);
    }
  }

  private removeNode(node: ObjectNode) {
    this.clearContent(node);
    node.group.remove(node.outline);
    node.outline.geometry.dispose();
    node.group.remove(node.handles);
    node.handles.geometry.dispose();
    this.objectsRoot.remove(node.group);
  }

  private applyView(view: ViewState) {
    this.view = view;
    const camera = cameraPosition(view);
    this.camera.position.set(camera.x, camera.y, camera.z);
    this.camera.up.set(0, -1, 0);
    this.camera.lookAt(view.target.x, view.target.y, view.target.z);
    this.camera.updateMatrixWorld();
    this.gridDirty();
  }

  private gridDirty() {
    this.gridKey = '';
  }

  private niceStep(raw: number): number {
    const exponent = Math.floor(Math.log10(Math.max(raw, 0.001)));
    const base = Math.pow(10, exponent);
    const n = raw / base;
    const factor = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10;
    return factor * base;
  }

  private unitsPerPixel(): number {
    const visibleHeight = 2 * this.view.distance * Math.tan((FOV / 2) * (Math.PI / 180));
    return visibleHeight / this.height;
  }

  private updateGrid() {
    if (!this.showGrid || this.mode !== 'edit') {
      if (this.grid) this.grid.visible = false;
      return;
    }
    const upp = this.unitsPerPixel();
    const step = this.niceStep(upp * 68);
    const centerX = Math.round(this.view.target.x / step) * step;
    const centerY = Math.round(this.view.target.y / step) * step;
    const z = this.view.target.z;
    const key = `${step}|${centerX}|${centerY}|${z.toFixed(1)}`;
    if (key === this.gridKey && this.grid) {
      this.grid.visible = true;
      return;
    }
    this.gridKey = key;
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      (this.grid.material as THREE.Material).dispose();
    }
    const range = step * 44;
    const positions: number[] = [];
    const colors: number[] = [];
    const minorColor = new THREE.Color(0x243240);
    const majorColor = new THREE.Color(0x3a4d60);
    const steps = Math.round(range / step);
    for (let i = -steps; i <= steps; i += 1) {
      if (i === 0) continue;
      const offset = i * step;
      const isMajor = i % 5 === 0;
      const color = isMajor ? majorColor : minorColor;
      positions.push(centerX - range, centerY + offset, z, centerX + range, centerY + offset, z);
      positions.push(centerX + offset, centerY - range, z, centerX + offset, centerY + range, z);
      for (let k = 0; k < 4; k += 1) colors.push(color.r, color.g, color.b);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    });
    const lines = new THREE.LineSegments(geometry, material);
    lines.renderOrder = -10;
    this.scene.add(lines);
    this.grid = lines;
    this.grid.visible = true;
  }

  private tick(now: number) {
    if (this.disposed) return;
    if (this.animation) {
      const { from, to, start, duration, resolve } = this.animation;
      const t = Math.min(1, (now - start) / duration);
      const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      this.applyView(lerpView(from, to, eased));
      if (t >= 1) {
        this.animation = null;
        this.applyView(to);
        resolve();
      }
    }
    this.updateGrid();
    this.renderer.render(this.scene, this.camera);
    this.raf = requestAnimationFrame(this.tick);
  }

  flyTo(view: ViewState, duration = 0.4): Promise<void> {
    if (this.animation) {
      this.animation.resolve();
      this.animation = null;
    }
    if (duration <= 0.001) {
      this.applyView(view);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.animation = {
        from: this.getView(),
        to: { ...view, target: { ...view.target } },
        start: performance.now(),
        duration: duration * 1000,
        resolve,
      };
    });
  }

  isAnimating(): boolean {
    return this.animation !== null;
  }

  private pointerNdc(clientX: number, clientY: number): THREE.Vector2 {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  hitTest(clientX: number, clientY: number): string | null {
    const roots = this.pickRoots();
    if (roots.length === 0) return null;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(this.pointerNdc(clientX, clientY), this.camera);
    const hits = raycaster.intersectObjects(roots, true);
    for (const hit of hits) {
      let current: THREE.Object3D | null = hit.object;
      while (current) {
        if (current.userData.nodeRoot) return current.userData.objectId as string;
        current = current.parent;
      }
      const id = hit.object.userData.objectId as string | undefined;
      if (id) return id;
    }
    return null;
  }

  screenToWorldOnPlane(clientX: number, clientY: number, z: number): { x: number; y: number } {
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(this.pointerNdc(clientX, clientY), this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -z);
    const point = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(plane, point)) {
      return { x: point.x, y: point.y };
    }
    return { x: this.view.target.x, y: this.view.target.y };
  }

  panBy(dx: number, dy: number) {
    if (this.animation) return;
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const down = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1).negate();
    const upp = this.unitsPerPixel();
    const view = this.getView();
    view.target.x += -dx * upp * right.x + -dy * upp * down.x;
    view.target.y += -dx * upp * right.y + -dy * upp * down.y;
    view.target.z += -dx * upp * right.z + -dy * upp * down.z;
    this.applyView(view);
  }

  orbitBy(dx: number, dy: number) {
    if (this.animation) return;
    const view = this.getView();
    view.yaw -= dx * 0.007;
    view.pitch = clampPitch(view.pitch - dy * 0.007);
    this.applyView(view);
  }

  zoomAt(clientX: number, clientY: number, factor: number, min: number, max: number) {
    if (this.animation) return;
    const oldView = this.getView();
    const newDistance = Math.max(min, Math.min(max, oldView.distance * factor));
    if (Math.abs(newDistance - oldView.distance) < 0.001) return;
    const z = oldView.target.z;
    const before = this.screenToWorldOnPlane(clientX, clientY, z);
    const next = this.getView();
    next.distance = newDistance;
    this.applyView(next);
    const after = this.screenToWorldOnPlane(clientX, clientY, z);
    next.target.x += before.x - after.x;
    next.target.y += before.y - after.y;
    this.applyView(next);
  }

  projectRect(objectId: string): {
    left: number;
    top: number;
    width: number;
    height: number;
    fontPx: number;
    lineHeightPx: number;
    paddingTop: number;
  } | null {
    const node = this.nodes.get(objectId);
    if (!node) return null;
    const object = node.data;
    node.group.updateMatrixWorld(true);
    this.camera.updateMatrixWorld();
    const corners = [
      new THREE.Vector3(-object.width / 2, -object.height / 2, 0),
      new THREE.Vector3(object.width / 2, -object.height / 2, 0),
      new THREE.Vector3(object.width / 2, object.height / 2, 0),
      new THREE.Vector3(-object.width / 2, object.height / 2, 0),
    ];
    const toScreen = (vector: THREE.Vector3) => {
      const world = node.group.localToWorld(vector.clone());
      const projected = world.clone().project(this.camera);
      return {
        x: ((projected.x + 1) / 2) * this.width,
        y: ((1 - projected.y) / 2) * this.height,
      };
    };
    const points = corners.map(toScreen);
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    const width = Math.max(1, Math.max(...xs) - left);
    const height = Math.max(1, Math.max(...ys) - top);
    const unitTop = toScreen(new THREE.Vector3(0, -object.height / 2, 0));
    const unitBottom = toScreen(new THREE.Vector3(0, -object.height / 2 + 1, 0));
    const pixelsPerUnit = Math.abs(unitBottom.y - unitTop.y);
    return {
      left,
      top,
      width,
      height,
      fontPx: pixelsPerUnit * (object.type === 'text' ? (object as TextObject).fontSize : 48),
      lineHeightPx: pixelsPerUnit * (object.type === 'text' ? (object as TextObject).fontSize * (object as TextObject).lineHeight : 48),
      paddingTop: pixelsPerUnit * 0.3 * (object.type === 'text' ? (object as TextObject).fontSize : 48),
    };
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    if (this.animation) {
      this.animation.resolve();
      this.animation = null;
    }
    for (const node of this.nodes.values()) this.removeNode(node);
    this.nodes.clear();
    if (this.grid) {
      this.grid.geometry.dispose();
      (this.grid.material as THREE.Material).dispose();
      this.grid = null;
    }
    for (const entry of this.imageCache.values()) {
      if (typeof entry !== 'string') entry.dispose();
    }
    this.imageCache.clear();
    this.placeholderTexture.dispose();
    this.solidAccent.dispose();
    this.dashedAccent.dispose();
    this.dashedGray.dispose();
    this.handleMaterial.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
