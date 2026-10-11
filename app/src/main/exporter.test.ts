import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { exportMarkdown, renderHtml, writeExport } from './exporter'

const DOCUMENT = [
  '# First Light', '', 'Dusk.', '', '::: notes', 'notes one', '## a note heading', ':::', '',
  '# Constellations', '', 'Patterns.', '',
  '# Empty', '',
].join('\n')

describe('exportMarkdown', () => {
  it('exports the text without notes', () => {
    expect(exportMarkdown(DOCUMENT, 'Night Sky', { content: 'output', includeTitle: false })).toEqual({
      markdown: '# First Light\n\nDusk.\n\n# Constellations\n\nPatterns.\n\n# Empty\n',
      sections: 2,
      skipped: [],
    })
  })

  it('makes the title the only top-level heading', () => {
    expect(exportMarkdown(DOCUMENT, 'Night Sky', { content: 'output', includeTitle: true }).markdown)
      .toBe('# Night Sky\n\n## First Light\n\nDusk.\n\n## Constellations\n\nPatterns.\n\n## Empty\n')
  })

  it('exports only the notes, under each section’s heading', () => {
    expect(exportMarkdown(DOCUMENT, 'Night Sky', { content: 'notes', includeTitle: false })).toEqual({
      markdown: '# First Light\n\nnotes one\n## a note heading\n',
      sections: 1,
      skipped: ['Constellations', 'Empty'],
    })
  })
})

describe('renderHtml', () => {
  it('renders Markdown into a titled page whose relative links resolve to the document folder', () => {
    const html = renderHtml('# Title\n\n*wander* & ![moon](img/moon.png)', 'Night <Sky>', 'C:\\notes\\Night Sky')
    expect(html).toContain('<title>Night &lt;Sky&gt;</title>')
    expect(html).toContain('<em>wander</em> &amp;')
    expect(html).toContain('<base href="file:///C:/notes/Night%20Sky/">')
    expect(html).toContain('src="img/moon.png"')
  })
})

describe('writeExport', () => {
  it('writes Markdown as is and PDFs through the printer', async () => {
    const folder = await mkdtemp(path.join(tmpdir(), 'ogma-export-'))
    const target = path.join(folder, 'out.md')
    await writeExport(target, 'md', '# Hi\n', 'Hi', folder, async () => Buffer.from(''))
    expect(await readFile(target, 'utf8')).toBe('# Hi\n')
    const pdf = path.join(folder, 'out.pdf')
    await writeExport(pdf, 'pdf', '# Hi\n', 'Hi', folder, async (html) => Buffer.from(`PDF:${html.includes('<h1>Hi</h1>')}`))
    expect(await readFile(pdf, 'utf8')).toBe('PDF:true')
  })
})
