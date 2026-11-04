/**
 * UsersPage.tsx —— 管理员用户管理页
 *
 * 职责：
 * - 列出全部账号（用户名、角色、创建时间）；
 * - 删除其他账号，删除时会级联清理该用户的作品、素材与 MinIO 对象；
 * - 当前登录账号不可删除，服务端还会兜底阻止删除最后一个管理员。
 */

import { useEffect, useState } from 'react';
import { deleteUser, fetchUsers, type SessionUser } from '../lib/api';
import { formatStamp } from '../lib/file';
import { toast } from '../store/uiStore';
import { Icon } from './Icon';
import { ConfirmDialog } from './ui';

interface UsersPageProps {
  /** 当前登录账号（用于标记「我」并禁止自删）。 */
  current: SessionUser;
  /** 返回首页。 */
  onBack: () => void;
}

/**
 * 用户管理页。
 * @param current 当前账号
 * @param onBack 返回首页
 */
export function UsersPage({ current, onBack }: UsersPageProps) {
  const [users, setUsers] = useState<SessionUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SessionUser | null>(null);

  /** 拉取账号列表；失败时展示错误并允许重试。 */
  const load = async () => {
    try {
      setError(null);
      setUsers(await fetchUsers());
    } catch (err) {
      setError(err instanceof Error ? err.message : '用户列表读取失败');
      setUsers([]);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  /** 确认删除：成功后刷新列表。 */
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteUser(deleteTarget.id);
      toast(`已删除用户「${deleteTarget.username}」`, 'success');
      setDeleteTarget(null);
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除失败', 'error');
    }
  };

  return (
    <div className="home user-page">
      <header className="home-top">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="brand-name">3d-slide</span>
          <span className="brand-tag">用户管理</span>
        </div>
        <div className="home-actions">
          <button className="btn btn-ghost" onClick={onBack}>
            <Icon name="back" size={16} />
            返回首页
          </button>
        </div>
      </header>

      <main className="home-main">
        <section className="deck-section user-section">
          <div className="deck-section-head">
            <h2>账号</h2>
            <span>{users?.length ?? '—'} 个账号 · 删除会同时清理该用户的数据</span>
          </div>

          {error ? (
            <section className="home-empty">
              <h2>无法读取用户列表</h2>
              <p>{error}</p>
              <div className="empty-actions">
                <button className="btn btn-ghost" onClick={() => void load()}>
                  <Icon name="reset" size={16} />
                  重试
                </button>
              </div>
            </section>
          ) : users === null ? (
            <div className="user-list">
              {[0, 1, 2].map((key) => (
                <div className="user-row user-row-skeleton" key={key}>
                  <span className="sku" />
                </div>
              ))}
            </div>
          ) : (
            <div className="user-list">
              {users.map((user) => {
                const isSelf = user.id === current.id;
                return (
                  <div className="user-row" key={user.id}>
                    <div className="user-main">
                      <strong>{user.username}</strong>
                      <span className={`user-role ${user.role === 'admin' ? 'is-admin' : ''}`}>
                        {user.role === 'admin' ? '管理员' : '成员'}
                      </span>
                      {isSelf && <span className="user-self">当前账号</span>}
                    </div>
                    <div className="user-meta">
                      <span>注册于 {formatStamp(user.createdAt)}</span>
                      <button
                        className="icon-btn is-danger"
                        aria-label="删除用户"
                        title={isSelf ? '不能删除当前登录账号' : '删除用户'}
                        disabled={isSelf}
                        onClick={() => setDeleteTarget(user)}
                      >
                        <Icon name="trash" size={15} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </main>

      <footer className="home-foot">
        <span>3d-slide · 管理员控制台</span>
        <span>删除账号不可恢复 · 请谨慎操作</span>
      </footer>

      {deleteTarget && (
        <ConfirmDialog
          title="删除这个用户？"
          danger
          confirmLabel="删除账号"
          message={
            <>
              将永久删除用户「<b>{deleteTarget.username}</b>」，并清理其全部作品、素材与文件。
              该操作无法恢复。
            </>
          }
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </div>
  );
}
