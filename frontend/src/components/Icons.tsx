/**
 * Icons.
 *
 * Drawn rather than installed, for two reasons. An icon package is another few
 * hundred kilobytes for about twenty shapes, and none of the usual sets look
 * like bench tools: they look like a phone app. These are 1.5px strokes with
 * square ends on a 20 unit grid, which reads as something machined.
 */

type Props = {
  size?: number;
  className?: string;
};

function Svg({
  size = 18,
  className,
  children,
}: Props & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {children}
    </svg>
  );
}

/* -- tools -------------------------------------------------------------- */

export const IconPages = (p: Props) => (
  <Svg {...p}>
    <rect x="3" y="2.5" width="9" height="12" />
    <path d="M14.5 5.5v9a2 2 0 0 1-2 2H6" />
  </Svg>
);

export const IconMerge = (p: Props) => (
  <Svg {...p}>
    <rect x="2.5" y="3" width="7" height="6" />
    <rect x="2.5" y="11" width="7" height="6" />
    <path d="M9.5 6h4a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-4" />
    <path d="M13 8l2.5 2L13 12" />
  </Svg>
);

export const IconSplit = (p: Props) => (
  <Svg {...p}>
    <rect x="2.5" y="2.5" width="15" height="6" />
    <rect x="2.5" y="11.5" width="15" height="6" />
    <path d="M1 10h3M7 10h2.5M13 10h2.5M18.5 10H20" strokeDasharray="0" />
  </Svg>
);

export const IconStamp = (p: Props) => (
  <Svg {...p}>
    <path d="M5 17h10" />
    <path d="M7 13h6l1 2H6l1-2z" />
    <path d="M8.5 13V8.5a2.5 2.5 0 0 1 3 0V13" />
    <path d="M10 3v3" />
  </Svg>
);

export const IconSign = (p: Props) => (
  <Svg {...p}>
    <path d="M2.5 15c3 0 3.5-9 6-9s1 8 3.5 8 2-4 3.5-4 2 2 2 2" />
    <path d="M2.5 17.5h15" />
  </Svg>
);

export const IconRedact = (p: Props) => (
  <Svg {...p}>
    <rect x="2.5" y="3" width="15" height="14" />
    <rect x="5" y="6.5" width="10" height="3" fill="currentColor" stroke="none" />
    <path d="M5 12.5h6" />
  </Svg>
);

export const IconCompress = (p: Props) => (
  <Svg {...p}>
    <path d="M10 2v5M10 18v-5" />
    <path d="M7 5l3-3 3 3M7 15l3 3 3-3" />
    <path d="M3 10h14" />
  </Svg>
);

export const IconConvert = (p: Props) => (
  <Svg {...p}>
    <rect x="2.5" y="4" width="7" height="12" />
    <path d="M11 7l3 3-3 3" />
    <rect x="14" y="7" width="3.5" height="6" />
  </Svg>
);

export const IconForm = (p: Props) => (
  <Svg {...p}>
    <rect x="2.5" y="2.5" width="15" height="15" />
    <path d="M5.5 7h9M5.5 10.5h9M5.5 14h5" />
  </Svg>
);

export const IconTag = (p: Props) => (
  <Svg {...p}>
    <path d="M3 3h6.5l7.5 7.5-6.5 6.5L3 9.5V3z" />
    <circle cx="6.5" cy="6.5" r="1.2" />
  </Svg>
);

export const IconAsk = (p: Props) => (
  <Svg {...p}>
    <path d="M2.5 4.5h15v9h-9l-4 3.5v-3.5h-2v-9z" />
    <path d="M7.5 8a2.5 2.5 0 0 1 4.4 1.6c0 1.4-2 1.5-2 2.6" />
    <path d="M10 14.2v.3" strokeLinecap="round" />
  </Svg>
);

/* -- actions ------------------------------------------------------------ */

export const IconUndo = (p: Props) => (
  <Svg {...p}>
    <path d="M6 6.5H12a4 4 0 0 1 0 8H6.5" />
    <path d="M8.5 4L6 6.5 8.5 9" />
  </Svg>
);

export const IconRedo = (p: Props) => (
  <Svg {...p}>
    <path d="M14 6.5H8a4 4 0 0 0 0 8h5.5" />
    <path d="M11.5 4L14 6.5 11.5 9" />
  </Svg>
);

