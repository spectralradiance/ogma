import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { buildExportMarkdown, collectDocument, renderHtml, writeExport } from './exporter'

describe('buildExportMarkdown', () => {
  it('joins sections; one without a heading continues the previous one', () => {
    const sections = [
      { title: 'First Light', text: '## First Light\n\nDusk.' },
      { title: 'Constellations', text: 'Patterns.\n' },
      { title: 'Empty', text: '   ' },
    ]
    expect(buildExportMarkdown('The Night Sky', sections, true)).toBe('# The Night Sky\n\n## First Light\n\nDusk.\n\nPatterns.\n')
    expect(buildExportMarkdown('The Night Sky', sections, false, true)).toBe('## First Light\n\nDusk.\n\n## Constellations\n\nPatterns.\n')
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

describe('collectDocument and writeExport', () => {
  it('takes each section’s output (or notes) in order and reports what was skipped', async () => {
    const folder = await mkdtemp(path.join(tmpdir(), 'oisin-export-'))
    await writeFile(path.join(folder, '01 First Light-notes.md'), 'notes one')
    await writeFile(path.join(folder, '01 First Light-output.md'), '## First Light\n\nOutput one.')
    await writeFile(path.join(folder, '02 Wanderers-notes.md'), 'notes two')
    await writeFile(path.join(folder, '10 Tenth'), Buffer.from([0x49, 0x92, 0x6d, 0x0d, 0x0a]))
    await writeFile(path.join(folder, '10 Tenth-output.md'), 'Ten.')
    await writeFile(path.join(folder, 'outline.md'), 'not a section')

    const output = await collectDocument(folder, { format: 'md', content: 'output', includeTitle: false })
    expect(output.sections.map((section) => section.title)).toEqual(['First Light', 'Tenth'])
    expect(output.skipped).toEqual(['Wanderers'])

    const notes = await collectDocument(folder, { format: 'md', content: 'notes', includeTitle: false })
    expect(notes.sections.map((section) => section.text.trim())).toEqual(['notes one', 'notes two', 'I’m'])

    const target = path.join(folder, 'out.md')
    await writeExport(target, 'md', '# Hi\n', 'Hi', folder, async () => Buffer.from(''))
    expect(await readFile(target, 'utf8')).toBe('# Hi\n')
    const pdf = path.join(folder, 'out.pdf')
    await writeExport(pdf, 'pdf', '# Hi\n', 'Hi', folder, async (html) => Buffer.from(`PDF:${html.includes('<h1>Hi</h1>')}`))
    expect(await readFile(pdf, 'utf8')).toBe('PDF:true')
  })
})
