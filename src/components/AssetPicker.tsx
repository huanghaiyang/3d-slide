/**
 * AssetPicker.tsx —— 「从资源库插入」弹窗
 *
 * 组件职责：
 * - 在编辑器内以模态框形式复用 AssetsPage 中的 AssetBrowser，
 *   让用户不必离开当前作品即可挑选图片、视频、音频、模型等资源；
 * - 根据调用方传入的 kinds 过滤可选的资源类型；
 * - 选中资源后回调 onPick(asset, src) 并自动关闭弹窗；
 * - 底部提供「管理资源库」入口，在新标签页打开完整的资源库页面。
 *
 * 主要交互：
 * - 弹窗关闭：右上角关闭、遮罩点击、Esc、底部取消按钮，均由 Modal 统一处理；
 * - 选择：AssetBrowser 的 pick 模式会把资源元数据与可直接使用的 src 一并返回。
 *
 * 与其他模块的关系：
 * - AssetBrowser 与资源类型来自 AssetsPage / lib/assets；
 * - 外层 Modal 来自通用 UI 组件 ui.tsx；
 * - 插入后如何创建对象由调用方（Editor）决定，本组件只负责选择。
 */

import type { AssetKind, AssetMeta } from '../lib/assets';
import { Icon } from './Icon';
import { AssetBrowser } from './AssetsPage';
import { Modal } from './ui';

interface AssetPickerProps {
  /** 弹窗标题，默认「从资源库插入」。 */
  title?: string;
  /** 可选资源类型过滤；不传表示不限制。 */
  kinds?: AssetKind[];
  /** 选中资源：asset 为元数据，src 为可直接用于对象素材的地址。 */
  onPick: (asset: AssetMeta, src: string) => void;
  /** 关闭弹窗。 */
  onClose: () => void;
}

/**
 * 在新标签页打开资源库页面。
 * 用当前地址去掉 hash 后重新拼上 #/assets，避免把编辑器路由一起带过去；
 * noopener 防止新页面通过 window.opener 反向操作当前页。
 */
function openLibrary() {
  const base = window.location.href.split('#')[0];
  window.open(`${base}#/assets`, '_blank', 'noopener');
}

/**
 * 资源选择弹窗。
 * 宽度随视口自适应，并限制在 360 ~ 980 之间，避免小屏溢出、大屏过宽。
 */
export function AssetPicker({ title = '从资源库插入', kinds, onPick, onClose }: AssetPickerProps) {
  return (
    <Modal
      title={title}
      eyebrow="LIBRARY"
      width={Math.min(980, Math.max(360, window.innerWidth - 48))}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={openLibrary}>
            <Icon name="folder" size={15} />
            管理资源库
          </button>
          <button className="btn btn-light" onClick={onClose}>
            取消
          </button>
        </>
      }
    >
      <div className="asset-picker">
        {/* mode="pick"：AssetBrowser 以「选择」而非「管理」形态渲染，隐藏上传 / 删除等操作 */}
        <AssetBrowser
          mode="pick"
          kinds={kinds}
          // 先交给调用方处理资源，再关闭弹窗，保证父组件拿到的仍是有效选择
          onPick={(asset, src) => {
            onPick(asset, src);
            onClose();
          }}
        />
      </div>
    </Modal>
  );
}
