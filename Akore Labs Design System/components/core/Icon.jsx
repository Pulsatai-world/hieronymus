import React, { useEffect, useRef } from "react";

/* Thin wrapper over Lucide (https://lucide.dev) — the icon set Akore Labs
   standardises on: 1.75px stroke, rounded caps, no fills. Requires the Lucide
   UMD script on the page (see prompt.md / cards). */
export function Icon({ name, size = 20, color = "currentColor", strokeWidth = 1.75, style = {}, ...rest }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current && typeof window !== "undefined" && window.lucide) {
      ref.current.innerHTML = "";
      const el = document.createElement("i");
      el.setAttribute("data-lucide", name);
      ref.current.appendChild(el);
      try { window.lucide.createIcons({ nameAttr: "data-lucide", attrs: { width: size, height: size, stroke: color, "stroke-width": strokeWidth } }); } catch (e) {}
    }
  }, [name, size, color, strokeWidth]);
  return (
    <span
      ref={ref}
      role="img"
      aria-label={name}
      style={{ display: "inline-flex", width: size, height: size, lineHeight: 0, color, ...style }}
      {...rest}
    />
  );
}
