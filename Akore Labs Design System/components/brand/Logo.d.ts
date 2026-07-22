export interface LogoProps {
  variant?: "mark" | "horizontal" | "stacked";
  /** `dark` = for dark backgrounds (violet/white marks); `light` = for light backgrounds (black mark). */
  theme?: "dark" | "light";
  height?: number | string;
  /** Path to the folder holding the logo PNGs. Default "assets". */
  base?: string;
  alt?: string;
  style?: React.CSSProperties;
}

/** Official Akore Labs logo, rendered from packaged image assets. */
export function Logo(props: LogoProps): JSX.Element;
