import * as THREE from 'three';
import type { ModelFormat } from '../types';

export const MODEL_EXTENSIONS: Record<string, ModelFormat> = {
  glb: 'glb',
  gltf: 'gltf',
  obj: 'obj',
  fbx: 'fbx',
  stl: 'stl',
  ply: 'ply',
  dae: 'dae',
  '3mf': '3mf',
  usdz: 'usdz',
};

export const MODEL_ACCEPT = '.glb,.gltf,.obj,.fbx,.stl,.ply,.dae,.3mf,.usdz';

export function modelFormatOf(name: string): ModelFormat | null {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return MODEL_EXTENSIONS[ext] ?? null;
}

export function isModelFile(file: File): boolean {
  return modelFormatOf(file.name) !== null;
}

function dataUrlToBuffer(src: string): ArrayBuffer {
  const comma = src.indexOf(',');
  if (comma < 0) return new ArrayBuffer(0);
  const head = src.slice(0, comma);
  const data = src.slice(comma + 1);
  if (!head.includes('base64')) {
    const bytes = new TextEncoder().encode(decodeURIComponent(data));
    return bytes.buffer as ArrayBuffer;
  }
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function geometryToMesh(geometry: THREE.BufferGeometry, color: number): THREE.Mesh {
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({
    color,
    metalness: 0.15,
    roughness: 0.55,
    side: THREE.DoubleSide,
  });
  return new THREE.Mesh(geometry, material);
}

interface ParsedModel {
  object: THREE.Object3D;
  animations: THREE.AnimationClip[];
}

function parseWithLoader(format: ModelFormat, src: string, name: string): Promise<ParsedModel> {
  const buffer = dataUrlToBuffer(src);
  return new Promise((resolve, reject) => {
    const fail = (error: unknown) => reject(error instanceof Error ? error : new Error(`无法解析 ${name}`));
    switch (format) {
      case 'glb':
      case 'gltf': {
        void import('three/examples/jsm/loaders/GLTFLoader.js')
          .then(({ GLTFLoader }) => {
            const loader = new GLTFLoader();
            const payload = format === 'glb' ? buffer : new TextDecoder().decode(buffer);
            loader.parse(
              payload,
              '',
              (gltf) => resolve({ object: gltf.scene, animations: gltf.animations ?? [] }),
              fail,
            );
          })
          .catch(fail);
        return;
      }
      case 'obj': {
        void import('three/examples/jsm/loaders/OBJLoader.js')
          .then(({ OBJLoader }) => {
            const group = new OBJLoader().parse(new TextDecoder().decode(buffer));
            resolve({ object: group, animations: [] });
          })
          .catch(fail);
        return;
      }
      case 'fbx': {
        void import('three/examples/jsm/loaders/FBXLoader.js')
          .then(({ FBXLoader }) => {
            const group = new FBXLoader().parse(buffer, '');
            resolve({ object: group, animations: group.animations ?? [] });
          })
          .catch(fail);
        return;
      }
      case 'stl': {
        void import('three/examples/jsm/loaders/STLLoader.js')
          .then(({ STLLoader }) =>
            resolve({ object: geometryToMesh(new STLLoader().parse(buffer), 0xc7d2de), animations: [] }),
          )
          .catch(fail);
        return;
      }
      case 'ply': {
        void import('three/examples/jsm/loaders/PLYLoader.js')
          .then(({ PLYLoader }) =>
            resolve({ object: geometryToMesh(new PLYLoader().parse(buffer), 0xc7d2de), animations: [] }),
          )
          .catch(fail);
        return;
      }
      case 'dae': {
        void import('three/examples/jsm/loaders/ColladaLoader.js')
          .then(({ ColladaLoader }) => {
            const result = new ColladaLoader().parse(new TextDecoder().decode(buffer), '');
            resolve({
              object: result.scene,
              animations: (result as unknown as { animations?: THREE.AnimationClip[] }).animations ?? [],
            });
          })
          .catch(fail);
        return;
      }
      case '3mf': {
        void import('three/examples/jsm/loaders/3MFLoader.js')
          .then(({ ThreeMFLoader }) =>
            resolve({ object: new ThreeMFLoader().parse(buffer), animations: [] }),
          )
          .catch(fail);
        return;
      }
      case 'usdz': {
        void import('three/examples/jsm/loaders/USDZLoader.js')
          .then(({ USDZLoader }) =>
            resolve({
              object: new USDZLoader().parse(buffer) as unknown as THREE.Group,
              animations: [],
            }),
          )
          .catch(fail);
        return;
      }
      default:
        reject(new Error('暂不支持该模型格式'));
    }
  });
}

export interface LoadedModel {
  /** 已归一化：居中、最大边长为 1 的场景组 */
  group: THREE.Group;
  /** 归一化后的尺寸 */
  size: THREE.Vector3;
  /** 模型自带的动画片段（FBX / GLTF / Collada） */
  animations: THREE.AnimationClip[];
}

export async function loadModelGroup(src: string, format: ModelFormat, name: string): Promise<LoadedModel> {
  const parsed = await parseWithLoader(format, src, name);
  const object = parsed.object;
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) throw new Error('模型中没有可显示的网格');
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  const maxDimension = Math.max(size.x, size.y, size.z) || 1;
  const inner = new THREE.Group();
  inner.scale.setScalar(1 / maxDimension);
  inner.position.set(-center.x / maxDimension, -center.y / maxDimension, -center.z / maxDimension);
  inner.add(object);
  const group = new THREE.Group();
  group.add(inner);
  size.multiplyScalar(1 / maxDimension);
  return { group, size, animations: parsed.animations };
}

export function disposeObject3D(root: THREE.Object3D) {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) {
      for (const item of material) disposeMaterial(item);
    } else if (material) {
      disposeMaterial(material);
    }
  });
}

function disposeMaterial(material: THREE.Material) {
  const mat = material as THREE.MeshStandardMaterial;
  if (mat.map) mat.map.dispose();
  material.dispose();
}
