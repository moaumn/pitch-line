import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './', // 设为相对路径以完美兼容 GitHub Pages 等子目录静态托管环境 (Make assets relative for subdirectory hosting)
})
