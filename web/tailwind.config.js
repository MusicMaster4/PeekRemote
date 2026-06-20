/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,jsx}", "./components/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        // Silver-gelatin noir — true blacks, warm ivory ink.
        bg: "#08080a",
        "bg-soft": "#0d0d10",
        mount: "#040405", // black mount the "print" sits on
        panel: "rgba(247,248,250,0.022)",
        "panel-strong": "rgba(247,248,250,0.05)",
        "panel-solid": "#121215",
        line: "rgba(247,248,250,0.10)",
        "line-strong": "rgba(247,248,250,0.24)",
        ink: "#f7f8fa", // crisp cool white
        text: "#d7dade",
        silver: "#aeb2b8",
        muted: "#878b91",
        faint: "#595d63",
        danger: "#cf7a6b",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "Arial Black", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      letterSpacing: {
        editorial: "0.34em",
        stamp: "0.2em",
      },
      keyframes: {
        // One-shot only — nothing loops, so an idle page costs ~0 CPU.
        fadein: {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        develop: {
          // A darkroom print "coming up" in the tray. No blur — a blur filter
          // animating over a 4K screenshot is the one thing that would jank a
          // phone; contrast/brightness alone keeps the effect cheap.
          from: { opacity: "0", filter: "contrast(1.4) brightness(1.2)" },
          to: { opacity: "1", filter: "none" },
        },
        rise: {
          from: { opacity: "0", transform: "translateY(16px)" },
          to: { opacity: "1", transform: "none" },
        },
        // A light sweep across the dark plate — like an enlarger scanning the
        // paper. Pure transform (no repaint), so it stays cheap. Only ever runs
        // while loading / waiting, never on a page with a settled image.
        shimmer: {
          "0%": { transform: "translateX(-160%) skewX(-12deg)" },
          "100%": { transform: "translateX(260%) skewX(-12deg)" },
        },
      },
      animation: {
        fadein: "fadein 320ms ease both",
        develop: "develop 620ms cubic-bezier(0.2,0.7,0.2,1) both",
        rise: "rise 260ms cubic-bezier(0.2,0.8,0.2,1) both",
        shimmer: "shimmer 1.6s ease-in-out infinite",
        "shimmer-slow": "shimmer 3.2s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
