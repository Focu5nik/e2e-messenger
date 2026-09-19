import type { DeviceIdentity } from '../domain/models.ts'
import { ClientError } from '../domain/errors.ts'
import type { DeviceDescription, DeviceIdentityStore, IdGenerator } from '../ports/platform.ts'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isDeviceIdentity(value: unknown): value is DeviceIdentity {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<DeviceIdentity>
  return typeof candidate.id === 'string'
    && UUID_PATTERN.test(candidate.id)
    && typeof candidate.name === 'string'
    && candidate.name.trim().length > 0
    && candidate.name.length <= 100
}

export class DeviceIdentityService {
  private readonly store: DeviceIdentityStore
  private readonly createId: IdGenerator
  private readonly describeDevice: DeviceDescription
  private pending: Promise<unknown> = Promise.resolve()

  constructor(store: DeviceIdentityStore, createId: IdGenerator, describeDevice: DeviceDescription) {
    this.store = store
    this.createId = createId
    this.describeDevice = describeDevice
  }

  get(): Promise<DeviceIdentity> {
    return this.enqueue(async () => {
      const stored = await this.store.read()
      return isDeviceIdentity(stored) ? stored : this.create()
    })
  }

  replace(): Promise<DeviceIdentity> {
    return this.enqueue(() => this.create())
  }

  private async create(): Promise<DeviceIdentity> {
    const identity = { id: this.createId(), name: await this.describeDevice() }
    try {
      await this.store.write(identity)
    } catch (error) {
      // Another browser tab may have initialized/replaced this generation first.
      if (!(error instanceof ClientError) || error.code !== 'local_generation_changed') throw error
      const winner = await this.store.read()
      if (isDeviceIdentity(winner) && winner.id !== identity.id) return winner
      throw error
    }
    return identity
  }

  // Concurrent restoration and replacement must not produce competing identities.
  private enqueue(operation: () => Promise<DeviceIdentity>): Promise<DeviceIdentity> {
    const result = this.pending.then(operation)
    this.pending = result.catch(() => {})
    return result
  }
}
