import { createStore } from 'zustand/vanilla'
import type { DeviceIdentityService } from './deviceIdentity.ts'
import { ClientError } from '../domain/errors.ts'
import type { CurrentUser, Device, DeviceIdentity } from '../domain/models.ts'
import type { AccountGateway, SessionGateway } from '../ports/gateways.ts'

export type SessionStoreDependencies = {
  session: SessionGateway
  account: AccountGateway
  identities: Pick<DeviceIdentityService, 'get' | 'replace'>
}

export type SessionState = {
  phase: 'restoring' | 'anonymous' | 'authenticated'
  user: CurrentUser | null
  devices: Device[]
  deviceIdentity: DeviceIdentity | null
  authError: string | null
  accountError: string | null
  submitting: boolean
  signingOut: boolean
  busyDeviceId: string | null
  // Restore also connects session events; it can reconnect after dispose.
  restore(): Promise<void>
  login(username: string, password: string): Promise<void>
  // Reports registration success even if the subsequent login fails.
  register(username: string, password: string): Promise<boolean>
  refreshDevices(): Promise<void>
  revokeDevice(deviceId: string): Promise<void>
  logout(): Promise<void>
  clearAuthError(): void
  dispose(): void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.'
}

export function createSessionStore({ session, account, identities }: SessionStoreDependencies) {
  let active = false
  let generation = 0
  let devicesRevision = 0
  let unsubscribe: (() => void) | undefined

  return createStore<SessionState>()((set, get) => {
    const isCurrent = (operation: number) => active && operation === generation

    function clearAuthenticatedState(authError: string | null = null) {
      generation += 1
      set({
        phase: 'anonymous', user: null, devices: [], authError, accountError: null,
        submitting: false, signingOut: false, busyDeviceId: null,
      })
    }

    async function loadAccount(operation: number) {
      const [user, devices] = await Promise.all([account.getCurrentUser(), account.getDevices()])
      if (isCurrent(operation)) set({ user, devices, authError: null, phase: 'authenticated' })
    }

    async function authenticate(username: string, password: string, registering: boolean): Promise<boolean> {
      if (!active || get().phase !== 'anonymous' || get().submitting || get().signingOut) return false
      const operation = ++generation
      let registered = false
      set({ submitting: true, authError: null })
      try {
        const normalizedUsername = username.trim()
        if (registering) {
          await session.register(normalizedUsername, password)
          if (!isCurrent(operation)) return false
          registered = true
        }
        const device = get().deviceIdentity ?? await identities.get()
        if (!isCurrent(operation)) return false
        set({ deviceIdentity: device })
        try {
          await session.login(normalizedUsername, password, device)
        } catch (error) {
          if (!isCurrent(operation)) return false
          if (!(error instanceof ClientError) || error.code !== 'device_revoked') throw error
          const replacement = await identities.replace()
          if (!isCurrent(operation)) return false
          set({ deviceIdentity: replacement })
          await session.login(normalizedUsername, password, replacement)
        }
        if (!isCurrent(operation)) return false
        await loadAccount(operation)
      } catch (error) {
        if (isCurrent(operation)) set({ authError: errorMessage(error) })
      } finally {
        if (isCurrent(operation)) set({ submitting: false })
      }
      return isCurrent(operation) && registered
    }

    async function signOut(revoked: boolean) {
      if (!active || get().signingOut) return
      // Invalidate pending restoration, login, and account requests immediately.
      const operation = ++generation
      set({ signingOut: true, submitting: false, busyDeviceId: null, accountError: null })
      let warning: string | null = null
      try {
        await session.logout()
      } catch (error) {
        warning = revoked
          ? `Device revoked, but its browser cookie could not be cleared: ${errorMessage(error)}`
          : `The server could not confirm sign-out. Reconnect and sign out again: ${errorMessage(error)}`
      }
      if (isCurrent(operation)) clearAuthenticatedState(warning)
    }

    return {
      phase: 'restoring', user: null, devices: [], deviceIdentity: null,
      authError: null, accountError: null, submitting: false, signingOut: false, busyDeviceId: null,

      async restore() {
        active = true
        const operation = ++generation
        unsubscribe ??= session.onSessionExpired(() => {
          if (active) clearAuthenticatedState('Your session has ended. Please sign in again.')
        })
        set({
          phase: 'restoring', user: null, devices: [], authError: null, accountError: null,
          submitting: false, signingOut: false, busyDeviceId: null,
        })
        try {
          const deviceIdentity = await identities.get()
          if (!isCurrent(operation)) return
          set({ deviceIdentity })
          const restored = await session.restoreSession()
          if (!isCurrent(operation)) return
          if (restored) await loadAccount(operation)
          else clearAuthenticatedState()
        } catch (error) {
          if (isCurrent(operation)) clearAuthenticatedState(errorMessage(error))
        }
      },

      async login(username, password) { await authenticate(username, password, false) },
      register: (username, password) => authenticate(username, password, true),

      async refreshDevices() {
        if (!active || get().phase !== 'authenticated' || get().signingOut) return
        const operation = generation
        const revision = ++devicesRevision
        set({ accountError: null })
        try {
          const devices = await account.getDevices()
          if (isCurrent(operation) && revision === devicesRevision) set({ devices })
        } catch (error) {
          if (isCurrent(operation) && revision === devicesRevision) set({ accountError: errorMessage(error) })
        }
      },

      async revokeDevice(deviceId) {
        if (!active || get().phase !== 'authenticated' || get().busyDeviceId || get().signingOut) return
        const device = get().devices.find((candidate) => candidate.id === deviceId)
        if (!device || device.revokedAt) return
        const operation = generation
        devicesRevision += 1
        set({ accountError: null, busyDeviceId: deviceId })
        try {
          await account.revokeDevice(deviceId)
          if (!isCurrent(operation)) return
          if (device.isCurrent) await signOut(true)
          else await get().refreshDevices()
        } catch (error) {
          if (isCurrent(operation)) set({ accountError: errorMessage(error) })
        } finally {
          if (isCurrent(operation)) set({ busyDeviceId: null })
        }
      },

      logout: () => signOut(false),
      clearAuthError() { set({ authError: null }) },
      dispose() {
        active = false
        generation += 1
        unsubscribe?.()
        unsubscribe = undefined
      },
    }
  })
}

export type SessionStore = ReturnType<typeof createSessionStore>
