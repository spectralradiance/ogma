import { mkdir, mkdtemp, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  BackupStore,
  OutsideWorkspaceError,
  PathGuard,
  isInside,
  isTextFileName,
  listDirectory,
  readTextDocument,
  writeTextDocument,
} from './fileService'

async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), 'ogma-files-'))
  const backups = path.join(await mkdtemp(path.join(tmpdir(), 'ogma-backups-')), 'backups')
  const guard = new PathGuard(() => [root])
  return { root, backups, guard, store: new BackupStore(backups, guard) }
}

describe('isTextFileName', () => {
  it('accepts Markdown, text and extensionless notes', () => {
    for (const name of ['a.md', 'b.markdown', 'c.TXT', 'outline', '1 the first era', '1.2 the solar system', '2.1']) {
      expect(isTextFileName(name), name).toBe(true)
    }
  })

  it('rejects other extensions and hidden files', () => {
    for (const name of ['photo.png', 'doc.pdf', 'script.py', '.hidden', 'notes.docx']) {
      expect(isTextFileName(name), name).toBe(false)
    }
  })
})

describe('PathGuard', () => {
  const guard = new PathGuard(() => ['C:\\Notes'], path.win32)

  it('allows paths inside a root, case-insensitively on Windows', () => {
    expect(guard.resolve('c:\\notes\\poetry\\a.md')).toBe('c:\\notes\\poetry\\a.md')
    expect(isInside('C:\\Notes', 'C:\\Notes', path.win32)).toBe(true)
  })

  it('rejects escapes and relative paths', () => {
    expect(() => guard.resolve('C:\\Notes\\..\\Windows\\system.ini')).toThrow(OutsideWorkspaceError)
    expect(() => guard.resolve('C:\\NotesExtra\\a.md')).toThrow(OutsideWorkspaceError)
    expect(() => guard.resolve('poetry\\a.md')).toThrow(TypeError)
    expect(() => guard.resolve(42)).toThrow(TypeError)
  })
})

describe('listDirectory', () => {
  it('lists folders first, then text files in natural order', async () => {
    const { root } = await workspace()
    await mkdir(path.join(root, 'chapters'))
    await mkdir(path.join(root, '.git'))
    await mkdir(path.join(root, 'node_modules'))
    for (const name of ['10 ten', '2 two', 'outline', 'image.png', '.hidden.md', 'a.md']) {
      await writeFile(path.join(root, name), 'x')
    }
    const names = (await listDirectory(root)).map((entry) => entry.name)
    expect(names).toEqual(['chapters', '2 two', '10 ten', 'a.md', 'outline'])
  })
})

describe('writeTextDocument', () => {
  it('saves in the original format, backs up the original once, and leaves no temp files', async () => {
    const { root, backups, store } = await workspace()
    const file = path.join(root, 'old notes.txt')
    const original = Buffer.from([0x49, 0x92, 0x6d, 0x0d, 0x0a])
    await writeFile(file, original)

    const document = await readTextDocument(file)
    expect(document.text).toBe('I’m\n')

    const first = await writeTextDocument(file, {
      path: file, text: 'I’m here\n', format: document.format, expectedMtimeMs: document.mtimeMs,
    }, store)
    expect(first.ok).toBe(true)
    expect(await readFile(file)).toEqual(Buffer.from([0x49, 0x92, 0x6d, 0x20, 0x68, 0x65, 0x72, 0x65, 0x0d, 0x0a]))
    if (!first.ok) return

    await writeTextDocument(file, {
      path: file, text: 'again\n', format: first.format, expectedMtimeMs: first.mtimeMs,
    }, store)

    const [session] = await readdir(backups)
    const backup = path.join(backups, session, path.basename(root), 'old notes.txt')
    expect(await readFile(backup)).toEqual(original)
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('creates a missing file only when it is still missing', async () => {
    const { root, store } = await workspace()
    const file = path.join(root, '1 intro-output.md')
    const missing = await readTextDocument(file, true)
    expect(missing).toMatchObject({ text: '', mtimeMs: null })
    await expect(readTextDocument(file)).rejects.toThrow()

    const request = { path: file, text: 'draft\n', format: missing.format, expectedMtimeMs: null }
    expect((await writeTextDocument(file, request, store)).ok).toBe(true)
    expect(await readFile(file, 'utf8')).toBe('draft\n')
    // A second "create" means someone else made the file in the meantime.
    expect(await writeTextDocument(file, request, store)).toMatchObject({ ok: false, reason: 'conflict' })
  })

  it('reports a conflict when the file changed on disk, and overwrites only when forced', async () => {
    const { root, store } = await workspace()
    const file = path.join(root, 'a.md')
    await writeFile(file, 'mine')
    const document = await readTextDocument(file)

    await writeFile(file, 'theirs')
    const later = new Date(Date.now() + 5000)
    await utimes(file, later, later)

    const request = { path: file, text: 'mine, edited', format: document.format, expectedMtimeMs: document.mtimeMs }
    const conflict = await writeTextDocument(file, request, store)
    expect(conflict).toMatchObject({ ok: false, reason: 'conflict', diskMtimeMs: (await stat(file)).mtimeMs })
    expect(await readFile(file, 'utf8')).toBe('theirs')

    const forced = await writeTextDocument(file, { ...request, force: true }, store)
    expect(forced.ok).toBe(true)
    expect(await readFile(file, 'utf8')).toBe('mine, edited')
  })
})
