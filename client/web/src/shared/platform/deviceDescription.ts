import type { DeviceDescription } from '@secure-messenger/client-core'

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

export const browserDeviceDescription: DeviceDescription = async () => {
  const userAgent = navigator.userAgent
  return operatingSystem(userAgent) + ' · ' + browserName(userAgent)
}
