import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { marked } from 'marked'

import type { ExportOptions } from '../shared/ipc'
import { readTextDocument } from './fileService'
import { readFolder } from './workspaceService'

export interface ExportSection {
  title: string
  text: string
}

/** Joins sections in order; a section whose text does not open with a heading gets one. */
export function buildExportMarkdown(title: string, sections: ExportSection[], includeTitle: boolean): string {
  const parts: string[] = []
  if (includeTitle) parts.push(`# ${title}`)
  for (const section of sections) {
    const text = section.text.trim()
    if (!text) continue
    parts.push(/^#{1,6}\s/.test(text) ? text : `## ${section.title}\n\n${text}`)
  }
  return `${parts.join('\n\n')}\n`
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!)
}

/** A self-contained HTML page; relative images resolve against the document folder. */
export function renderHtml(markdown: string, title: string, baseFolder: string): string {
  const body = marked.parse(markdown, { async: false, gfm: true })
  const base = pathToFileURL(baseFolder.endsWith(path.sep) ? baseFolder : baseFolder + path.sep).href
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<base href="${escapeHtml(base)}">
<style>
  body { max-width: 42rem; margin: 3rem auto; padding: 0 1.5rem; font: 17px/1.7 Georgia, 'Times New Roman', serif; color: #1f2421; }
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
  @media print { body { margin: 0 auto; } h2 { break-after: avoid; } }
</style>
</head>
<body>
${body}
</body>
</html>
`
}

export interface ExportResult {
  sections: number
  skipped: string[]
}

/** Reads a double document's sections (output or notes) in order. */
export async function collectDocument(folder: string, options: ExportOptions): Promise<{ sections: ExportSection[]; skipped: string[] }> {
  const model = await readFolder(folder)
  const sections: ExportSection[] = []
  const skipped: string[] = []
  for (const section of model.sections) {
    const name = options.content === 'notes' ? section.notes : section.output
    const text = name ? (await readTextDocument(path.join(folder, name), true)).text : ''
    if (text.trim()) sections.push({ title: section.title, text })
    else skipped.push(section.title)
  }
  return { sections, skipped }
}

export async function writeExport(
  target: string,
  format: ExportOptions['format'],
  markdown: string,
  title: string,
  folder: string,
  printToPdf: (html: string) => Promise<Buffer>,
): Promise<void> {
  if (format === 'md') await writeFile(target, markdown, 'utf8')
  else if (format === 'html') await writeFile(target, renderHtml(markdown, title, folder), 'utf8')
  else await writeFile(target, await printToPdf(renderHtml(markdown, title, folder)))
}
