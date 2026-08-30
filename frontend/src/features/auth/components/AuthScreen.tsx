import { useState, type FormEvent } from 'react'
import { ApiError, getErrorMessage, type ApiClient } from '../../../shared/api'
import type { DeviceIdentity } from '../lib/deviceIdentity'

type AuthMode = 'login' | 'register'

type AuthScreenProps = {
  api: ApiClient
  device: DeviceIdentity
  onReplaceDevice: () => DeviceIdentity
  initialError: string | null
  health: 'checking' | 'online' | 'offline'
  onAuthenticated: () => Promise<void>
  onCheckHealth: () => void
}

export function AuthScreen({
  api,
  device,
  onReplaceDevice,
  initialError,
  health,
  onAuthenticated,
  onCheckHealth,
}: AuthScreenProps) {
  const [mode, setMode] = useState<AuthMode>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(initialError)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)

    try {
      const normalizedUsername = username.trim()
      if (mode === 'register') {
        await api.register(normalizedUsername, password)
        setMode('login')
      }
      try {
        await api.login(normalizedUsername, password, device)
      } catch (loginError) {
        if (
          !(loginError instanceof ApiError)
          || loginError.status !== 403
          || loginError.message !== 'device is revoked'
        ) {
          throw loginError
        }

        await api.login(normalizedUsername, password, onReplaceDevice())
      }
      await onAuthenticated()
    } catch (submitError) {
      setError(getErrorMessage(submitError))
    } finally {
      setSubmitting(false)
    }
  }

  function selectMode(nextMode: AuthMode) {
    setMode(nextMode)
    setError(null)
  }

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="brand-mark" aria-hidden="true">S</div>
        <p className="eyebrow">Secure Messenger</p>
        <h1 id="auth-title">{mode === 'login' ? 'Welcome back' : 'Create your account'}</h1>
        <p className="auth-intro">
          {mode === 'login'
            ? 'Sign in to continue on this device.'
            : 'Your account will be linked to this browser as a trusted device.'}
        </p>

        <div className="auth-tabs" role="tablist" aria-label="Authentication mode">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'login'}
            className={mode === 'login' ? 'active' : ''}
            onClick={() => selectMode('login')}
          >
            Sign in
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'register'}
            className={mode === 'register' ? 'active' : ''}
            onClick={() => selectMode('register')}
          >
            Register
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <label htmlFor="username">Username</label>
          <input
            id="username"
            name="username"
            type="text"
            autoComplete="username"
            minLength={3}
            maxLength={64}
            required
            autoFocus
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />

          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            minLength={8}
            maxLength={128}
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />

          {error && <p className="form-error" role="alert">{error}</p>}

          <button className="primary-button" type="submit" disabled={submitting}>
            {submitting ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <div className="device-note">
          <span className="device-dot" aria-hidden="true" />
          <span><strong>This device</strong><small>{device.name}</small></span>
        </div>
      </section>

      <button className={`health-status ${health}`} type="button" onClick={onCheckHealth}>
        <span aria-hidden="true" /> Backend {health}
      </button>
    </main>
  )
}
