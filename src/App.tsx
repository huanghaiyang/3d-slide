/**
 * App.tsx —— 应用根组件与 hash 路由装配
 *
 * 本项目没有引入路由库，而是用 URL hash 实现三个页面级的轻量路由：
 * - `#/`（或无 hash）：首页作品列表；
 * - `#/assets`：素材 / 资源管理页；
 * - `#/deck/<id>`：指定作品的 3D 编辑器。
 *
 * 数据流：
 * 1. 首次渲染时由 readRoute 解析当前 hash 得到初始路由；
 * 2. 监听 hashchange，任何导航（包括浏览器前进 / 后退）都会重新解析并更新 state；
 * 3. 页面通过 navigate 修改 hash，从而触发重新渲染；
 * 4. 编辑器以作品 id 作为 React key，切换到另一作品时会强制卸载重建，
 *    确保 3D 场景、相机与本地状态不会残留上一部作品的数据。
 */

import { useEffect, useState } from 'react';
import { AssetsPage } from './components/AssetsPage';
import { Editor } from './components/Editor';
import { Home } from './components/Home';
import { ToastHost } from './components/ui';

/**
 * 路由状态：用可辨识联合表示三个页面，
 * editor 分支携带作品 id，便于直接作为 Editor 的 deckId 与 key。
 */
type Route = { name: 'home' } | { name: 'assets' } | { name: 'editor'; id: string };

/**
 * 从当前 URL hash 解析路由。
 *
 * 只匹配固定的前缀，忽略后续多余片段；无法识别时一律回退到首页。
 * id 允许字母、数字、下划线与连字符（与作品 id 的生成方式一致）。
 *
 * @returns 解析出的路由对象
 */
function readRoute(): Route {
  const match = window.location.hash.match(/^#\/deck\/([\w-]+)/);
  if (match) return { name: 'editor', id: match[1] };
  if (/^#\/assets/.test(window.location.hash)) return { name: 'assets' };
  return { name: 'home' };
}

/**
 * 通过修改 hash 导航到目标地址。
 *
 * 与当前 hash 相同时直接返回，避免重复触发 hashchange 与无谓重渲染；
 * 这里只改 hash，不调用 history API，因此浏览器前进 / 后退可自然工作。
 *
 * @param hash 目标 hash（需包含开头的 #）
 */
function navigate(hash: string) {
  if (window.location.hash === hash) return;
  window.location.hash = hash;
}

/**
 * 应用根组件：根据 hash 路由渲染对应页面，并挂载全局 Toast 容器。
 *
 * 副作用：组件挂载时注册 hashchange 监听，卸载时移除。
 *
 * @returns 当前路由对应的页面组件
 */
export default function App() {
  const [route, setRoute] = useState<Route>(readRoute);

  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    // hashchange 同时覆盖页面内导航与浏览器前进 / 后退
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return (
    <>
      {route.name === 'home' ? (
        <Home onOpen={(id) => navigate(`#/deck/${id}`)} onOpenAssets={() => navigate('#/assets')} />
      ) : route.name === 'assets' ? (
        <AssetsPage onBack={() => navigate('#/')} />
      ) : (
        // key 绑定作品 id：切换作品时强制重建 Editor，清空上一部作品的场景与状态
        <Editor key={route.id} deckId={route.id} onBack={() => navigate('#/')} />
      )}
      {/* 全局 Toast 容器，放在路由之外，切换页面时提示不会被卸载 */}
      <ToastHost />
    </>
  );
}
