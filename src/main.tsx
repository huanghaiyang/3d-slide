/**
 * main.tsx —— 浏览器入口文件
 *
 * 职责：
 * 1. 引入全局样式 styles.css（CSS 变量、基础重置与通用组件样式）；
 * 2. 找到页面中的 #root 挂载点；
 * 3. 使用 React 18 的 createRoot 挂载 App。
 *
 * 挂载点缺失时直接抛错，属于启动阶段的致命配置问题，应尽早暴露而不是静默失败。
 * 当前入口未使用 StrictMode：3D 场景包含 WebGL 上下文与命令式资源管理，
 * 开发模式下的重复挂载 / 卸载会带来额外的上下文创建与销毁开销。
 */

import { createRoot } from 'react-dom/client';
import App from './App';
// 插件在启动阶段完成注册（图表渲染器、模板贡献等），供编辑器与首页使用
import './plugins';
import './styles.css';

const root = document.getElementById('root');
// #root 由 index.html 提供；缺失说明 HTML 模板被改坏或脚本注入位置错误
if (!root) throw new Error('缺少 #root 挂载点');
createRoot(root).render(<App />);
