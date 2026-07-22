import React from "react";

export interface InputProps {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  /** Error message; overrides hint and paints the field red. */
  error?: React.ReactNode;
  type?: string;
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  disabled?: boolean;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  iconLeft?: React.ReactNode;
  style?: React.CSSProperties;
}

/** Labeled text field with focus ring, hint, and error states. */
export function Input(props: InputProps): JSX.Element;
