import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Deep charcoal canvas, layered surfaces.
        ink: {
          950: "#06080c",
          900: "#080b11",
          850: "#0b0f16",
          800: "#0f141d",
        },
        surface: {
          DEFAULT: "rgba(255,255,255,0.022)",
          raised: "rgba(255,255,255,0.04)",
          strong: "rgba(255,255,255,0.06)",
          border: "rgba(236,241,255,0.08)",
          "border-strong": "rgba(236,241,255,0.14)",
        },
        // Text ramp
        fg: {
          DEFAULT: "#e8edf6",
          soft: "#aeb7c6",
          muted: "#7b8597",
          faint: "#525c6c",
        },
        // Signature: cool, trustworthy cyan — restrained, not neon.
        accent: {
          DEFAULT: "#5bc8ec",
          soft: "#9adcf2",
          deep: "#2a9fce",
          dim: "rgba(91,200,236,0.12)",
        },
        // Privacy / shielded / success — calm emerald-teal.
        shield: {
          DEFAULT: "#46d6a6",
          deep: "#229f78",
          dim: "rgba(70,214,166,0.12)",
        },
        warn: {
          DEFAULT: "#f3b556",
          deep: "#c88a2f",
          dim: "rgba(243,181,86,0.12)",
        },
        danger: {
          DEFAULT: "#ff6f63",
          deep: "#d24a40",
          dim: "rgba(255,111,99,0.12)",
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "Georgia", "serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      fontSize: {
        "display-xl": ["clamp(3rem, 7vw, 6rem)", { lineHeight: "0.92", letterSpacing: "-0.02em" }],
        "display-lg": ["clamp(2.5rem, 5vw, 4.25rem)", { lineHeight: "0.95", letterSpacing: "-0.02em" }],
        "display-md": ["clamp(2rem, 3.6vw, 3.1rem)", { lineHeight: "0.98", letterSpacing: "-0.015em" }],
      },
      borderRadius: {
        xl: "16px",
        "2xl": "20px",
        "3xl": "26px",
      },
      boxShadow: {
        card: "0 24px 60px -28px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.05)",
        raised: "0 34px 90px -32px rgba(0,0,0,0.85), inset 0 1px 0 rgba(255,255,255,0.06)",
        glow: "0 0 0 1px rgba(91,200,236,0.35), 0 18px 50px -18px rgba(91,200,236,0.45)",
        "glow-shield": "0 0 0 1px rgba(70,214,166,0.3), 0 18px 50px -18px rgba(70,214,166,0.4)",
        nav: "0 18px 50px -20px rgba(0,0,0,0.9), inset 0 1px 0 rgba(255,255,255,0.06)",
      },
      backdropBlur: {
        xs: "2px",
      },
      keyframes: {
        "rise-in": {
          "0%": { opacity: "0", transform: "translateY(14px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "fade-in": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        drift: {
          "0%,100%": { transform: "translate3d(0,0,0)" },
          "50%": { transform: "translate3d(0,-10px,0)" },
        },
        "pulse-ring": {
          "0%": { boxShadow: "0 0 0 0 rgba(91,200,236,0.45)" },
          "70%": { boxShadow: "0 0 0 8px rgba(91,200,236,0)" },
          "100%": { boxShadow: "0 0 0 0 rgba(91,200,236,0)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "200% 0" },
          "100%": { backgroundPosition: "-200% 0" },
        },
      },
      animation: {
        "rise-in": "rise-in 0.7s cubic-bezier(0.22,1,0.36,1) both",
        "fade-in": "fade-in 0.6s ease-out both",
        drift: "drift 7s ease-in-out infinite",
        "pulse-ring": "pulse-ring 2s ease-out infinite",
        shimmer: "shimmer 2.2s linear infinite",
      },
    },
  },
  plugins: [],
};

export default config;
