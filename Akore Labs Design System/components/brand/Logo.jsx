import React from "react";

/* Renders an official Akore Labs logo asset. Because assets live outside the
   consuming page, pass `base` = the relative/absolute path to the folder that
   holds the logo PNGs (default "assets"). */
const FILES = {
  "mark-dark":       "logo-mark.png",
  "mark-light":      "logo-mark-black.png",
  "horizontal-dark": "logo-horizontal-dark.png",
  "horizontal-light":"logo-horizontal-light.png",
  "stacked-dark":    "logo-stacked-dark.png",
  "stacked-light":   "logo-stacked-light.png",
};

export function Logo({ variant = "horizontal", theme = "dark", height, base = "assets", alt = "Akore Labs", style = {}, ...rest }) {
  const key = `${variant}-${theme}`;
  const file = FILES[key] || FILES["horizontal-dark"];
  const defaultH = variant === "mark" ? 44 : variant === "stacked" ? 120 : 40;
  const h = height || defaultH;
  return (
    <img
      src={`${base}/${file}`}
      alt={alt}
      style={{ height: typeof h === "number" ? `${h}px` : h, width: "auto", display: "block", ...style }}
      {...rest}
    />
  );
}
