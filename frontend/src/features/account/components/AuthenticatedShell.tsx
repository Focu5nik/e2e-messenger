import { useState } from 'react'
import {
  getErrorMessage,
  type ApiClient,
  type CurrentUser,
  type Device,
} from '../../../shared/api'
import { ChatWorkspace } from '../../chats'

type AuthenticatedShellProps = {
  api: ApiClient
  user: CurrentUser
  devices: Device[]
  health: 'checking' | 'online' | 'offline'
  onDevicesChanged: () => Promise<void>
  onSignedOut: (message?: string) => void
  onCheckHealth: () => void
}

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export function AuthenticatedShell({
  api,
  user,
  devices,
  health,
  onDevicesChanged,
  onSignedOut,
  onCheckHealth,
}: AuthenticatedShellProps) {
  const [view, setView] = useState<'chats' | 'account'>('chats')
  const [busyDeviceId, setBusyDeviceId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [signingOut, setSigningOut] = useState(false)

  async function revokeDevice(device: Device) {
    const action = device.is_current ? 'revoke this device and sign out' : `revoke ${device.name}`
    if (!window.confirm(`Are you sure you want to ${action}?`)) return

    setError(null)
    setBusyDeviceId(device.id)

    try {
      await api.revokeDevice(device.id)
      if (device.is_current) {
        try {
          await api.logout()
          onSignedOut()
        } catch (logoutError) {
          onSignedOut(
            `Device revoked, but its browser cookie could not be cleared: ${getErrorMessage(logoutError)}`,
          )
        }
      } else {
        await onDevicesChanged()
      }
    } catch (revokeError) {
      setError(getErrorMessage(revokeError))
    } finally {
      setBusyDeviceId(null)
    }
  }

  async function signOut() {
    setError(null)
    setSigningOut(true)

    try {
      await api.logout()
      onSignedOut()
    } catch (logoutError) {
      onSignedOut(
        `The server could not confirm sign-out. Reconnect and sign out again: ${getErrorMessage(logoutError)}`,
      )
    } finally {
      setSigningOut(false)
    }
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
          <button className="secondary-button" type="button" disabled={signingOut} onClick={signOut}>
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </header>

      <div hidden={view !== 'chats'}>
        <ChatWorkspace api={api} user={user} />
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
              <div><dt>Member since</dt><dd>{formatDate(user.created_at)}</dd></div>
            </dl>
          </aside>

          <section className="devices-card" aria-labelledby="devices-heading">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Account security</p>
                <h2 id="devices-heading">Your devices</h2>
              </div>
              <span className="count-pill">{devices.filter((device) => !device.revoked_at).length} active</span>
            </div>
            <p className="section-description">
              Review browsers signed in to your account. Revoking a device ends all of its sessions.
            </p>

            {error && <p className="form-error" role="alert">{error}</p>}

            <ul className="device-list">
              {devices.map((device) => (
                <li key={device.id} className={device.revoked_at ? 'revoked' : ''}>
                  <div className="device-icon" aria-hidden="true">▣</div>
                  <div className="device-info">
                    <div className="device-title">
                      <strong>{device.name}</strong>
                      {device.is_current && <span className="current-pill">This device</span>}
                      {device.revoked_at && <span className="revoked-pill">Revoked</span>}
                    </div>
                    <span>Last active {formatDate(device.last_seen_at)}</span>
                    <small>Added {formatDate(device.created_at)} · Protocol v{device.protocol_version}</small>
                  </div>
                  {!device.revoked_at && (
                    <button
                      className="danger-button"
                      type="button"
                      disabled={busyDeviceId !== null}
                      onClick={() => revokeDevice(device)}
                      aria-label={`Revoke ${device.name}${device.is_current ? ', this device' : ''}`}
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
