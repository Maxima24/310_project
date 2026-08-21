/**
 * Icon set.
 *
 * Hand-drawn inline SVG rather than an icon package: this is a dozen glyphs, and a
 * dependency would ship hundreds. Every icon is a 24-grid, 1.6 stroke, `currentColor`,
 * so they inherit text colour and work in both themes without variants.
 */

export type IconName =
  | 'shield'
  | 'home'
  | 'camera'
  | 'door'
  | 'motion'
  | 'alert'
  | 'bell'
  | 'search'
  | 'refresh'
  | 'chart'
  | 'settings'
  | 'check'
  | 'play'
  | 'lock'
  | 'signal'
  | 'clip'
  | 'chevron'
  | 'logout'
  | 'dots'
  | 'clock'
  | 'plus'
  | 'trash'
  | 'history';

const PATHS: Record<IconName, JSX.Element> = {
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5.2l3.4 2" />
    </>
  ),
  plus: <path d="M12 5.5v13M5.5 12h13" />,
  trash: (
    <>
      <path d="M4.5 7h15M9.5 7V4.8h5V7M6.5 7l.9 12.2a1 1 0 001 .8h7.2a1 1 0 001-.8L17.5 7" />
      <path d="M10.5 11v5.5M13.5 11v5.5" />
    </>
  ),
  // A clock with the hand running backwards — the audit trail is history, not the time.
  history: (
    <>
      <path d="M4.2 12a7.8 7.8 0 103-6.2" />
      <path d="M4 4.6V9h4.4" />
      <path d="M12 8v4.3l3 1.8" />
    </>
  ),
  shield: <path d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6l7-3z" />,
  home: <path d="M4 10.5L12 4l8 6.5V19a1 1 0 01-1 1h-4v-6H9v6H5a1 1 0 01-1-1v-8.5z" />,
  camera: (
    <>
      <rect x="3" y="7" width="13" height="11" rx="2" />
      <path d="M16 11l5-3v9l-5-3" />
    </>
  ),
  door: (
    <>
      <path d="M6 3h10a1 1 0 011 1v17H6a1 1 0 01-1-1V4a1 1 0 011-1z" />
      <circle cx="13.5" cy="12" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  motion: (
    <>
      <circle cx="12" cy="12" r="2.5" />
      <path d="M7.5 7.5a6.5 6.5 0 000 9M16.5 16.5a6.5 6.5 0 000-9" />
      <path d="M4.5 4.5a10.5 10.5 0 000 15M19.5 19.5a10.5 10.5 0 000-15" opacity="0.45" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4l9 16H3l9-16z" />
      <path d="M12 10v4" />
      <circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none" />
    </>
  ),
  bell: (
    <>
      <path d="M18 15V10a6 6 0 10-12 0v5l-1.5 3h15L18 15z" />
      <path d="M10 20a2 2 0 004 0" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4 4" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 12a8 8 0 11-2.6-5.9" />
      <path d="M20 4v4h-4" />
    </>
  ),
  chart: (
    <>
      <path d="M4 20V4" />
      <path d="M4 20h16" />
      <path d="M8 16v-4M12.5 16V8M17 16v-6" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v2.2M12 19.3v2.2M21.5 12h-2.2M4.7 12H2.5M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6M18.7 18.7l-1.6-1.6M6.9 6.9L5.3 5.3" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  play: <path d="M8 5.5l11 6.5-11 6.5v-13z" fill="currentColor" stroke="none" />,
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path d="M8.5 10.5V7.5a3.5 3.5 0 017 0v3" />
    </>
  ),
  signal: (
    <>
      <path d="M12 20v-6" />
      <path d="M8.5 16.5a5 5 0 017 0" />
      <path d="M5.5 13.5a9 9 0 0113 0" />
    </>
  ),
  clip: <path d="M9 7v9a3.5 3.5 0 007 0V6.5a2.25 2.25 0 10-4.5 0V15a1 1 0 002 0V7.5" />,
  chevron: <path d="M8 10l4 4 4-4" />,
  logout: (
    <>
      <path d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3" />
      <path d="M10 16l-4-4 4-4M6 12h10" />
    </>
  ),
  dots: (
    <>
      <circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
};

export function Icon({
  name,
  size = 18,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
