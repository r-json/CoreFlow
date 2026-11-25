import type { SVGProps } from 'react';

/** Small stroke icons drawn for the Workbench. Decorative unless given a title. */
const PATHS = {
  overview: 'M4 11l8-7 8 7v9H4z M10 20v-6h4v6',
  compose: 'M5 19h14 M7 15l9-9 3 3-9 9H7z',
  verify: 'M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z M8.5 12l2.5 2.5 4.5-5',
  inspect: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14z M16.5 16.5L21 21',
  vectors: 'M9 6h11 M9 12h11 M9 18h11 M4 6l1 1 2-2 M4 12l1 1 2-2 M4 18l1 1 2-2',
  errors: 'M12 3l9 17H3z M12 10v4 M12 17h.01',
  evidence: 'M4 5h16v4H4z M5 9v10h14V9 M10 13h4',
  copy: 'M9 9h11v11H9z M5 15H4V4h11v1',
  check: 'M5 12.5l4.5 4.5L19 7',
  cross: 'M6 6l12 12 M18 6L6 18',
  dash: 'M6 12h12',
  lock: 'M6 11h12v9H6z M8 11V8a4 4 0 0 1 8 0v3',
  external: 'M14 4h6v6 M20 4l-9 9 M18 14v6H4V6h6',
  menu: 'M4 7h16 M4 12h16 M4 17h16',
  download: 'M12 4v11 M7 10l5 5 5-5 M5 20h14',
  chain: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, title, ...rest }: { name: IconName; title?: string } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      <path d={PATHS[name]} />
    </svg>
  );
}
