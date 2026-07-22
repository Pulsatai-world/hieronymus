export interface EyebrowProps {
  children?: React.ReactNode;
  /** Leading marker: short rule (`tick`), emerald `dot`, or `none`. */
  marker?: "tick" | "dot" | "none";
  /** Tick color (default brand violet). */
  color?: string;
  /** Use on dark sections (lightens the text). */
  onDark?: boolean;
  style?: React.CSSProperties;
}

/**
 * Wide-tracked uppercase kicker label — the brand's section-labeling device,
 * echoing the wordmark's tracking. Sits above headings.
 */
export function Eyebrow(props: EyebrowProps): JSX.Element;
