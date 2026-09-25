import { posix, win32 } from 'node:path'

function comparable(path: string, platform: NodeJS.Platform): string {
  const pathApi = platform === 'win32' ? win32 : posix
  const normalized = pathApi.normalize(path).replace(/[\\/]+$/, '')
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  return comparable(a, platform) === comparable(b, platform)
}

export function addRoot(roots: string[], candidate: string, platform: NodeJS.Platform): string[] {
  return roots.some((root) => samePath(root, candidate, platform)) ? roots : [...roots, candidate]
}

export function removeRoot(roots: string[], target: string, platform: NodeJS.Platform): string[] {
  return roots.filter((root) => !samePath(root, target, platform))
}
