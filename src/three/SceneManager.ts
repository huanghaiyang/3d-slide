import * as THREE from 'three';
import type {
  AudioObject,
  Deck,
  ImageObject,
  MediaKind,
  ModelFormat,
  ModelObject,
  ShapeKind,
  ShapeObject,
  SlideObject,
  TextObject,
  VideoObject,
  ViewState,
} from '../types';
import { ACCENT, ASPECT, FOV } from '../lib/constants';
import { cameraPosition, clampPitch, lerpView } from '../lib/camera';
import { disposeObject3D, loadModelGroup } from '../lib/model3d';
import { fontCss, layoutText } from '../lib/text';

export type StageMode = 'edit' | 'view' | 'present';

export type HandleCorner = 'nw' | 'ne' | 'se' | 'sw';

interface SceneCallbacks {
  onImageError: (id: string, message: string) => void;
}

interface ImageState {
  src: string;
  status: 'pending' | 'loaded' | 'error';
  texture?: THREE.Texture;
}

interface MediaRuntime {
  kind: MediaKind;
  src: string;
  element: HTMLVideoElement | HTMLAudioElement | null;
  texture: THREE.VideoTexture | null;
  error: boolean;
  ready: boolean;
}

interface ModelRuntime {
  src: string;
  format: ModelFormat;
  status: 'loading' | 'ready' | 'error';
  group: THREE.Group | null;
  error?: string;
}

export interface MediaPlaybackState {
  kind: MediaKind;
  playing: boolean;
  time: number;
  duration: number;
  volume: number;
  muted: boolean;
  loop: boolean;
  error: boolean;
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
  media: MediaRuntime | null;
  model: ModelRuntime | null;
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
  private selectedIds: string[] = [];
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
  private mediaAutoplayArmed = false;
  private placeholderTexture: THREE.Texture;
  private modelLoadingTexture: THREE.Texture;
  private modelErrorTexture: THREE.Texture;
  private lastTickAt = performance.now();
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

