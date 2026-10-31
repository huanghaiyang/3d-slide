import type { SVGProps, ReactNode } from 'react';

export type IconName =
  | 'plus'
  | 'undo'
  | 'redo'
  | 'play'
  | 'download'
  | 'upload'
  | 'back'
  | 'eye'
  | 'eyeOff'
  | 'trash'
  | 'close'
  | 'text'
  | 'image'
  | 'shape'
  | 'reset'
  | 'focus'
  | 'grid'
  | 'chevron'
  | 'edit'
  | 'lock'
  | 'alert'
  | 'more'
  | 'spark'
  | 'check'
  | 'video'
  | 'audio'
  | 'pause'
  | 'volume'
  | 'volumeOff'
  | 'model'
  | 'folder'
  | 'restore';

interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
  size?: number;
}

const paths: Record<IconName, ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />,
  undo: <path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12H9" />,
  redo: <path d="m15 14 5-5-5-5m5 5H10a6 6 0 0 0 0 12h5" />,
  play: <path d="M7 4.5v15l13-7.5z" />,
  download: <path d="M12 3v12m0 0 5-5m-5 5-5-5M4 20h16" />,
  upload: <path d="M12 21V9m0 0 5 5m-5-5-5 5M4 4h16" />,
  back: <path d="M20 12H4m0 0 7-7m-7 7 7 7" />,
  eye: (
    <>
      <path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M4 4l16 16M9.9 5.8A9.9 9.9 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3.2 3.9M6 7a17 17 0 0 0-3.5 5S6 18.5 12 18.5c1 0 2-.2 2.8-.5" />
      <path d="M9.8 9.8a3 3 0 0 0 4.4 4.4" />
    </>
  ),
  trash: <path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5" />,
  close: <path d="M5 5l14 14M19 5 5 19" />,
  text: <path d="M5 5h14M12 5v14M8 19h8" />,
  image: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m4.5 17 5-4.5 3.5 3 2.6-2.3 4 3.8" />
    </>
  ),
  shape: (
    <>
      <rect x="3.5" y="8.5" width="10" height="10" rx="1.5" />
      <circle cx="16.5" cy="9" r="5" />
    </>
  ),
  reset: (
    <>
      <path d="M4 9a8.5 8.5 0 1 1 2.1 8.2" />
      <path d="M4 4v5h5" />
    </>
  ),
  focus: (
    <>
      <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  grid: <path d="M4 4h16v16H4zM4 9.3h16M4 14.6h16M9.3 4v16M14.6 4v16" />,
  chevron: <path d="m8 5 7 7-7 7" />,
  edit: <path d="M4 20h4L20 8l-4-4L4 16v4ZM14 6l4 4" />,
  lock: (
    <>
      <rect x="4.5" y="10" width="15" height="10.5" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>
  ),
  alert: (
    <>
      <path d="M12 3 2.8 20h18.4z" />
      <path d="M12 9v5m0 3v.2" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  spark: <path d="M12 3v4m0 10v4M3 12h4m10 0h4M6 6l2.6 2.6M15.4 15.4 18 18M18 6l-2.6 2.6M8.6 15.4 6 18" />,
  check: <path d="m4 12 5 5L20 6" />,
  video: (
    <>
      <rect x="3" y="5.5" width="13" height="13" rx="2" />
      <path d="m16 10.5 4.5-2.6v8.2L16 13.5z" />
    </>
  ),
  audio: (
    <>
      <path d="M4 10v4h3l4.5 3.5v-11L7 10z" />
      <path d="M15 9a4.2 4.2 0 0 1 0 6M17.6 6.8a7.4 7.4 0 0 1 0 10.4" />
    </>
  ),
  pause: <path d="M9 5v14M15 5v14" strokeWidth="2.4" />,
  volume: (
    <>
      <path d="M4 10v4h3l4.5 3.5v-11L7 10z" />
      <path d="M15 9.5a4 4 0 0 1 0 5" />
    </>
  ),
  volumeOff: (
    <>
      <path d="M4 10v4h3l4.5 3.5v-11L7 10z" />
      <path d="m15 9.5 4 5m0-5-4 5" />
    </>
  ),
  model: (
    <>
      <path d="M12 3.2 20 7.6v8.8L12 20.8 4 16.4V7.6z" />
      <path d="M4 7.6l8 4.4 8-4.4M12 12v8.8" />
    </>
  ),
  folder: <path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4l2 2.5h8A1.5 1.5 0 0 1 20.5 9v8A1.5 1.5 0 0 1 19 18.5H5A1.5 1.5 0 0 1 3.5 17z" />,
  restore: (
    <>
      <path d="M4 9a8.5 8.5 0 1 1 2.1 8.2" />
      <path d="M4 4v5h5" />
      <path d="M12 8.5v4l2.5 1.5" />
    </>
  ),
};

export function Icon({ name, size = 18, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {paths[name]}
    </svg>
  );
}
