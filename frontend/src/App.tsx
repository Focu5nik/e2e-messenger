import { useEffect, useState } from 'react'

type Health = 'checking' | 'online' | 'offline'

function App() {
  const [health, setHealth] = useState<Health>('checking')

  useEffect(() => {
    const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'
    fetch(`${apiUrl}/health`)
      .then((response) => {
        if (!response.ok) throw new Error('Backend is unavailable')
        setHealth('online')
      })
      .catch(() => setHealth('offline'))
  }, [])

  return (
    <main>
      <h1>Secure Messenger</h1>
      <p>Project skeleton is ready.</p>
      <p>Backend status: <strong>{health}</strong></p>
    </main>
  )
}

export default App
