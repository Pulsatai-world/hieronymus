import React, { useState, useId } from "react";

export function Input({
  label,
  hint,
  error,
  type = "text",
  value,
  defaultValue,
  placeholder,
  disabled = false,
  onChange,
  iconLeft = null,
  style = {},
  ...rest
}) {
  const [focus, setFocus] = useState(false);
  const id = useId();
  const borderColor = error
    ? "var(--danger)"
    : focus
    ? "var(--violet-600)"
    : "var(--border-default)";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px", fontFamily: "var(--font-body)", ...style }}>
      {label && (
        <label htmlFor={id} style={{ fontSize: "var(--fs-sm)", fontWeight: "var(--fw-semibold)", color: "var(--text-strong)" }}>{label}</label>
      )}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        background: disabled ? "var(--ink-50)" : "var(--white)",
        border: `1px solid ${borderColor}`,
        borderRadius: "var(--radius-md)",
        padding: "0 14px",
        boxShadow: focus ? `0 0 0 var(--ring-width) var(--focus-ring)` : "none",
        transition: "border-color var(--dur-base) var(--ease-standard), box-shadow var(--dur-base) var(--ease-standard)",
      }}>
        {iconLeft && <span style={{ color: "var(--text-muted)", display: "inline-flex" }}>{iconLeft}</span>}
        <input
          id={id}
          type={type}
          value={value}
          defaultValue={defaultValue}
          placeholder={placeholder}
          disabled={disabled}
          onChange={onChange}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          style={{
            flex: 1,
            border: "none",
            outline: "none",
            background: "transparent",
            fontFamily: "var(--font-body)",
            fontSize: "var(--fs-body)",
            color: "var(--text-strong)",
            padding: "12px 0",
            minWidth: 0,
          }}
          {...rest}
        />
      </div>
      {error ? (
        <span style={{ fontSize: "var(--fs-xs)", color: "var(--danger)" }}>{error}</span>
      ) : hint ? (
        <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)" }}>{hint}</span>
      ) : null}
    </div>
  );
}
