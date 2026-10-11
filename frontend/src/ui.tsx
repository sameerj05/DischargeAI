import { type ReactNode } from "react"

export type IconName =
  | "activity"
  | "bell"
  | "calendar"
  | "check"
  | "chevron"
  | "clock"
  | "document"
  | "download"
  | "microphone"
  | "patients"
  | "pdf"
  | "search"
  | "send"
  | "stethoscope"
  | "stop"
  | "upload"
  | "lock"
  | "logout"
  | "pill"
  | "warning"
  | "globe"
  | "textSize"
  | "speaker"
  | "speakerOff"

const iconPaths: Record<IconName, ReactNode> = {
  activity: <path d="M3 12h4l3 8 4-16 3 8h4" />,
  bell: (
    <>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
      <path d="M10 21h4" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="4" width="18" height="17" rx="3" />
      <path d="M3 9h18M8 2v4M16 2v4" />
    </>
  ),
  check: <path d="m5 12 4.5 4.5L19 7" />,
  chevron: <path d="m9 18 6-6-6-6" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  document: (
    <>
      <path d="M6 3h9l3 3v15H6z" />
      <path d="M9 9h6M9 13h6M9 17h4" />
    </>
  ),
  microphone: (
    <>
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" />
    </>
  ),
  patients: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20c0-4 2-7 6-7s6 3 6 7M16 5a3 3 0 0 1 0 6M17 14c2.5.6 4 2.6 4 6" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </>
  ),
  send: (
    <>
      <path d="m21 3-7.2 18-3.9-7.9L2 9.2 21 3Z" />
      <path d="m9.9 13.1 4.4-4.4" />
    </>
  ),
  stethoscope: (
    <>
      <path d="M5 3v6a5 5 0 0 0 10 0V3M5 3H3M15 3h2M10 14v2a5 5 0 0 0 5 5 4 4 0 0 0 4-4v-1" />
      <circle cx="19" cy="12" r="2" />
    </>
  ),
  stop: <rect x="7" y="7" width="10" height="10" rx="2" />,
  pdf: (
    <>
      <path d="M6 3h9l3 3v15H6z" />
      <path d="M9 13h2c1 0 2-.9 2-2s-1-2-2-2H9v6M15 9h2M15 12h2" />
    </>
  ),
  upload: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" x2="12" y1="3" y2="15" />
    </>
  ),
  download: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" x2="12" y1="3" y2="15" />
    </>
  ),
  lock: (
    <>
      <rect x="4" y="10" width="16" height="11" rx="2.5" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>
  ),
  logout: (
    <>
      <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
      <path d="M10 17l-5-5 5-5M5 12h11" />
    </>
  ),
  pill: (
    <>
      <rect x="3" y="8" width="18" height="8" rx="4" transform="rotate(45 12 12)" />
      <path d="M8.5 8.5 15.5 15.5" />
    </>
  ),
  warning: (
    <>
      <path d="M12 3 2 20h20L12 3Z" />
      <path d="M12 10v5M12 18h.01" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" />
    </>
  ),
  textSize: (
    // Two "A" glyphs of different sizes — a conventional text-size affordance.
    <>
      <path d="M3 18 7 7l4 11M4.2 14.5h5.6" />
      <path d="M13.5 18 17 9l3.5 9M14.3 15.3h5.4" />
    </>
  ),
  speaker: (
    <>
      <path d="M11 5 6 9H3a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h3l5 4V5Z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" />
    </>
  ),
  speakerOff: (
    <>
      <path d="M11 5 6 9H3a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h3l5 4V5Z" />
      <path d="M23 9l-6 6M17 9l6 6" />
    </>
  ),
}

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
    >
      <g
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      >
        {iconPaths[name]}
      </g>
    </svg>
  )
}

export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 32 32"
      width={size}
    >
      <g
        stroke="var(--brand-mark-stroke)"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path
          d="M12.5 6h7v6.5H26v7h-6.5V26h-7v-6.5H6v-7h6.5z"
          strokeWidth="2.1"
        />
        <path
          d="M16 5c-3.4 2.6-3.4 6 0 8.5s3.4 5.9 0 8.5-3.4 6 0 8.5"
          strokeWidth="1.9"
          stroke="var(--brand-mark-curve)"
        />
      </g>
    </svg>
  )
}
