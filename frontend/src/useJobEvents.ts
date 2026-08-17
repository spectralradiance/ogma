import { useEffect, useState } from 'react'
import { api } from './api'
import type { Job } from './types'

export function useJobEvents(jobId: string | null) {
  const [snapshot, setSnapshot] = useState<{ id: string; job: Job } | null>(null)

  useEffect(() => {
    if (!jobId) return
    const source = new EventSource(api.eventsUrl(jobId))
    source.onmessage = (event) => setSnapshot({ id: jobId, job: JSON.parse(event.data) as Job })
    source.onerror = () => source.close()
    return () => source.close()
  }, [jobId])

  return snapshot?.id === jobId ? snapshot.job : null
}
