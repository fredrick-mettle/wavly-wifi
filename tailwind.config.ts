import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0A0E1F",
        brand: {
          50: "#F2F0FF", 100: "#E6E1FF", 200: "#CFC5FF", 300: "#B1A0FF",
          400: "#9078FC", 500: "#7159F4", 600: "#5B3FE0", 700: "#4B31BC",
          800: "#3E2B98", 900: "#342779", 950: "#1E1550",
        },
        mint: {
          50: "#E8FBF5", 100: "#C9F5E7", 200: "#96EBD1", 300: "#5ADBB6",
          400: "#2FC79C", 500: "#16AE85", 600: "#0D8C6C", 700: "#0D7057",
        },
        sand: {
          50: "#FFF8EE", 100: "#FFEDD4", 200: "#FFD9A8", 300: "#FFBE70",
          400: "#FF9C3D", 500: "#FB7C18", 600: "#EA5C0B",
        },
      },
      fontFamily: {
        sans: ['"Inter Variable"', "Inter", "system-ui", "sans-serif"],
        display: ['"Plus Jakarta Sans Variable"', '"Inter Variable"', "system-ui", "sans-serif"],
      },
      boxShadow: {
        soft: "0 1px 2px rgba(16,24,40,.04), 0 8px 24px -8px rgba(16,24,40,.12)",
        card: "0 1px 3px rgba(16,24,40,.06), 0 12px 32px -12px rgba(16,24,40,.18)",
        glow: "0 20px 60px -20px rgba(113,89,244,.55)",
        glass: "0 24px 80px -24px rgba(0,0,0,.65)",
      },
      keyframes: {
        floaty: { "0%,100%": { transform: "translateY(0px)" }, "50%": { transform: "translateY(-18px)" } },
        drift: { "0%,100%": { transform: "translate(0,0) scale(1)" }, "50%": { transform: "translate(30px,-25px) scale(1.08)" } },
        fadeUp: { "0%": { opacity: "0", transform: "translateY(12px)" }, "100%": { opacity: "1", transform: "translateY(0)" } },
        shimmer: { "0%": { backgroundPosition: "0% 50%" }, "100%": { backgroundPosition: "200% 50%" } },
        pop: { "0%": { opacity: "0", transform: "scale(.94)" }, "100%": { opacity: "1", transform: "scale(1)" } },
      },
      animation: {
        floaty: "floaty 7s ease-in-out infinite",
        drift: "drift 16s ease-in-out infinite",
        "fade-up": "fadeUp .5s ease-out both",
        shimmer: "shimmer 6s linear infinite",
        pop: "pop .3s ease-out both",
      },
    },
  },
  plugins: [],
};
export default config;
