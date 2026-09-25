import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { SECRET_NAMES, type SecretName } from '../shared/ai'

export interface Cipher {
  available(): boolean
  encrypt(plain: string): Buffer
  decrypt(encrypted: Buffer): string
}

/**
 * API keys, encrypted with the OS (Electron safeStorage uses DPAPI on Windows)
 * in <userData>/keys.json. Values leave this class only as environment
 * variables for the sidecar; the renderer only ever learns whether a key is set.
 */
export class SecretStore {
  private readonly path: string
  private readonly cipher: Cipher
  private stored: Partial<Record<SecretName, string>>

  constructor(path: string, cipher: Cipher) {
    this.path = path
    this.cipher = cipher
    this.stored = this.load()
  }

  status(): { name: SecretName; set: boolean }[] {
    return SECRET_NAMES.map((name) => ({ name, set: Boolean(this.stored[name]) }))
  }

  set(name: SecretName, value: string | null): void {
    if (!SECRET_NAMES.includes(name)) throw new Error(`Unknown key ${name}`)
    const trimmed = value?.trim() ?? ''
    if (trimmed) {
      if (!this.cipher.available()) throw new Error('This system cannot encrypt keys, so they will not be stored.')
      this.stored[name] = this.cipher.encrypt(trimmed).toString('base64')
    } else {
      delete this.stored[name]
    }
    this.save()
  }

  /** Decrypted keys as environment variables. Unreadable entries are skipped. */
  env(): Record<string, string> {
    const env: Record<string, string> = {}
    for (const name of SECRET_NAMES) {
      const encrypted = this.stored[name]
      if (!encrypted) continue
      try {
        env[name] = this.cipher.decrypt(Buffer.from(encrypted, 'base64'))
      } catch {
        // Encrypted by another user or machine: treat as unset.
      }
    }
    return env
  }

  private load(): Partial<Record<SecretName, string>> {
    if (!existsSync(this.path)) return {}
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, unknown>
      const result: Partial<Record<SecretName, string>> = {}
      for (const name of SECRET_NAMES) {
        if (typeof raw[name] === 'string') result[name] = raw[name] as string
      }
      return result
    } catch {
      return {}
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, JSON.stringify(this.stored, null, 2), 'utf8')
    renameSync(temporary, this.path)
  }
}
