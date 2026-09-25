import { describe, expect, it } from 'vitest'

import { dirname, joinPath, localFileUrl, pathFromLocalFileUrl, resolvePath, samePath } from './paths'

describe('dirname', () => {
  it('handles both separators', () => {
    expect(dirname('C:\\notes\\poetry\\a.md')).toBe('C:\\notes\\poetry')
    expect(dirname('/notes/a.md')).toBe('/notes')
    expect(dirname('/a.md')).toBe('/')
  })
})

describe('resolvePath', () => {
  it('resolves relative image paths against the document folder', () => {
    expect(resolvePath('C:\\notes\\poetry', 'img/moon.png')).toBe('C:\\notes\\poetry\\img\\moon.png')
    expect(resolvePath('C:\\notes\\poetry', './moon.png')).toBe('C:\\notes\\poetry\\moon.png')
    expect(resolvePath('C:\\notes\\poetry', '../shared/sun.jpg')).toBe('C:\\notes\\shared\\sun.jpg')
    expect(resolvePath('/home/me/notes', '../a.png')).toBe('/home/me/a.png')
  })

  it('keeps absolute paths and never climbs above the drive', () => {
    expect(resolvePath('C:\\notes', 'D:\\pics\\a.png')).toBe('D:\\pics\\a.png')
    expect(resolvePath('C:\\notes', '../../../a.png')).toBe('C:\\a.png')
  })
})

describe('local file URLs', () => {
  it('round-trip Windows paths with spaces and non-ASCII names', () => {
    const path = 'C:\\text editors\\notes\\Oisín & co.png'
    expect(pathFromLocalFileUrl(localFileUrl(path))).toBe(path)
    expect(pathFromLocalFileUrl('https://example.com/a.png')).toBeNull()
  })
})

describe('joinPath and samePath', () => {
  it('join with the path’s own separator', () => {
    expect(joinPath('C:\\notes', '1 era')).toBe('C:\\notes\\1 era')
    expect(joinPath('/notes/', 'a.md')).toBe('/notes/a.md')
  })

  it('compare Windows paths case-insensitively', () => {
    expect(samePath('C:\\Notes\\A.md', 'c:/notes/a.md')).toBe(true)
    expect(samePath('/notes/A.md', '/notes/a.md')).toBe(false)
  })
})
