import type { ButtonHTMLAttributes, ReactNode } from "react";
import { SpinnerIcon } from "./icons";

/* ---------------------------------------------------------------- */
/* Kicker - mono uppercase section label                             */
/* ---------------------------------------------------------------- */
export function Kicker({
  children,
  icon,
  className = "",
}: {
  children: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <span className={`kicker ${className}`}>
      {icon}
      {children}
    </span>
  );
}

/* ---------------------------------------------------------------- */
/* Card - unified glass surface                                      */
/* ---------------------------------------------------------------- */
export function Card({
  children,
  className = "",
  hover = false,
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  hover?: boolean;
  padded?: boolean;
}) {
  return (
    <div
      className={`panel ${hover ? "panel-hover" : ""} ${padded ? "p-6" : ""} ${className}`}
    >
      {children}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Badge / pill                                                     */
/* ---------------------------------------------------------------- */
type Tone = "accent" | "shield" | "warn" | "danger" | "neutral";

const toneVar: Record<Tone, string> = {
  accent: "#5bc8ec",
  shield: "#46d6a6",
  warn: "#f3b556",
  danger: "#ff6f63",
  neutral: "#8a93a3",
};

export function Badge({
  children,
  tone = "neutral",
  dot = false,
  className = "",
}: {
  children: ReactNode;
  tone?: Tone;
  dot?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`pill ${className}`}
      style={{ ["--pill" as string]: toneVar[tone] }}
    >
      {dot && <span className="dot" style={{ background: toneVar[tone] }} />}
      {children}
    </span>
  );
}

/* ---------------------------------------------------------------- */
/* Button                                                           */
/* ---------------------------------------------------------------- */
type Variant = "primary" | "shield" | "ghost" | "danger-ghost";

const variantClass: Record<Variant, string> = {
  primary: "btn-primary",
  shield: "btn-shield",
  ghost: "btn-ghost",
  "danger-ghost": "btn-danger-ghost",
};

export function Button({
  children,
  variant = "primary",
  loading = false,
  icon,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  loading?: boolean;
  icon?: ReactNode;
}) {
  return (
    <button
      className={`btn ${variantClass[variant]} ${className}`}
      disabled={loading || props.disabled}
      {...props}
    >
      {loading ? <SpinnerIcon size={16} /> : icon}
      {children}
    </button>
  );
}

/* ---------------------------------------------------------------- */
/* Field label wrapper                                              */
/* ---------------------------------------------------------------- */
export function FieldLabel({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-baseline justify-between">
        <span className="text-xs font-medium text-fg-soft">{label}</span>
        {hint && <span className="font-mono text-[10px] text-fg-faint">{hint}</span>}
      </span>
      {children}
    </label>
  );
}
