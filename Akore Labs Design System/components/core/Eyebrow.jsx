import React from "react";

/* Letter-spaced kicker label — a signature Akore device echoing the wordmark's
   wide tracking. Optional leading tick (a short emerald rule) or dot marker. */
export function Eyebrow({ children, marker = "tick", color = "var(--violet-600)", onDark = false, style = {}, ...rest }) {
  const text = onDark ? "var(--ink-300)" : "var(--text-muted)";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "10px",
        fontFamily: "var(--font-display)",
        fontWeight: "var(--fw-semibold)",
        fontSize: "var(--fs-eyebrow)",
        letterSpacing: "var(--ls-wider)",
        textTransform: "uppercase",
        color: text,
        ...style,
      }}
      {...rest}
    >
      {marker === "tick" && (
        <span style={{ width: "22px", height: "2px", background: color, borderRadius: "2px" }} />
      )}
      {marker === "dot" && (
        <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: "var(--emerald-500)" }} />
      )}
      {children}
    </span>
  );
}
