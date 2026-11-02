/**
 * model3d.ts —— 3D 模型文件的识别、加载与归一化
 *
 * 支持 glb / gltf / obj / fbx / stl / ply / dae / 3mf / usdz 九种格式。
 * 所有格式都通过 data URL 存储，加载时先还原成 ArrayBuffer 或文本，再交给
 * Three.js 对应的 Loader 解析。
 *
 * 关键设计：
 * - Loader 全部使用动态 import，避免把体积庞大的解析器打进首屏主包；
 * - 解析后统一做归一化：把模型包围盒中心移到原点、最大边长缩放为 1，
 *   使不同来源的模型在舞台上都具有相近的初始视觉尺寸；
 * - 提供 disposeObject3D 递归释放几何体、材质与贴图，防止切换 / 删除模型时
 *   GPU 显存泄漏。
 */

import * as THREE from 'three';
import type { ModelFormat } from '../types';

/** 扩展名到模型格式的映射；键统一为小写且不带点。 */
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

/** 文件选择框的 accept 属性值，与 MODEL_EXTENSIONS 保持一致。 */
export const MODEL_ACCEPT = '.glb,.gltf,.obj,.fbx,.stl,.ply,.dae,.3mf,.usdz';

/**
 * 根据文件名推断模型格式。
 *
 * 取最后一个扩展名并转小写后查表；不在支持列表内时返回 null。
 *
 * @param name 文件名或路径
 * @returns 对应的模型格式，或 null
 */
export function modelFormatOf(name: string): ModelFormat | null {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return MODEL_EXTENSIONS[ext] ?? null;
}

/**
 * 判断文件是否为受支持的 3D 模型（仅按扩展名）。
 *
 * @param file 待检查的文件
 * @returns 扩展名在支持列表内时为 true
 */
export function isModelFile(file: File): boolean {
  return modelFormatOf(file.name) !== null;
}

/**
 * 把 data URL 还原为 ArrayBuffer，供二进制格式的 Loader 使用。
 *
 * 处理两种编码：
 * - base64（常见于 glb / fbx / 3mf 等二进制文件）：atob 解码后逐字节写入 Uint8Array；
 * - 百分号编码的文本（如 gltf / obj / dae）：decodeURIComponent 后用 TextEncoder 编码。
 * 缺少逗号（不是合法 data URL）时返回空 ArrayBuffer，由后续 Loader 报错。
 *
 * @param src data URL
 * @returns 原始二进制内容
 */
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
  // atob 返回的是按字符编码的字符串，需要逐字节搬运到 Uint8Array 才是真正的二进制
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * 把仅有几何体的格式（STL / PLY）包装成可直接渲染的 Mesh。
 *
 * 这类格式通常不带法线与材质：缺失法线时自动计算，材质使用中性灰色标准材质，
 * 双面渲染以避免模型内外翻转时出现黑洞。
 *
 * @param geometry 已解析的 BufferGeometry
 * @param color    材质基础色（十六进制数值）
 * @returns 可直接加入场景的 Mesh
 */
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

/**
 * 各 Loader 解析后的统一中间结果。
 * object 为场景根节点；animations 为模型自带的动画片段（可能为空数组）。
 */
interface ParsedModel {
  object: THREE.Object3D;
  animations: THREE.AnimationClip[];
}

/**
 * 按格式选择对应的 Three.js Loader 并解析模型。
 *
 * 所有 Loader 模块都通过动态 import 加载，且各自使用 .then(...).catch(fail)
 * 串联，保持 Promise 只结算一次。glb 直接传 ArrayBuffer；gltf / obj / dae 为
 * 文本格式，先解码为字符串；其余二进制格式直接传 buffer。
 * 每种分支都显式 return，避免 switch 落空后重复结算 Promise。
 *
 * @param format 模型格式
 * @param src    data URL
 * @param name   文件名，仅用于错误提示
 * @returns 解析后的场景对象与动画片段
 * @throws 不支持的格式或 Loader 解析失败时 reject
 */
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

/**
 * 加载完成并归一化后的模型数据。
 * group 内的模型已居中、最大边长为 1，可直接按对象宽高缩放使用。
 */
export interface LoadedModel {
  /** 已归一化：居中、最大边长为 1 的场景组 */
  group: THREE.Group;
  /** 归一化后的尺寸 */
  size: THREE.Vector3;
  /** 模型自带的动画片段（FBX / GLTF / Collada） */
  animations: THREE.AnimationClip[];
}

/**
 * 加载模型并做统一归一化。
 *
 * 步骤：
 * 1. 解析得到原始场景对象；
 * 2. 强制更新世界矩阵后计算整体包围盒（否则子节点的位置 / 缩放尚未生效）；
 * 3. 取最大边长 maxDimension，用内层 Group 将其缩放为 1，并把包围盒中心平移到原点；
 * 4. 外层 Group 作为稳定入口返回，避免调用方直接依赖内层变换。
 *
 * 包围盒为空说明模型没有可见网格，抛出错误由调用方提示。
 *
 * @param src    data URL
 * @param format 模型格式
 * @param name   文件名，用于错误提示
 * @returns 归一化后的 group、尺寸与动画
 * @throws 模型无可见网格或解析失败时抛出错误
 */
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
  // 归一化：内层组同时承担缩放与位移，使包围盒中心落在原点、最长边恰好为 1
  const inner = new THREE.Group();
  inner.scale.setScalar(1 / maxDimension);
  inner.position.set(-center.x / maxDimension, -center.y / maxDimension, -center.z / maxDimension);
  inner.add(object);
  const group = new THREE.Group();
  group.add(inner);
  size.multiplyScalar(1 / maxDimension);
  return { group, size, animations: parsed.animations };
}

/**
 * 递归释放 Object3D 树占用的 GPU 资源。
 *
 * 遍历所有子节点，对 Mesh 的 geometry 以及材质（可能是数组）调用 dispose，
 * 同时释放材质上的贴图。删除模型对象或销毁场景时调用，避免显存持续增长。
 * 注意：只释放资源，不负责从父节点移除对象。
 *
 * @param root 待释放的对象树根节点
 */
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

/**
 * 释放单个材质的贴图与材质本身。
 *
 * 仅处理常见的 map（漫反射 / 基础色贴图）；法线、粗糙度等其他贴图目前未单独
 * 释放，若模型使用这些贴图，需要在调用方补充释放逻辑。
 *
 * @param material 待释放的材质
 */
function disposeMaterial(material: THREE.Material) {
  const mat = material as THREE.MeshStandardMaterial;
  if (mat.map) mat.map.dispose();
  material.dispose();
}
