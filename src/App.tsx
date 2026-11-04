/**
 * App.tsx —— 应用根组件、登录守卫与 hash 路由装配
 *
 * 职责：
 * - 启动时恢复登录态；没有会话时自动创建临时访客账号（系统不强制注册）；
 * - 登录后提供页面级路由（用 URL hash 实现，无路由库）：
 *   - `#/`（或无 hash）：首页作品列表；
 *   - `#/assets`：素材 / 资源管理页；
 *   - `#/deck/<id>`：指定作品的 3D 编辑器；
 *   - `#/auth`：访客注册 / 登录页（可随时返回首页）；
 *   - `#/users`：管理员用户管理页（非管理员访问时回退首页）；
 * - 注册全局 401 处理：会话失效时回到登录 / 注册页，避免页面继续请求失败。
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
import { AuthPage } from './components/AuthPage';
import { Editor } from './components/Editor';
import { Home } from './components/Home';
import { UsersPage } from './components/UsersPage';
import { ToastHost } from './components/ui';
import {
  createGuest,
  fetchMe,
  logout as logoutRequest,
  setUnauthorizedHandler,
  type SessionUser,
} from './lib/api';

/**
 * 路由状态：用可辨识联合表示页面，
 * editor 分支携带作品 id，便于直接作为 Editor 的 deckId 与 key。
 */
type Route =
  | { name: 'home' }
  | { name: 'assets' }
  | { name: 'auth' }
  | { name: 'users' }
  | { name: 'editor'; id: string };

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
  if (/^#\/auth/.test(window.location.hash)) return { name: 'auth' };
  if (/^#\/users/.test(window.location.hash)) return { name: 'users' };
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
 * 应用根组件：登录守卫 + 路由渲染 + 全局 Toast 容器。
 *
 * @returns 登录页、加载态或当前路由对应的页面
 */
export default function App() {
  const [route, setRoute] = useState<Route>(readRoute);
  // undefined = 正在恢复登录态；null = 未登录；对象 = 已登录
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);

  useEffect(() => {
    // 任意接口返回 401（会话过期 / 被删除）时退回登录页
    setUnauthorizedHandler(() => setUser(null));
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    let alive = true;
    // 先尝试恢复已有会话；没有会话时自动创建临时访客，用户可直接开始使用
    const boot = async () => {
      try {
        const me = await fetchMe();
        if (alive) setUser(me);
        return;
      } catch {
        // 未登录或会话失效，继续创建访客会话
      }
      try {
        const guest = await createGuest();
        if (alive) setUser(guest);
      } catch {
        // 后端不可用时才退回登录页，由页面提示具体错误
        if (alive) setUser(null);
      }
    };
    void boot();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    // hashchange 同时覆盖页面内导航与浏览器前进 / 后退
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  /** 登录 / 注册成功：回到首页。 */
  const onAuthed = (next: SessionUser) => {
    setUser(next);
    navigate('#/');
  };

  /**
   * 退出登录：清除服务端会话后自动创建一个新的访客会话，
   * 用户无需重新登录也能继续使用（原账号数据仍保留，可随时登录找回）。
   */
  const onLogout = async () => {
    try {
      await logoutRequest();
    } catch {
      // 服务端不可达时依然允许本地退出，刷新后以 Cookie 状态为准
    }
    setUser(null);
    navigate('#/');
    try {
      setUser(await createGuest());
    } catch {
      // 访客创建失败时停在登录页
    }
  };

  if (user === undefined) {
    return (
      <>
        <div className="auth-loading">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <p>正在载入工作区…</p>
        </div>
        <ToastHost />
      </>
    );
  }

  if (user === null) {
    return (
      <>
        <AuthPage onAuthed={onAuthed} />
        <ToastHost />
      </>
    );
  }

  return (
    <>
      {route.name === 'assets' ? (
        <AssetsPage onBack={() => navigate('#/')} />
      ) : route.name === 'auth' && user.isGuest ? (
        <AuthPage defaultMode="register" onAuthed={onAuthed} onBack={() => navigate('#/')} />
      ) : route.name === 'users' && user.role === 'admin' ? (
        <UsersPage current={user} onBack={() => navigate('#/')} />
      ) : route.name === 'editor' ? (
        // key 绑定作品 id：切换作品时强制重建 Editor，清空上一部作品的场景与状态
        <Editor key={route.id} deckId={route.id} onBack={() => navigate('#/')} />
      ) : (
        <Home
          user={user}
          onOpen={(id) => navigate(`#/deck/${id}`)}
          onOpenAssets={() => navigate('#/assets')}
          onOpenAuth={() => navigate('#/auth')}
          onOpenUsers={() => navigate('#/users')}
          onLogout={() => void onLogout()}
        />
      )}
      {/* 全局 Toast 容器，放在路由之外，切换页面时提示不会被卸载 */}
      <ToastHost />
    </>
  );
}
