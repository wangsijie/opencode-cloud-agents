/**
 * The icon set, inline.
 *
 * A handful of glyphs does not justify a dependency, and inline SVG inherits
 * `currentColor`, so an icon in a button is coloured by the button.
 */
function Icon({ children, size = 18 }: { children: React.ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function PlusIcon() {
  return (
    <Icon>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function ArrowUpIcon() {
  return (
    <Icon>
      <path d="M12 19V5M5 12l7-7 7 7" />
    </Icon>
  );
}

export function StopIcon() {
  return (
    <Icon>
      <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />
    </Icon>
  );
}

export function MenuIcon() {
  return (
    <Icon>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </Icon>
  );
}

export function DotsIcon() {
  return (
    <Icon size={16}>
      <circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function RefreshIcon() {
  return (
    <Icon>
      <path d="M21 12a9 9 0 1 1-2.64-6.36M21 4v5h-5" />
    </Icon>
  );
}

export function UnifiedDiffIcon() {
  return (
    <Icon>
      <path d="M4 5h16M4 9h16M4 15h16M4 19h16" />
    </Icon>
  );
}

export function SplitDiffIcon() {
  return (
    <Icon>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M12 4v16M6 8h3M6 12h3M15 8h3M15 12h3" />
    </Icon>
  );
}

export function SettingsIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="3" />
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.09a2 2 0 0 1 1 1.74v.5a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
    </Icon>
  );
}

export function SignOutIcon() {
  return (
    <Icon>
      <path d="M10 17l5-5-5-5M15 12H3" />
      <path d="M15 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" />
    </Icon>
  );
}

export function DownloadIcon() {
  return (
    <Icon size={16}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5 5 5-5M12 15V3" />
    </Icon>
  );
}

export function ChevronDownIcon() {
  return (
    <Icon size={16}>
      <path d="m6 9 6 6 6-6" />
    </Icon>
  );
}

export function ChevronRightIcon() {
  return (
    <Icon size={16}>
      <path d="m9 6 6 6-6 6" />
    </Icon>
  );
}

export function SearchIcon() {
  return (
    <Icon size={16}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </Icon>
  );
}

export function CheckIcon() {
  return (
    <Icon size={16}>
      <path d="m5 13 4 4L19 7" />
    </Icon>
  );
}

/** Two stacked sheets: the copy glyph everywhere else in the app's world. */
export function CopyIcon() {
  return (
    <Icon size={16}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h8" />
    </Icon>
  );
}

/** Opens and closes the details panel: a page with a pane down its right side. */
export function PanelIcon() {
  return (
    <Icon>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </Icon>
  );
}

export function CloseIcon() {
  return (
    <Icon size={16}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Icon>
  );
}

/** The mark on the new-session page: a four-point spark, drawn filled. */
export function SparkIcon() {
  return (
    <svg
      className="spark"
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 1.5c.4 4.6 2.2 6.9 6.8 8.2v.1c-4.6 1.3-6.4 3.6-6.8 8.2h-.1c-.4-4.6-2.2-6.9-6.8-8.2v-.1c4.6-1.3 6.4-3.6 6.8-8.2Z" />
      <path d="M19.2 15.4c.2 2.3 1.1 3.4 3.4 4.1v.1c-2.3.6-3.2 1.8-3.4 4.1h-.1c-.2-2.3-1.1-3.4-3.4-4.1v-.1c2.3-.7 3.2-1.8 3.4-4.1Z" />
    </svg>
  );
}
