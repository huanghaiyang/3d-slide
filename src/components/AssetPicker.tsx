import type { AssetKind, AssetMeta } from '../lib/assets';
import { Icon } from './Icon';
import { AssetBrowser } from './AssetsPage';
import { Modal } from './ui';

interface AssetPickerProps {
  title?: string;
  kinds?: AssetKind[];
  onPick: (asset: AssetMeta, src: string) => void;
  onClose: () => void;
}

function openLibrary() {
  const base = window.location.href.split('#')[0];
  window.open(`${base}#/assets`, '_blank', 'noopener');
}

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
        <AssetBrowser
          mode="pick"
          kinds={kinds}
          onPick={(asset, src) => {
            onPick(asset, src);
            onClose();
          }}
        />
      </div>
    </Modal>
  );
}
