import React from "react";

/**
 * Content container with the brand's calm elevation: 16px radius, hairline
 * border, low-spread cool shadow.
 * @startingPoint section="Core" subtitle="Surface container — 5 variants" viewport="700x220"
 */
export interface CardProps {
  children?: React.ReactNode;
  /** `brand` uses the violet gradient; `inverse` is the dark surface. */
  variant?: "default" | "raised" | "subtle" | "inverse" | "brand";
  /** CSS padding shorthand. */
  padding?: string;
  /** Adds lift + stronger shadow on hover. */
  interactive?: boolean;
  style?: React.CSSProperties;
}

/** Card surface container. */
export function Card(props: CardProps): JSX.Element;
