import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  // GitHub Pages sirve en https://TU-USUARIO.github.io/NOMBRE-DEL-REPO/
  // Cambiá "planboda" por el nombre EXACTO de tu repositorio.
  base: "/planboda/",
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon-192.png", "icon-512.png", "apple-touch-icon.png"],
      manifest: {
        name: "PlanBoda — Ale & Cande",
        short_name: "PlanBoda",
        description: "Presupuesto y ahorro del casamiento",
        lang: "es-AR",
        id: "/planboda/",
        start_url: "/planboda/",
        scope: "/planboda/",
        theme_color: "#7a2e3f",
        background_color: "#fbf4ee",
        display: "standalone",
        orientation: "portrait",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
    }),
  ],
});
