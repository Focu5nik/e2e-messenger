import { useCallback, useEffect, useState } from 'react'
import { useWebClient } from './clientContext'

export function useBackendHealth() {
  const { checkHealth } = useWebClient()
  const [health, setHealth] = useState<'checking' | 'online' | 'offline'>('checking')
  const refreshHealth = useCallback(() => {
    setHealth('checking')
    void checkHealth().then((isOnline) => setHealth(isOnline ? 'online' : 'offline'))
  }, [checkHealth])

  useEffect(() => { refreshHealth() }, [refreshHealth])

  return { health, refreshHealth }
}
