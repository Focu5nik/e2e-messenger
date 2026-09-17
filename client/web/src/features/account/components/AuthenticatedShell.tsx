import { useState } from 'react'
import { useSessionStore } from '../../../shared/application/clientContext'
import {
  type CurrentUser,
  type Device,
} from '@secure-messenger/client-core'
import { ChatWorkspace } from '../../chats'

type AuthenticatedShellProps = {
  user: CurrentUser
  health: 'checking' | 'online' | 'offline'
  onCheckHealth: () => void
}

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export function AuthenticatedShell({
  user,
  health,
  onCheckHealth,
}: AuthenticatedShellProps) {
  const [view, setView] = useState<'chats' | 'account'>('chats')
  const { devices, busyDeviceId, accountError: error, signingOut, revokeDevice, logout } = useSessionStore((state) => state)

  function confirmRevokeDevice(device: Device) {
    const action = device.isCurrent ? 'revoke this device and sign out' : `revoke ${device.name}`
    if (!window.confirm(`Are you sure you want to ${action}?`)) return

    void revokeDevice(device.id)
  }

  return (
    <main className="shell">
      <header className="app-header">
        <div className="brand-inline">
          <div className="brand-mark small" aria-hidden="true">S</div>
          <div><strong>Secure Messenger</strong><small>Private by design</small></div>
        </div>
        <nav className="primary-nav" aria-label="Main navigation">
          <button
            type="button"
            className={view === 'chats' ? 'active' : ''}
            aria-current={view === 'chats' ? 'page' : undefined}
            onClick={() => setView('chats')}
          >
            Chats
          </button>
          <button
            type="button"
            className={view === 'account' ? 'active' : ''}
            aria-current={view === 'account' ? 'page' : undefined}
            onClick={() => setView('account')}
          >
            Account &amp; devices
          </button>
        </nav>
        <div className="header-actions">
          <button className={`health-status inline ${health}`} type="button" onClick={onCheckHealth}>
            <span aria-hidden="true" /> Backend {health}
          </button>
          <button className="secondary-button" type="button" disabled={signingOut} onClick={logout}>
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </header>

      <div hidden={view !== 'chats'}>
        <ChatWorkspace user={user} />
      </div>
      {view === 'account' && (
        <div className="content-grid">
          <aside className="profile-card" aria-labelledby="profile-heading">
            <div className="avatar" aria-hidden="true">{user.username.slice(0, 1).toUpperCase()}</div>
            <p className="eyebrow">Signed in as</p>
            <h1 id="profile-heading">{user.username}</h1>
            <span className="status-pill">{user.status}</span>
            <dl>
              <div><dt>User ID</dt><dd>{user.id}</dd></div>
              <div><dt>Member since</dt><dd>{formatDate(user.createdAt)}</dd></div>
            </dl>
          </aside>

          <section className="devices-card" aria-labelledby="devices-heading">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Account security</p>
                <h2 id="devices-heading">Your devices</h2>
              </div>
              <span className="count-pill">{devices.filter((device) => !device.revokedAt).length} active</span>
            </div>
            <p className="section-description">
              Review browsers signed in to your account. Revoking a device ends all of its sessions.
            </p>

            {error && <p className="form-error" role="alert">{error}</p>}

            <ul className="device-list">
              {devices.map((device) => (
                <li key={device.id} className={device.revokedAt ? 'revoked' : ''}>
                  <div className="device-icon" aria-hidden="true">▣</div>
                  <div className="device-info">
                    <div className="device-title">
                      <strong>{device.name}</strong>
                      {device.isCurrent && <span className="current-pill">This device</span>}
                      {device.revokedAt && <span className="revoked-pill">Revoked</span>}
                    </div>
                    <span>Last active {formatDate(device.lastSeenAt)}</span>
                    <small>Added {formatDate(device.createdAt)} · Protocol v{device.protocolVersion}</small>
                  </div>
                  {!device.revokedAt && (
                    <button
                      className="danger-button"
                      type="button"
                      disabled={busyDeviceId !== null}
                      onClick={() => confirmRevokeDevice(device)}
                      aria-label={`Revoke ${device.name}${device.isCurrent ? ', this device' : ''}`}
                    >
                      {busyDeviceId === device.id ? 'Revoking…' : 'Revoke'}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </main>
  )
}
