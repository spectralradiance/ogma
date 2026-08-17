import { useEffect, useState } from 'react'
import { api } from './api'
import type { Job } from './types'

export function useJobEvents(jobId: string | null) {
  // Store the source job ID beside the payload. When users switch drawers, an
  // old EventSource snapshot cannot briefly appear under the newly selected job.
  const [snapshot, setSnapshot] = useState<{ id: string; job: Job } | null>(null)

  useEffect(() => {
    if (!jobId) return
    // EventSource reconnects automatically during transient server/network loss.
    // The backend sends complete snapshots, so no client-side log merging is needed.
    const source = new EventSource(api.eventsUrl(jobId))
    source.onmessage = (event) => setSnapshot({ id: jobId, job: JSON.parse(event.data) as Job })
    source.onerror = () => source.close()
    return () => source.close()
  }, [jobId])

  return snapshot?.id === jobId ? snapshot.job : null
}
