import React from "react";

/**
 * Akore Labs pill button. Primary calls-to-action use `primary` (violet);
 * `accent` (emerald) is reserved for one high-emphasis action per view.
 * @startingPoint section="Core" subtitle="Pill button — violet / emerald / ghost" viewport="700x120"
 */
export interface ButtonProps {
  children?: React.ReactNode;
  /** Visual style. `primary` = brand violet, `accent` = emerald, `inverse` for dark backgrounds. */
  variant?: "primary" | "accent" | "secondary" | "ghost" | "inverse";
  size?: "sm" | "md" | "lg";
  fullWidth?: boolean;
  disabled?: boolean;
  iconLeft?: React.ReactNode;
  iconRight?: React.ReactNode;
  onClick?: (e: React.MouseEvent) => void;
  type?: "button" | "submit" | "reset";
  style?: React.CSSProperties;
}

/**
 * Akore Labs pill button.
 */
export function Button(props: ButtonProps): JSX.Element;