    const ambient = new THREE.AmbientLight(0xffffff, 1.15);
    this.scene.add(ambient);
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.7);
    keyLight.position.set(900, -1200, 1400);
    this.scene.add(keyLight);
    this.scene.add(keyLight.target);
    const fillLight = new THREE.DirectionalLight(0x9fb7d4, 0.7);
    fillLight.position.set(-1000, 600, 800);
    this.scene.add(fillLight);
    this.scene.add(fillLight.target);

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
    this.modelLoadingTexture = this.createModelPlaceholderTexture('正在加载 3D 模型…');
    this.modelErrorTexture = this.createModelPlaceholderTexture('模型无法加载');

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

  private createModelPlaceholderTexture(label: string): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 1024;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#141E2A';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = 'rgba(45,212,191,.35)';
    ctx.lineWidth = 3;
    ctx.setLineDash([18, 12]);
    ctx.strokeRect(24, 24, canvas.width - 48, canvas.height - 48);
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(45,212,191,.55)';
    ctx.lineWidth = 4;
    const cx = canvas.width / 2;
    const cy = canvas.height / 2 - 70;
    const s = 150;
    const cube = [
      [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
      [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
    ] as [number, number, number][];
    const project = (point: [number, number, number]) => {
      const k = 1.9 / (3 + point[2]);
      return [cx + point[0] * s * k, cy + point[1] * s * k] as [number, number];
    };
    const edges: [number, number][] = [
      [0, 1], [1, 2], [2, 3], [3, 0],
      [4, 5], [5, 6], [6, 7], [7, 4],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];
    for (const [a, b] of edges) {
      const p1 = project(cube[a]);
      const p2 = project(cube[b]);
      ctx.beginPath();
      ctx.moveTo(p1[0], p1[1]);
      ctx.lineTo(p2[0], p2[1]);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(201,210,223,.7)';
    ctx.font = '500 40px "PingFang SC","Microsoft YaHei",sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, canvas.width / 2, cy + 270);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    return texture;
  }

  setBackground(color: string) {
    (this.scene.background as THREE.Color).set(color);
  }

  setMode(mode: StageMode) {
    const previousMode = this.mode;
    this.mode = mode;
    for (const node of this.nodes.values()) this.applyNodeAppearance(node);
    this.gridDirty();
    this.handleModeMedia(previousMode, mode);
  }

  setShowGrid(show: boolean) {
    this.showGrid = show;
    this.gridDirty();
  }

  setSelected(ids: string[]) {
    if (this.selectedIds.length === ids.length && ids.every((id, i) => this.selectedIds[i] === id)) return;
    this.selectedIds = ids;
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

  sync(deck: Deck, selectedIds: string[], mode: StageMode) {
    const previousMode = this.mode;
    this.mode = mode;
    this.selectedIds = selectedIds;
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
      if (node.media) this.applyMediaSettings(node.media, object);
      this.applyOutline(node, object.visible);
      this.applyNodeAppearance(node);
    });
    this.gridDirty();
    this.handleModeMedia(previousMode, mode);
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
    if (object.type === 'video') {
      const video = object as VideoObject;
      return ['video', video.src, video.width, video.height, video.fit].join('|');
    }
    if (object.type === 'audio') {
      const audio = object as AudioObject;
      return ['audio', audio.src, audio.name, audio.width, audio.height, audio.duration].join('|');
    }
    if (object.type === 'model') {
      const model = object as ModelObject;
      return ['model', model.src, model.format, model.width, model.height].join('|');
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
      media: null,
      model: null,
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
    const isSelected = this.mode === 'edit' && this.selectedIds.includes(node.objectId);
    const isPrimary = this.mode === 'edit' && this.selectedIds[0] === node.objectId;
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
    node.handles.visible = isPrimary;
    if (isSelected) node.outline.material = this.solidAccent;
    else if (showHidden) node.outline.material = this.dashedGray;
    else node.outline.material = this.dashedAccent;
  }

  private applyNodeAppearance(node: ObjectNode) {
    const object = node.data;
    const hiddenInEdit = this.mode === 'edit' && !object.visible;
    const base = Math.max(0, Math.min(100, object.opacity)) / 100;
    const opacity = hiddenInEdit ? Math.min(base, 0.24) : base;
    const needsTransparent =
      opacity < 1 ||
      object.type === 'text' ||
      object.type === 'image' ||
      object.type === 'video' ||
      object.type === 'audio' ||
      hiddenInEdit;
    for (const material of node.materials) {
      const mat = material as THREE.MeshBasicMaterial;
      mat.opacity = opacity;
      mat.transparent = needsTransparent;
      mat.depthWrite = !needsTransparent;
    }
    this.applyOutline(node, object.visible);
  }

  private clearContent(node: ObjectNode) {
    const modelGroup = node.model?.group;
    if (modelGroup?.parent) modelGroup.parent.remove(modelGroup);
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
    // 世界坐标 Y 轴向下（与画布坐标一致），内容需翻转以保证文字/图片正立
    group.scale.y = -1;
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
    if (object.type === 'video') {
      this.buildVideo(group, object as VideoObject, node);
      return;
    }
    if (object.type === 'audio') {
      this.buildAudio(group, object as AudioObject, node);
      return;
    }
    if (object.type === 'model') {
      this.buildModel(group, object as ModelObject, node);
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
    if (node.media) this.disposeMedia(node);
    if (node.model) this.disposeModel(node);
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
    if (object.shape !== 'rect' && object.shape !== 'ellipse') {
      this.buildPathShape(group, object, node);
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

  private buildPathShape(group: THREE.Group, object: ShapeObject, node: ObjectNode) {
    const geometry = new THREE.ShapeGeometry(this.makePathShape(object.shape), 24);
    const strokeEnabled = object.stroke !== null && object.strokeWidth > 0;
    if (strokeEnabled) {
      const strokeMaterial = new THREE.MeshBasicMaterial({ color: object.stroke!, side: THREE.DoubleSide });
      const outer = new THREE.Mesh(geometry, strokeMaterial);
      outer.scale.set(object.width + object.strokeWidth * 2, object.height + object.strokeWidth * 2, 1);
      group.add(outer);
      node.materials.push(strokeMaterial);
    }
    const fillMaterial = new THREE.MeshBasicMaterial({ color: object.fill, side: THREE.DoubleSide });
    const inner = new THREE.Mesh(geometry, fillMaterial);
    inner.scale.set(object.width, object.height, 1);
    inner.position.z = strokeEnabled ? 0.05 : 0;
    group.add(inner);
    node.materials.push(fillMaterial);
  }

  private makePathShape(kind: ShapeKind): THREE.Shape {
    const shape = new THREE.Shape();
    if (kind === 'triangle') {
      shape.moveTo(0, 0.5);
      shape.lineTo(-0.5, -0.5);
      shape.lineTo(0.5, -0.5);
      shape.closePath();
      return shape;
    }
    if (kind === 'diamond') {
      shape.moveTo(0, 0.5);
      shape.lineTo(0.5, 0);
      shape.lineTo(0, -0.5);
      shape.lineTo(-0.5, 0);
      shape.closePath();
      return shape;
    }
    if (kind === 'star') {
      const outer = 0.5;
      const inner = 0.22;
      for (let i = 0; i < 10; i += 1) {
        const radius = i % 2 === 0 ? outer : inner;
        const angle = Math.PI / 2 + (i * Math.PI) / 5;
        const x = Math.cos(angle) * radius;
        const y = Math.sin(angle) * radius;
        if (i === 0) shape.moveTo(x, y);
        else shape.lineTo(x, y);
      }
      shape.closePath();
      return shape;
    }
    if (kind === 'arrow') {
      shape.moveTo(-0.5, -0.18);
      shape.lineTo(0.12, -0.18);
      shape.lineTo(0.12, -0.5);
      shape.lineTo(0.5, 0);
      shape.lineTo(0.12, 0.5);
      shape.lineTo(0.12, 0.18);
      shape.lineTo(-0.5, 0.18);
      shape.closePath();
      return shape;
    }
    if (kind === 'roundedRect') {
      const r = 0.16;
      shape.moveTo(-0.5 + r, -0.5);
      shape.lineTo(0.5 - r, -0.5);
      shape.quadraticCurveTo(0.5, -0.5, 0.5, -0.5 + r);
      shape.lineTo(0.5, 0.5 - r);
      shape.quadraticCurveTo(0.5, 0.5, 0.5 - r, 0.5);
      shape.lineTo(-0.5 + r, 0.5);
      shape.quadraticCurveTo(-0.5, 0.5, -0.5, 0.5 - r);
      shape.lineTo(-0.5, -0.5 + r);
      shape.quadraticCurveTo(-0.5, -0.5, -0.5 + r, -0.5);
      return shape;
    }
    shape.moveTo(-0.5, -0.5);
    shape.lineTo(0.5, -0.5);
    shape.lineTo(0.5, 0.5);
    shape.lineTo(-0.5, 0.5);
    shape.closePath();
    return shape;
  }

  private ensureModel(node: ObjectNode, object: ModelObject) {
    const existing = node.model;
    if (existing && existing.src === object.src && existing.format === object.format) return;
    this.disposeModel(node);
    const runtime: ModelRuntime = {
      src: object.src,
      format: object.format,
      status: 'loading',
      group: null,
    };
    node.model = runtime;
    if (!object.src) {
      runtime.status = 'error';
      runtime.error = '缺少模型素材';
      return;
    }
    void loadModelGroup(object.src, object.format, object.name)
      .then(({ group }) => {
        if (this.nodes.get(node.objectId) !== node || node.model !== runtime || this.disposed) {
          disposeObject3D(group);
          return;
        }
        runtime.group = group;
        runtime.status = 'ready';
        node.visualKey = '';
        this.rebuildContent(node);
      })
      .catch((error: unknown) => {
        if (node.model !== runtime) return;
        runtime.status = 'error';
        runtime.error = error instanceof Error ? error.message : '模型加载失败';
        this.callbacks.onImageError(node.objectId, `3D 模型无法加载：${runtime.error}`);
        node.visualKey = '';
        this.rebuildContent(node);
      });
  }

  private disposeModel(node: ObjectNode) {
    const runtime = node.model;
    if (!runtime) return;
    node.model = null;
    if (runtime.group) disposeObject3D(runtime.group);
  }

  private buildModel(group: THREE.Group, object: ModelObject, node: ObjectNode) {
    this.ensureModel(node, object);
    const runtime = node.model;
    if (runtime && runtime.status === 'ready' && runtime.group) {
      const scale = Math.min(object.width, object.height);
      runtime.group.scale.setScalar(scale);
      runtime.group.rotation.set(0, 0, 0);
      group.add(runtime.group);
      runtime.group.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh || !mesh.material) return;
        const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of list) {
          // 内容组沿 Y 轴镜像以匹配画布坐标，模型材质需要双面渲染避免被背面剔除
          material.side = THREE.DoubleSide;
          node.materials.push(material);
        }
      });
      return;
    }
    const texture =
      runtime?.status === 'error' ? this.modelErrorTexture : this.modelLoadingTexture;
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

  /** 封面裁切：与图片的 cover 逻辑一致，视频纹理按对象独占，可直接改 repeat */
  private applyCoverCrop(texture: THREE.Texture, imageAspect: number, boxAspect: number) {
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    if (imageAspect >= boxAspect) {
      const repeatX = boxAspect / imageAspect;
      texture.repeat.set(repeatX, 1);
      texture.offset.set((1 - repeatX) / 2, 0);
    } else {
      const repeatY = imageAspect / boxAspect;
      texture.repeat.set(1, repeatY);
      texture.offset.set(0, (1 - repeatY) / 2);
    }
  }

  private ensureMedia(node: ObjectNode, object: VideoObject | AudioObject) {
    const existing = node.media;
    if (existing && existing.src === object.src && existing.kind === object.type) {
      this.applyMediaSettings(existing, object);
      return;
    }
    this.disposeMedia(node);
    const runtime: MediaRuntime = {
      kind: object.type,
      src: object.src,
      element: null,
      texture: null,
      error: false,
      ready: false,
    };
    node.media = runtime;
    if (!object.src) {
      runtime.error = true;
      return;
    }
    const handleError = () => {
      runtime.error = true;
      runtime.ready = false;
      this.callbacks.onImageError(node.objectId, object.type === 'video' ? '视频无法加载' : '音频无法加载');
      if (this.nodes.get(node.objectId) === node) {
        node.visualKey = '';
        this.rebuildContent(node);
      }
    };
    if (object.type === 'video') {
      const video = document.createElement('video');
      video.src = object.src;
      video.preload = 'auto';
      video.playsInline = true;
      video.loop = object.loop;
      video.muted = object.muted;
      video.volume = Math.max(0, Math.min(1, object.volume / 100));
      video.addEventListener('error', handleError);
      video.addEventListener('loadeddata', () => {
        runtime.ready = true;
        if (runtime.texture) runtime.texture.needsUpdate = true;
        if (this.nodes.get(node.objectId) === node) {
          node.visualKey = '';
          this.rebuildContent(node);
        }
      });
      video.addEventListener('seeked', () => {
        if (runtime.texture) runtime.texture.needsUpdate = true;
      });
      video.load();
      const texture = new THREE.VideoTexture(video);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      texture.anisotropy = this.maxAnisotropy;
      runtime.texture = texture;
      runtime.element = video;
    } else {
      const audio = new Audio();
      audio.src = object.src;
      audio.preload = 'metadata';
      audio.loop = object.loop;
      audio.volume = Math.max(0, Math.min(1, object.volume / 100));
      audio.addEventListener('error', handleError);
      audio.load();
      runtime.element = audio;
    }
  }

  private applyMediaSettings(runtime: MediaRuntime, object: SlideObject) {
    const element = runtime.element;
    if (!element) return;
    if (object.type !== 'video' && object.type !== 'audio') return;
    element.loop = object.loop;
    element.volume = Math.max(0, Math.min(1, object.volume / 100));
    if (object.type === 'video') element.muted = object.muted;
  }

  private disposeMedia(node: ObjectNode) {
    const runtime = node.media;
    if (!runtime) return;
    node.media = null;
    if (runtime.element) {
      runtime.element.pause();
      runtime.element.removeAttribute('src');
      runtime.element.load();
      runtime.element = null;
    }
    if (runtime.texture) {
      runtime.texture.dispose();
      runtime.texture = null;
    }
  }

  private buildVideo(group: THREE.Group, object: VideoObject, node: ObjectNode) {
    this.ensureMedia(node, object);
    const runtime = node.media;
    const ready = Boolean(runtime && !runtime.error && runtime.ready && runtime.texture);
    let texture: THREE.Texture = this.placeholderTexture;
    let drawWidth = object.width;
    let drawHeight = object.height;
    if (ready && runtime?.texture) {
      const source = runtime.texture;
      source.repeat.set(1, 1);
      source.offset.set(0, 0);
      source.wrapS = THREE.ClampToEdgeWrapping;
      source.wrapT = THREE.ClampToEdgeWrapping;
      const imageAspect = object.naturalWidth / object.naturalHeight || 16 / 9;
      const boxAspect = object.width / object.height || 1;
      if (object.fit === 'contain') {
        if (imageAspect >= boxAspect) {
          drawWidth = object.width;
          drawHeight = object.width / imageAspect;
        } else {
          drawHeight = object.height;
          drawWidth = object.height * imageAspect;
        }
      } else {
        this.applyCoverCrop(source, imageAspect, boxAspect);
      }
      texture = source;
    }
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(drawWidth, drawHeight), material);
    group.add(mesh);
    node.materials.push(material);
  }

  private createAudioCard(object: AudioObject, node: ObjectNode): THREE.CanvasTexture {
    const canvasWidth = 1024;
    const ratio = object.height / object.width || 0.3;
    const canvasHeight = Math.max(96, Math.min(1024, Math.round(canvasWidth * ratio)));
    const canvas = document.createElement('canvas');
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#111A24';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
    ctx.strokeStyle = 'rgba(45,212,191,.5)';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, canvasWidth - 4, canvasHeight - 4);

    const cy = canvasHeight / 2;
    const radius = Math.min(canvasHeight * 0.3, 90);
    const cx = radius + Math.min(canvasHeight * 0.14, 32);
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(45,212,191,.14)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(45,212,191,.7)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = '#2DD4BF';
    ctx.beginPath();
    ctx.moveTo(cx - radius * 0.22, cy - radius * 0.36);
    ctx.lineTo(cx + radius * 0.42, cy);
    ctx.lineTo(cx - radius * 0.22, cy + radius * 0.36);
    ctx.closePath();
    ctx.fill();

    const textLeft = cx + radius + Math.min(canvasHeight * 0.12, 26);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#F3EEE4';
    const nameSize = Math.max(18, Math.round(canvasHeight * 0.2));
    ctx.font = `500 ${nameSize}px "PingFang SC","Microsoft YaHei",sans-serif`;
    const name = object.name.length > 18 ? `${object.name.slice(0, 18)}…` : object.name;
    ctx.fillText(name, textLeft, cy - 4);
    ctx.fillStyle = 'rgba(201,210,223,.6)';
    const metaSize = Math.max(14, Math.round(canvasHeight * 0.15));
    ctx.font = `400 ${metaSize}px "PingFang SC","Microsoft YaHei",sans-serif`;
    ctx.fillText('音频素材', textLeft, cy + metaSize + 8);

    const barCount = Math.max(8, Math.floor((canvasWidth - textLeft) / (canvasHeight * 0.13)));
    const barWidth = canvasHeight * 0.055;
    const gap = canvasHeight * 0.075;
    const startX = canvasWidth - 24 - barCount * (barWidth + gap);
    const maxBar = canvasHeight * 0.34;
    for (let i = 0; i < barCount; i += 1) {
      const wave = 0.35 + 0.65 * Math.abs(Math.sin(i * 1.7 + 0.6));
      const height = maxBar * wave;
      ctx.fillStyle = `rgba(45,212,191,${0.28 + 0.32 * wave})`;
      ctx.fillRect(startX + i * (barWidth + gap), cy - height / 2, barWidth, height);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.anisotropy = this.maxAnisotropy;
    node.ownedTextures.push(texture);
    return texture;
  }

  private buildAudio(group: THREE.Group, object: AudioObject, node: ObjectNode) {
    this.ensureMedia(node, object);
    const texture = node.media?.error ? this.placeholderTexture : this.createAudioCard(object, node);
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

  getMediaState(id: string): MediaPlaybackState | null {
    const node = this.nodes.get(id);
    const runtime = node?.media;
    if (!node || !runtime) return null;
    const object = node.data;
    if (object.type !== 'video' && object.type !== 'audio') return null;
    const element = runtime.element;
    const duration = element && Number.isFinite(element.duration) && element.duration > 0
      ? element.duration
      : object.duration;
    return {
      kind: runtime.kind,
      playing: element ? !element.paused && !element.ended : false,
      time: element ? element.currentTime : 0,
      duration: Math.max(0, duration || 0),
      volume: element ? Math.round(element.volume * 100) : object.volume,
      muted: element ? element.muted : false,
      loop: object.loop,
      error: runtime.error,
    };
  }

  playMedia(id: string) {
    const element = this.nodes.get(id)?.media?.element;
    if (!element) return;
    const result = element.play();
    if (result && typeof result.catch === 'function') result.catch(() => undefined);
  }

  pauseMedia(id: string) {
    this.nodes.get(id)?.media?.element?.pause();
  }

  toggleMedia(id: string) {
    const element = this.nodes.get(id)?.media?.element;
    if (!element) return;
    if (element.paused) this.playMedia(id);
    else element.pause();
  }

  seekMedia(id: string, time: number) {
    const element = this.nodes.get(id)?.media?.element;
    if (!element) return;
    const duration = Number.isFinite(element.duration) ? element.duration : 0;
    element.currentTime = Math.max(0, duration > 0 ? Math.min(duration, time) : time);
    const texture = this.nodes.get(id)?.media?.texture;
    if (texture) texture.needsUpdate = true;
  }

  setMediaVolume(id: string, volume: number) {
    const runtime = this.nodes.get(id)?.media;
    const element = runtime?.element;
    if (!element) return;
    element.volume = Math.max(0, Math.min(1, volume / 100));
    if (element.volume > 0 && element.muted) element.muted = false;
  }

  setMediaMuted(id: string, muted: boolean) {
    const element = this.nodes.get(id)?.media?.element;
    if (element) element.muted = muted;
  }

  private pauseAllMedia() {
    for (const node of this.nodes.values()) node.media?.element?.pause();
  }

  private handleModeMedia(previousMode: StageMode, mode: StageMode) {
    if (mode !== 'present') {
      this.mediaAutoplayArmed = false;
      if (previousMode === 'present') this.pauseAllMedia();
      return;
    }
    if (this.mediaAutoplayArmed) return;
    this.mediaAutoplayArmed = true;
    for (const node of this.nodes.values()) {
      const object = node.data;
      if (!object.visible) continue;
      if ((object.type === 'video' || object.type === 'audio') && object.autoplay) {
        this.playMedia(node.objectId);
      }
    }
  }

  private removeNode(node: ObjectNode) {
    this.disposeMedia(node);
    this.disposeModel(node);
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
    const step = this.niceStep(upp * 56);
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
    const minorColor = new THREE.Color(0x34485c);
    const majorColor = new THREE.Color(0x55708a);
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
      opacity: 0.6,
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
    const dt = Math.min(0.06, Math.max(0, (now - this.lastTickAt) / 1000));
    this.lastTickAt = now;
    for (const node of this.nodes.values()) {
      const runtime = node.model;
      const object = node.data;
      if (!runtime || runtime.status !== 'ready' || !runtime.group) continue;
      if (object.type !== 'model' || !object.autoRotate) continue;
      runtime.group.rotation.y += ((object.rotateSpeed || 0) * Math.PI / 180) * dt;
    }
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

  private cornerScreens(node: ObjectNode): { corner: HandleCorner; x: number; y: number }[] {
    const object = node.data;
    node.group.updateMatrixWorld(true);
    this.camera.updateMatrixWorld();
    const corners: { corner: HandleCorner; x: number; y: number }[] = [
      { corner: 'nw', x: -object.width / 2, y: -object.height / 2 },
      { corner: 'ne', x: object.width / 2, y: -object.height / 2 },
      { corner: 'se', x: object.width / 2, y: object.height / 2 },
      { corner: 'sw', x: -object.width / 2, y: object.height / 2 },
    ];
    return corners.map((corner) => {
      const world = node.group.localToWorld(new THREE.Vector3(corner.x, corner.y, 0));
      const projected = world.clone().project(this.camera);
      return {
        corner: corner.corner,
        x: ((projected.x + 1) / 2) * this.width,
        y: ((1 - projected.y) / 2) * this.height,
      };
    });
  }

  /** 命中主选中对象的四角缩放点，返回画布坐标下的角点 */
  hitTestHandle(clientX: number, clientY: number): { id: string; corner: HandleCorner } | null {
    if (this.mode !== 'edit') return null;
    const primary = this.selectedIds[0];
    const node = primary ? this.nodes.get(primary) : null;
    if (!node) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    for (const point of this.cornerScreens(node)) {
      if (Math.hypot(point.x - px, point.y - py) <= 12) {
        return { id: node.objectId, corner: point.corner };
      }
    }
    return null;
  }

  /** 框选：返回投影包围盒与矩形相交的对象 */
  hitTestRect(left: number, top: number, width: number, height: number): string[] {
    const right = left + width;
    const bottom = top + height;
    const ids: string[] = [];
    for (const node of this.nodes.values()) {
      const projected = this.projectRect(node.objectId);
      if (!projected) continue;
      if (
        projected.left < right &&
        projected.left + projected.width > left &&
        projected.top < bottom &&
        projected.top + projected.height > top
      ) {
        ids.push(node.objectId);
      }
    }
    return ids;
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

  /** 空间漫游：以视点朝向为基准移动，保持当前朝向与距离 */
  roamStep(forward: number, right: number, up: number, dt: number) {
    if (this.mode !== 'present' || this.animation) return;
    const view = this.getView();
    const cp = Math.cos(view.pitch);
    const fx = -Math.sin(view.yaw) * cp;
    const fy = Math.sin(view.pitch);
    const fz = -Math.cos(view.yaw) * cp;
    const rx = Math.cos(view.yaw);
    const rz = -Math.sin(view.yaw);
    const speed = Math.max(view.distance * 1.25, 180);
    const distance = speed * Math.max(0, Math.min(0.1, dt));
    view.target.x += (fx * forward + rx * right) * distance;
    view.target.y += (fy * forward - up) * distance;
    view.target.z += (fz * forward + rz * right) * distance;
    this.applyView(view);
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
