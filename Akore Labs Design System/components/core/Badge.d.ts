export interface BadgeProps {
  children?: React.ReactNode;
  tone?: "violet" | "emerald" | "neutral" | "solid" | "outline" | "outline-dark";
  size?: "sm" | "md";
  /** Leading status dot in the current text color. */
  dot?: boolean;
  style?: React.CSSProperties;
}

/** Small pill label / tag for statuses, categories, and metadata. */
export function Badge(props: BadgeProps): JSX.Element;
