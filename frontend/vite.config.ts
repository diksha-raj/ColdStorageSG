import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // siwe's message parser (apg-js) uses Node's Buffer; point it at the browser implementation.
    alias: { buffer: "buffer/" },
  },
  server: { port: 5173, strictPort: true },
});
