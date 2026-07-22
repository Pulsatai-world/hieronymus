import React from "react";

/* Large display metric — for results, KPIs, proof points.
   Uses the display font with a colored accent, tabular figures. */
export function Stat({ value, label, caption, accent = "violet", onDark = false, align = "left", style = {}, ...rest }) {
  const accents = { violet: "var(--violet-600)", emerald: "var(--emerald-500)", ink: onDark ? "var(--white)" : "var(--ink-950)" };
  const valColor = accents[accent] || accents.violet;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "4px", textAlign: align, ...style }} {...rest}>
      <span style={{
        fontFamily: "var(--font-display)",
        fontWeight: "var(--fw-bold)",
        fontSize: "var(--fs-h1)",
        lineHeight: 1,
        letterSpacing: "var(--ls-tight)",
        color: valColor,
        fontVariantNumeric: "tabular-nums",
      }}>{value}</span>
      <span style={{
        fontFamily: "var(--font-display)",
        fontWeight: "var(--fw-semibold)",
        fontSize: "var(--fs-eyebrow)",
        letterSpacing: "var(--ls-wide)",
        textTransform: "uppercase",
        color: onDark ? "var(--ink-300)" : "var(--text-muted)",
      }}>{label}</span>
      {caption && (
        <span style={{ fontFamily: "var(--font-body)", fontSize: "var(--fs-sm)", color: onDark ? "var(--ink-300)" : "var(--text-body)", marginTop: "6px", maxWidth: "28ch" }}>{caption}</span>
      )}
    </div>
  );
}
