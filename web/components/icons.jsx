const base = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
};

export function IconCamera({ className }) {
  return (
    <svg className={className} {...base}>
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}

// Aperture / shutter blades — the "develop" hero mark.
export function IconAperture({ className }) {
  return (
    <svg className={className} {...base}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3v6M21 8l-5.2 3M19 18l-3.8-4.6M5 18l3.8-4.6M3 8l5.2 3" />
    </svg>
  );
}

export function IconMoon({ className }) {
  return (
    <svg className={className} {...base}>
      <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />
    </svg>
  );
}

export function IconLogout({ className }) {
  return (
    <svg className={className} {...base}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

export function IconClose({ className }) {
  return (
    <svg className={className} {...base} strokeWidth={1.7}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export function IconExpand({ className }) {
  return (
    <svg className={className} {...base}>
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

export function IconPlus({ className }) {
  return (
    <svg className={className} {...base} strokeWidth={1.7}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function IconMinus({ className }) {
  return (
    <svg className={className} {...base} strokeWidth={1.7}>
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

// Broadcast / radio waves — the "live" mark.
export function IconLive({ className }) {
  return (
    <svg className={className} {...base}>
      <circle cx="12" cy="12" r="2" />
      <path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14" />
    </svg>
  );
}

export function IconMouse({ className }) {
  return (
    <svg className={className} {...base}>
      <rect x="6" y="3" width="12" height="18" rx="6" />
      <line x1="12" y1="7" x2="12" y2="11" />
    </svg>
  );
}

export function IconKeyboard({ className }) {
  return (
    <svg className={className} {...base}>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h0M10 10h0M14 10h0M18 10h0M8 14h8" />
    </svg>
  );
}

// Terminal prompt — the "command" mark.
export function IconCommand({ className }) {
  return (
    <svg className={className} {...base}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3M13 15h4" />
    </svg>
  );
}

export function IconRefresh({ className }) {
  return (
    <svg className={className} {...base}>
      <polyline points="1 4 1 10 7 10" />
      <polyline points="23 20 23 14 17 14" />
      <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10M23 14l-4.64 4.36A9 9 0 0 1 3.51 15" />
    </svg>
  );
}

// Two figures — the "sessions / connected devices" mark (owner only).
export function IconUsers({ className }) {
  return (
    <svg className={className} {...base}>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

export function IconLock({ className }) {
  return (
    <svg className={className} {...base}>
      <rect x="5" y="10" width="14" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

export function IconMonitor({ className }) {
  return (
    <svg className={className} {...base}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}

export function IconChevronLeft({ className }) {
  return (
    <svg className={className} {...base} strokeWidth={1.7}>
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

export function IconChevronUp({ className }) {
  return (
    <svg className={className} {...base} strokeWidth={1.7}>
      <polyline points="18 15 12 9 6 15" />
    </svg>
  );
}

export function IconChevronDown({ className }) {
  return (
    <svg className={className} {...base} strokeWidth={1.7}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}
