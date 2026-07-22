export interface StatProps {
  /** The headline figure, e.g. "3.4×" or "72%". */
  value: React.ReactNode;
  /** Short uppercase label under the figure. */
  label: React.ReactNode;
  /** Optional supporting sentence. */
  caption?: React.ReactNode;
  accent?: "violet" | "emerald" | "ink";
  onDark?: boolean;
  align?: "left" | "center";
  style?: React.CSSProperties;
}

/** Big display metric for results / proof points. */
export function Stat(props: StatProps): JSX.Element;
