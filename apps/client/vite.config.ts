import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    // 動画のストリーミング配信 (サーバーの /media) を、同じオリジンで使えるようにする
    proxy: { "/media": "http://127.0.0.1:8080" },
  },
});
