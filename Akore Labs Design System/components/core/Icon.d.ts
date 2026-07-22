export interface IconProps {
  /** Lucide icon name, e.g. "map-pin", "sparkles", "arrow-right". */
  name: string;
  size?: number;
  color?: string;
  strokeWidth?: number;
  style?: React.CSSProperties;
}

/**
 * Lucide icon wrapper — the brand's standard icon set (1.75px stroke, rounded).
 * Requires the Lucide UMD script loaded on the page.
 */
export function Icon(props: IconProps): JSX.Element;
