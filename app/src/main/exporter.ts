import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { marked } from 'marked'

import { demoteHeadings, splitSections } from '../shared/document'
import type { ExportOptions } from '../shared/ipc'
import { stripNotes } from '../shared/notes'
import { DEFAULT_PREFERENCES, type ExportPreferences } from '../shared/preferences'

export interface ExportedMarkdown {
  markdown: string
  /** Sections exported, and those left out because they had nothing to export. */
  sections: number
  skipped: string[]
}

/**
 * A document as Markdown for export. The output is the text without its notes
 * blocks; the notes export gives each section's notes under the section's heading.
 * With a title, the title is the only top-level heading and the rest move down one.
 */
export function exportMarkdown(text: string, title: string, options: Pick<ExportOptions, 'content' | 'includeTitle'>): ExportedMarkdown {
  const level = options.includeTitle ? 2 : 1
  const parts: string[] = options.includeTitle ? [`# ${title}`] : []
  const sections = splitSections(text)
  if (options.content === 'output') {
    const output = stripNotes(text).trim()
    if (output) parts.push(options.includeTitle ? demoteHeadings(output, 2) : output)
    return { markdown: `${parts.join('\n\n')}\n`, sections: sections.filter((section) => section.output).length, skipped: [] }
  }
  const skipped: string[] = []
  let count = 0
  for (const section of sections) {
    const name = section.title ?? 'Document notes'
    if (!section.notes.trim()) {
      if (section.title !== null) skipped.push(name)
      continue
    }
    count += 1
    parts.push(`${'#'.repeat(level)} ${name}`, demoteHeadings(section.notes, level + 1))
  }
  return { markdown: `${parts.join('\n\n')}\n`, sections: count, skipped }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!)
}

/** A self-contained HTML page; relative images resolve against the document folder. */
export function renderHtml(markdown: string, title: string, baseFolder: string, style: ExportPreferences = DEFAULT_PREFERENCES.export): string {
  const body = marked.parse(markdown, { async: false, gfm: true })
  const base = pathToFileURL(baseFolder.endsWith(path.sep) ? baseFolder : baseFolder + path.sep).href
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<base href="${escapeHtml(base)}">
<style>
  body { max-width: 42rem; margin: 3rem auto; padding: 0 1.5rem; font-family: ${style.font}; font-size: ${style.fontSize}pt; line-height: ${style.lineHeight}; color: #1f2421; }
  h1, h2, h3, h4 { line-height: 1.3; font-weight: 600; }
  h1 { font-size: 2em; margin-bottom: 1.2em; }
  h2 { font-size: 1.4em; margin-top: 2em; }
  blockquote { margin-left: 0; padding-left: 1em; border-left: 3px solid #b9c9bf; color: #555; font-style: italic; }
  code { font-family: Consolas, monospace; font-size: 0.88em; background: #efede6; padding: 0.1em 0.3em; border-radius: 3px; }
  pre { background: #efede6; padding: 0.8em 1em; border-radius: 5px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  img { max-width: 100%; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid #d9d6cc; padding: 0.3em 0.7em; }
  hr { border: none; border-top: 1px solid #d9d6cc; margin: 2em 0; }
  @media print { body { max-width: none; margin: 0; padding: 0; } h2 { break-after: avoid; } }
</style>
</head>
<body>
${body}
</body>
</html>
`
}

export async function writeExport(
  target: string,
  format: ExportOptions['format'],
  markdown: string,
  title: string,
  folder: string,
  printToPdf: (html: string) => Promise<Buffer>,
  style: ExportPreferences = DEFAULT_PREFERENCES.export,
): Promise<void> {
  if (format === 'md') await writeFile(target, markdown, 'utf8')
  else if (format === 'html') await writeFile(target, renderHtml(markdown, title, folder, style), 'utf8')
  else await writeFile(target, await printToPdf(renderHtml(markdown, title, folder, style)))
}
