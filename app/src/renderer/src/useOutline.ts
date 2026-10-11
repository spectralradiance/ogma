import { useEffect, useMemo, useState } from 'react'

import { type SectionSummary, summarizeSections } from '../../shared/document'
import { folderName } from '../../shared/format'
import { samePath } from '../../shared/paths'
import { onDiskChange, touchesFile } from './changes'
import type { OpenTarget } from './target'

export interface Outline {
  title: string
  path: string
  sections: SectionSummary[]
}

async function loadOutline(path: string): Promise<Outline> {
  const document = await window.ogma.files.read(path, { allowMissing: true }).catch(() => null)
  return { title: folderName(path), path, sections: document && document.mtimeMs !== null ? summarizeSections(document.text) : [] }
}

/**
 * The open document's outline: read from disk, kept current while you type (the
 * open editor reports its sections), and reloaded when the file changes on disk.
 */
export function useOutline(target: OpenTarget | null, liveSections: Record<string, SectionSummary[]>, reloadToken: number): Outline | null {
  const path = target?.path ?? ''
  const [loaded, setLoaded] = useState<Outline | null>(null)
  const [diskToken, setDiskToken] = useState(0)

  useEffect(() => {
    if (!path) return
    let alive = true
    void loadOutline(path).then((outline) => {
      if (alive) setLoaded(outline)
    })
    return () => {
      alive = false
    }
  }, [path, reloadToken, diskToken])

  useEffect(() => {
    if (!path) return
    return onDiskChange((paths) => {
      if (touchesFile(paths, path)) setDiskToken((token) => token + 1)
    })
  }, [path])

  return useMemo(() => {
    if (!loaded || !samePath(loaded.path, path)) return null
    const live = Object.keys(liveSections).find((candidate) => samePath(candidate, path))
    return live ? { ...loaded, sections: liveSections[live] } : loaded
  }, [loaded, path, liveSections])
}
