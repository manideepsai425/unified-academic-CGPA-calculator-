/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: {
          DEFAULT: "#ffffff",
          subtle: "#f6f8fa",
          inset: "#f6f8fa",
        },
        border: {
          DEFAULT: "#d0d7de",
          muted: "#d8dee4",
        },
        fg: {
          DEFAULT: "#1f2328",
          muted: "#656d76",
          subtle: "#6e7781",
        },
        accent: {
          DEFAULT: "#0969da",
          emphasis: "#0550ae",
          subtle: "#ddf4ff",
        },
        success: {
          DEFAULT: "#1a7f37",
          emphasis: "#116329",
          subtle: "#dafbe1",
        },
        danger: {
          DEFAULT: "#cf222e",
          emphasis: "#a40e26",
          subtle: "#ffebe9",
        },
        attention: {
          DEFAULT: "#9a6700",
          subtle: "#fff8c5",
        },
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Helvetica",
          "Arial",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "SF Mono",
          "Menlo",
          "Consolas",
          "Liberation Mono",
          "monospace",
        ],
      },
      borderRadius: {
        DEFAULT: "6px",
        lg: "12px",
      },
      boxShadow: {
        card: "0 1px 0 rgba(31, 35, 40, 0.04)",
        "card-hover": "0 3px 6px rgba(140, 149, 159, 0.15)",
        overlay: "0 8px 24px rgba(140, 149, 159, 0.2)",
      },
    },
  },
  plugins: [],
};
