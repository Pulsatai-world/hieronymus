import React, { useState } from "react";

export function Card({
  children,
  variant = "default",
  padding = "24px",
  interactive = false,
  style = {},
  ...rest
}) {
  const [hover, setHover] = useState(false);
  const variants = {
    default: {
      background: "var(--surface-card)",
      border: "1px solid var(--border-subtle)",
      boxShadow: interactive && hover ? "var(--shadow-md)" : "var(--shadow-sm)",
      color: "var(--text-body)",
    },
    raised: {
      background: "var(--surface-card)",
      border: "1px solid var(--border-subtle)",
      boxShadow: interactive && hover ? "var(--shadow-lg)" : "var(--shadow-md)",
      color: "var(--text-body)",
    },
    subtle: {
      background: "var(--surface-sunken)",
      border: "1px solid transparent",
      boxShadow: "none",
      color: "var(--text-body)",
    },
    inverse: {
      background: "var(--ink-900)",
      border: "1px solid var(--border-inverse)",
      boxShadow: "none",
      color: "var(--text-on-dark)",
    },
    brand: {
      background: "var(--grad-violet)",
      border: "1px solid transparent",
      boxShadow: "var(--shadow-brand)",
      color: "var(--white)",
    },
  };
  const v = variants[variant] || variants.default;
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        borderRadius: "var(--radius-lg)",
        padding,
        transition: "box-shadow var(--dur-base) var(--ease-standard), transform var(--dur-base) var(--ease-standard)",
        transform: interactive && hover ? "translateY(-2px)" : "translateY(0)",
        cursor: interactive ? "pointer" : "default",
        ...v,
        ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  );
}
