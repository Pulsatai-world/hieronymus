import React, { useState } from "react";

const sizes = {
  sm: { fontSize: "0.8125rem", padding: "8px 16px", gap: "6px", height: "36px" },
  md: { fontSize: "0.9375rem", padding: "11px 22px", gap: "8px", height: "44px" },
  lg: { fontSize: "1rem", padding: "15px 30px", gap: "10px", height: "54px" },
};

export function Button({
  children,
  variant = "primary",
  size = "md",
  fullWidth = false,
  disabled = false,
  iconLeft = null,
  iconRight = null,
  onClick,
  type = "button",
  style = {},
  ...rest
}) {
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState(false);
  const s = sizes[size] || sizes.md;

  const palettes = {
    primary: {
      background: hover ? "var(--violet-700)" : "var(--violet-600)",
      color: "var(--white)",
      border: "1px solid transparent",
      boxShadow: hover ? "var(--shadow-brand)" : "var(--shadow-sm)",
    },
    accent: {
      background: hover ? "var(--emerald-600)" : "var(--emerald-500)",
      color: "var(--white)",
      border: "1px solid transparent",
      boxShadow: hover ? "var(--shadow-accent)" : "var(--shadow-sm)",
    },
    secondary: {
      background: hover ? "var(--ink-50)" : "var(--white)",
      color: "var(--ink-900)",
      border: "1px solid var(--border-default)",
      boxShadow: "none",
    },
    ghost: {
      background: hover ? "var(--violet-50)" : "transparent",
      color: "var(--violet-600)",
      border: "1px solid transparent",
      boxShadow: "none",
    },
    inverse: {
      background: hover ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.06)",
      color: "var(--white)",
      border: "1px solid rgba(255,255,255,0.18)",
      boxShadow: "none",
    },
  };
  const p = palettes[variant] || palettes.primary;

  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setActive(false); }}
      onMouseDown={() => setActive(true)}
      onMouseUp={() => setActive(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: s.gap,
        fontFamily: "var(--font-body)",
        fontWeight: "var(--fw-semibold)",
        fontSize: s.fontSize,
        letterSpacing: "0.01em",
        lineHeight: 1,
        padding: s.padding,
        minHeight: s.height,
        width: fullWidth ? "100%" : "auto",
        borderRadius: "var(--radius-pill)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.45 : 1,
        transform: active && !disabled ? "translateY(1px)" : "translateY(0)",
        transition: "background var(--dur-fast) var(--ease-standard), box-shadow var(--dur-base) var(--ease-standard), transform var(--dur-fast) var(--ease-standard)",
        WebkitTapHighlightColor: "transparent",
        ...p,
        ...style,
      }}
      {...rest}
    >
      {iconLeft}
      {children}
      {iconRight}
    </button>
  );
}
