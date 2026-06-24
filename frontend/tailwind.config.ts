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
        surface: {
          DEFAULT: "#0c0f14",
          raised: "#12171f",
          border: "#1e2736",
        },
        accent: {
          DEFAULT: "#22d3ee",
          muted: "#0891b2",
          glow: "#06b6d4",
        },
        shield: {
          DEFAULT: "#10b981",
          muted: "#059669",
        },
        warn: "#f59e0b",
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-geist-mono)", "ui-monospace", "monospace"],
      },
      boxShadow: {
        glow: "0 0 40px -10px rgba(34, 211, 238, 0.35)",
        shield: "0 0 40px -10px rgba(16, 185, 129, 0.35)",
      },
    },
  },
  plugins: [],
};

export default config;