export const IconDownload = (p: Props) => (
  <Svg {...p}>
    <path d="M10 2.5v10" />
    <path d="M6 9l4 4 4-4" />
    <path d="M3 16.5h14" />
  </Svg>
);

export const IconRotateRight = (p: Props) => (
  <Svg {...p}>
    <path d="M16 8.5A6.5 6.5 0 1 0 15 13" />
    <path d="M16.5 3.5v5h-5" />
  </Svg>
);

export const IconRotateLeft = (p: Props) => (
  <Svg {...p}>
    <path d="M4 8.5A6.5 6.5 0 1 1 5 13" />
    <path d="M3.5 3.5v5h5" />
  </Svg>
);

export const IconTrash = (p: Props) => (
  <Svg {...p}>
    <path d="M3.5 5h13" />
    <path d="M5.5 5V3.5h9V5" />
    <path d="M5 5l1 12h8l1-12" />
    <path d="M8.5 8v6M11.5 8v6" />
  </Svg>
);

export const IconCopy = (p: Props) => (
  <Svg {...p}>
    <rect x="6.5" y="6.5" width="11" height="11" />
    <path d="M13.5 3.5h-11v11" />
  </Svg>
);

export const IconPlus = (p: Props) => (
  <Svg {...p}>
    <path d="M10 4v12M4 10h12" />
  </Svg>
);

export const IconMinus = (p: Props) => (
  <Svg {...p}>
    <path d="M4 10h12" />
  </Svg>
);

export const IconClose = (p: Props) => (
  <Svg {...p}>
    <path d="M4.5 4.5l11 11M15.5 4.5l-11 11" />
  </Svg>
);

export const IconCheck = (p: Props) => (
  <Svg {...p}>
    <path d="M3.5 10.5l4 4 9-9" />
  </Svg>
);

/* -- chrome ------------------------------------------------------------- */

/** The bench lamp. Filled when it is on. */
export const IconLamp = ({ on = false, ...p }: Props & { on?: boolean }) => (
  <Svg {...p}>
    <path d="M6.5 12a4.5 4.5 0 1 1 7 0c-.8 1-1 1.4-1 2.5h-5c0-1.1-.2-1.5-1-2.5z" fill={on ? "currentColor" : "none"} />
    <path d="M8 17h4" />
    {on && <path d="M10 1.5v1.5M3 5l1 .8M17 5l-1 .8M1.8 11h1.4M16.8 11h1.4" strokeLinecap="round" />}
  </Svg>
);

export const IconShield = (p: Props) => (
  <Svg {...p}>
    <path d="M10 2.5l6 2.2v5c0 3.4-2.4 6.4-6 7.8-3.6-1.4-6-4.4-6-7.8v-5l6-2.2z" />
    <path d="M7.2 10l2 2 3.6-3.8" />
  </Svg>
);

export const IconSearch = (p: Props) => (
  <Svg {...p}>
    <circle cx="8.75" cy="8.75" r="5.25" />
    <path d="M12.75 12.75L17 17" />
  </Svg>
);

export const IconFlag = (p: Props) => (
  <Svg {...p}>
    <path d="M4.5 17.5v-15" />
    <path d="M4.5 3.5h10l-2 3.5 2 3.5h-10" />
  </Svg>
);

/** A cursor over a line of type: retyping what is already on the page. */
export const IconEditText = (p: Props) => (
  <Svg {...p}>
    <path d="M3 4.5h9M7.5 4.5v8" />
    <path d="M5.5 12.5h4" />
    <path d="M11.5 17.5l6-6 1.5 1.5-6 6H11.5v-1.5z" />
  </Svg>
);

export const IconScissors = (p: Props) => (
  <Svg {...p}>
    <circle cx="5" cy="15" r="2.2" />
    <circle cx="15" cy="15" r="2.2" />
    <path d="M6.6 13.4L15 3M13.4 13.4L5 3" />
  </Svg>
);

export const IconSpinner = ({ size = 16, className }: Props) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 20 20"
    fill="none"
    aria-hidden="true"
    className={className}
    style={{ animation: "spin 900ms linear infinite" }}
  >
    <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.8" opacity="0.22" />
    <path
      d="M17 10a7 7 0 0 0-7-7"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    />
  </svg>
);
