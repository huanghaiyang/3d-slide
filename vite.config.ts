/**
 * vite.config.ts —— Vite 开发服务器与构建配置
 *
 * 职责：
 * - 注册 React 插件，让 .tsx / JSX 能够被编译，并在开发时提供 Fast Refresh；
 * - 构建结束后把 docs/ 下的静态 HTML 文档复制到 dist/docs，随产物一起发布；
 * - 固定开发服务器端口 5176，避免端口漂移，便于联调与文档中给出的地址保持一致；
 * - 把 `/api` 请求代理到本地后端服务（server/index.mjs，默认 8787），前端因此只需请求同源接口。
 *
 * 运行方式：`npm run dev`（开发服务器）、`npm run server`（后端服务）、`npm run build`（先 tsc --noEmit 再 vite build）。
 * 构建输出使用 Vite 默认的 dist/ 目录（未显式配置 build.outDir）；
 * 未配置 resolve.alias，源码统一使用相对路径导入。
 */

// Vite 的配置辅助函数，主要提供类型提示与默认值合并，运行时无额外逻辑。
import { defineConfig } from 'vite';
// 官方 React 插件：负责 JSX 转换，并在开发服务器中启用 Fast Refresh。
import react from '@vitejs/plugin-react';
// Node 内置的文件复制能力，用于构建结束后搬运 docs 目录。
import { cpSync } from 'node:fs';
// 路径工具：dirname 取所在目录、resolve 拼成绝对路径。
import { dirname, resolve } from 'node:path';
// 把 import.meta.url（文件 URL）转成系统路径，得到配置文件自身所在的目录。
import { fileURLToPath } from 'node:url';

/** 项目根目录（本配置文件所在目录），用于把 docs / dist 折算成绝对路径。 */
const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // 插件列表：React 编译插件 + 自定义的构建后复制插件。
  plugins: [
    react(),
    {
      // 插件名，仅用于调试与日志中识别该插件。
      name: 'copy-docs',
      // apply: 'build' 表示只在 vite build 时生效，开发服务器与 preview 不执行复制。
      apply: 'build',
      closeBundle() {
        // closeBundle 在产物写盘完成后触发：把根目录的 docs/ 递归复制到 dist/docs/。
        // 文档是纯静态 HTML，无需经过打包，直接复制即可让发布产物包含文档。
        cpSync(resolve(root, 'docs'), resolve(root, 'dist/docs'), { recursive: true });
      },
    },
  ],
  // 开发服务器配置：固定端口 5176；端口被占用时 Vite 默认会尝试下一个可用端口。
  server: {
    port: 5176,
    proxy: {
      // 后端默认监听 8787（可用 PORT 或 SLIDE_API_TARGET 改写），代理后前端无需处理跨域
      '/api': {
        target: process.env.SLIDE_API_TARGET ?? 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
});
