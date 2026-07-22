import React from "react";

const tones = {
  violet:  { background: "var(--violet-100)", color: "var(--violet-700)", border: "transparent" },
  emerald: { background: "var(--emerald-100)", color: "var(--emerald-700)", border: "transparent" },
  neutral: { background: "var(--ink-100)", color: "var(--ink-700)", border: "transparent" },
  solid:   { background: "var(--violet-600)", color: "var(--white)", border: "transparent" },
  outline: { background: "transparent", color: "var(--ink-600)", border: "var(--border-default)" },
  "outline-dark": { background: "rgba(255,255,255,0.06)", color: "var(--white)", border: "rgba(255,255,255,0.2)" },
};

export function Badge({ children, tone = "violet", size = "md", dot = false, style = {}, ...rest }) {
  const t = tones[tone] || tones.violet;
  const sizing = size === "sm"
    ? { fontSize: "0.6875rem", padding: "3px 9px" }
    : { fontSize: "0.75rem", padding: "5px 12px" };
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        fontFamily: "var(--font-body)",
        fontWeight: "var(--fw-semibold)",
        letterSpacing: "0.02em",
        lineHeight: 1.2,
        borderRadius: "var(--radius-pill)",
        background: t.background,
        color: t.color,
        border: `1px solid ${t.border}`,
        ...sizing,
        ...style,
      }}
      {...rest}
    >
      {dot && <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "currentColor" }} />}
      {children}
    </span>
  );
}
