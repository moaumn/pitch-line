import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ command }) => {
  // command === 'build' 代表运行了 npm run build (线上打包环境)
  const isProd = command === 'build'

  return {
    plugins: [react()],

    // 🟢 动态注入绝对路径，彻底消灭 `./` 带来的路径漂移：
    // 本地开发用服务器根绝对路径 '/'
    // 线上打包自动换成 GitHub 仓库的绝对二级目录 '/pitch-line/'
    base: isProd ? '/pitch-line/' : '/',

    worker: {
      format: 'es' // 强制 Worker 使用 ESM 格式打包，配合绝对路径确保线上绝对不爆 404
    }
  }
})