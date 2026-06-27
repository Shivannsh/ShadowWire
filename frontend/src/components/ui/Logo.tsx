import Link from "next/link";

/**
 * ShadowWire mark: two offset shielded layers + a severed wire dot —
 * "a private wire behind a shield". Restrained, geometric, not a hacker glyph.
 */
export function LogoMark({ size = 30 }: { size?: number }) {
  return (
    <span
      className="relative inline-grid place-items-center rounded-xl"
      style={{
        width: size,
        height: size,
        background:
          "linear-gradient(160deg, rgba(91,200,236,0.16), rgba(70,214,166,0.08))",
        border: "1px solid rgba(91,200,236,0.28)",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08)",
      }}
      aria-hidden="true"
    >
      <svg width={size * 0.62} height={size * 0.62} viewBox="0 0 24 24" fill="none">
        <path
          d="M12 3l6.5 2.6v4.3c0 4.1-2.7 6.9-6.5 8.3-3.8-1.4-6.5-4.2-6.5-8.3V5.6L12 3z"
          stroke="#7dd6f3"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path d="M8.7 12.2h6.6" stroke="#46d6a6" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="12" cy="12.2" r="1.4" fill="#46d6a6" />
      </svg>
    </span>
  );
}

export function Wordmark({ size = 30 }: { size?: number }) {
  return (
    <Link
      href="/"
      className="group flex items-center gap-2.5"
      aria-label="ShadowWire home"
    >
      <LogoMark size={size} />
      <span className="text-[15px] font-semibold tracking-tight text-fg">
        Shadow<span className="text-fg-muted transition-colors group-hover:text-accent">Wire</span>
      </span>
    </Link>
  );
}
