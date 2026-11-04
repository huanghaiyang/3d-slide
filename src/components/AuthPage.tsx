/**
 * AuthPage.tsx —— 登录 / 注册页
 *
 * 职责：
 * - 提供「登录」「注册」两种模式；
 * - 访客从首页进入时可返回首页（不强制注册），注册会把当前临时会话原地升级；
 * - 调用后端 /api/auth/login|register，成功后把用户信息交给 App；
 * - 第一个正式注册的账号自动成为管理员（由服务端判定）。
 *
 * 说明：登录态使用 HttpOnly Cookie，前端无法也不需要在本地保存令牌。
 */

import { useState, type FormEvent } from 'react';
import { login, register, type SessionUser } from '../lib/api';
import { Icon } from './Icon';

interface AuthPageProps {
  /** 登录 / 注册成功后的回调。 */
  onAuthed: (user: SessionUser) => void;
  /** 返回首页（仅访客从首页进入时提供，未登录兜底页没有该入口）。 */
  onBack?: () => void;
  /** 初始模式，访客默认直接展示注册。 */
  defaultMode?: 'login' | 'register';
}

/**
 * 登录注册页。
 * @param onAuthed 成功回调
 * @param onBack 返回首页
 * @param defaultMode 初始模式
 */
export function AuthPage({ onAuthed, onBack, defaultMode = 'login' }: AuthPageProps) {
  const [mode, setMode] = useState<'login' | 'register'>(defaultMode);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 提交表单：按当前模式调用登录或注册。 */
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const user = mode === 'login' ? await login(username, password) : await register(username, password);
      onAuthed(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  };

  /** 切换模式时清空错误提示，保留已输入的用户名。 */
  const switchMode = (next: 'login' | 'register') => {
    setMode(next);
    setError(null);
  };

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={(event) => void submit(event)}>
        {onBack && (
          <button className="auth-back" type="button" onClick={onBack}>
            <Icon name="back" size={14} />
            稍后再说，先继续体验
          </button>
        )}
        <div className="auth-brand">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <div>
            <strong>3d-slide</strong>
            <span>空间演示 · 账号工作区</span>
          </div>
        </div>

        <div className="auth-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'login'}
            className={mode === 'login' ? 'is-active' : ''}
            onClick={() => switchMode('login')}
          >
            登录
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'register'}
            className={mode === 'register' ? 'is-active' : ''}
            onClick={() => switchMode('register')}
          >
            注册
          </button>
        </div>

        <label className="auth-field">
          <span>用户名</span>
          <input
            className="text-input"
            autoFocus
            autoComplete="username"
            maxLength={24}
            placeholder="2–24 个字符"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </label>

        <label className="auth-field">
          <span>密码</span>
          <input
            className="text-input"
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            maxLength={64}
            placeholder="至少 6 个字符"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        {error && (
          <p className="auth-error" role="alert">
            <Icon name="alert" size={14} />
            {error}
          </p>
        )}

        <button className="btn btn-primary btn-block auth-submit" type="submit" disabled={busy}>
          {busy ? '处理中…' : mode === 'login' ? '登录' : '注册并保留数据'}
        </button>

        <p className="auth-hint">
          {mode === 'register'
            ? '注册后当前临时会话的作品、素材与文件会原地保留，无需重新上传。第一个正式注册的账号会自动成为管理员。'
            : '使用已有账号登录后，会切换到该账号的工作区；当前访客数据会留在临时会话中。'}
        </p>
      </form>
      <p className="auth-foot">3d-slide · P0 MVP</p>
    </div>
  );
}
