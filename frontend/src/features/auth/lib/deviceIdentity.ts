export type DeviceIdentity = {
  id: string
  name: string
}

const DEVICE_STORAGE_KEY = 'messenger.device'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function browserName(userAgent: string): string {
  if (userAgent.includes('Edg/')) return 'Edge'
  if (userAgent.includes('Firefox/')) return 'Firefox'
  if (userAgent.includes('Chrome/')) return 'Chrome'
  if (userAgent.includes('Safari/')) return 'Safari'
  return 'Browser'
}

function operatingSystem(userAgent: string): string {
  if (userAgent.includes('Windows')) return 'Windows'
  if (userAgent.includes('Android')) return 'Android'
  if (userAgent.includes('iPhone') || userAgent.includes('iPad')) return 'iOS'
  if (userAgent.includes('Mac OS')) return 'macOS'
  if (userAgent.includes('Linux')) return 'Linux'
  return 'Unknown device'
}

function createDeviceIdentity(): DeviceIdentity {
  const userAgent = navigator.userAgent

  return {
    id: crypto.randomUUID(),
    name: `${operatingSystem(userAgent)} · ${browserName(userAgent)}`,
  }
}

export function replaceDeviceIdentity(): DeviceIdentity {
  const identity = createDeviceIdentity()
  localStorage.setItem(DEVICE_STORAGE_KEY, JSON.stringify(identity))
  return identity
}

function isDeviceIdentity(value: unknown): value is DeviceIdentity {
  if (typeof value !== 'object' || value === null) return false

  const candidate = value as Partial<DeviceIdentity>
  return (
    typeof candidate.id === 'string'
    && UUID_PATTERN.test(candidate.id)
    && typeof candidate.name === 'string'
    && candidate.name.trim().length > 0
    && candidate.name.length <= 100
  )
}

export function getDeviceIdentity(): DeviceIdentity {
  const storedIdentity = localStorage.getItem(DEVICE_STORAGE_KEY)

  if (storedIdentity) {
    try {
      const parsedIdentity: unknown = JSON.parse(storedIdentity)
      if (isDeviceIdentity(parsedIdentity)) return parsedIdentity
    } catch {
      // Replace malformed local data with a new stable identity.
    }
  }

  return replaceDeviceIdentity()
}
