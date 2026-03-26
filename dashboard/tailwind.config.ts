import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        status: {
          healthy: "#22c55e",
          warning: "#eab308",
          degraded: "#f97316",
          critical: "#ef4444",
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
