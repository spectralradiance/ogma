# Ogma

A section-based Markdown editor for writing, vocabulary and linguistic research. See [PLAN.md](PLAN.md) for the design and roadmap.

- `app/`: Electron + React + TypeScript desktop app
- `sidecar/`: Python FastAPI server for AI and GPU work, launched by the app
- `scripts/`: setup and dev helpers

## Setup (Windows, PowerShell)

Requires Node.js 22+ and Python 3.11+.

```powershell
.\scripts\setup-sidecar.ps1           # venv + FastAPI + CUDA PyTorch (cu126)
.\scripts\setup-sidecar.ps1 -NoTorch  # skip the ~2.5 GB PyTorch download for now
cd app; npm install                   # also downloads the Electron binary
```

## Run

```powershell
.\scripts\dev.ps1               # the app; it starts and stops the sidecar itself
.\scripts\dev.ps1 -SidecarOnly  # just the sidecar on :8765, printing its token
```

The status bar shows the sidecar state, GPU memory, PyTorch/CUDA and which AI providers have keys. Click it for details, logs and a restart button.

API keys are set in the app under **AI → ⚙ AI settings → Keys** (stored encrypted). Keys already in the environment the app starts from (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`) also work; keys saved in the app take precedence.

## Samples

`samples/` holds example documents: *The Night Sky* (a double document — each section has a `-notes.md` and an `-output.md`, one section has notes only), a notebook in the older extensionless naming, a regular single-file document, and *Night Sky (one file)*, the one-file format with inline notes. Add the folder with **+** in the sidebar and try the Column / Side by side / Output / Notes views.

## Single-file documents

A plain `.md` file is a whole document. Each `#` heading starts a section (the outline lists them; `##` and deeper stay inside their section), and a section's notes sit under its text in a notes block:

```
# First Light

The text of the section.

::: notes
Working notes, research and fragments for this section.
:::
```

The header switches between three views of the same file:

- **Output**: the text as one continuous document, notes hidden.
- **Notes**: every section's notes as one continuous document, under the section headings. Press Enter on a heading to start that section's notes.
- **Both**: text and notes together, each notes block drawn as a quieter, indented block (in Live mode its `::: notes` / `:::` lines fold away until the cursor is in it).

Edits in any view go straight into the file. **Ctrl+Alt+N** adds a notes block to the section you are in, or jumps to the one it has (switching to the Notes view from Output). Headings inside notes never start a section. Word counts keep notes apart (the status bar shows "N in notes"), exports leave notes out (or export only the notes), AI Analyze ignores them, and **Draft output from notes** drafts the section at the cursor from its notes.

**New document** (folder right-click) makes one. **Convert to a single document** (right-click a folder of sections) writes `<folder name>.md` next to it, a `#` heading per section with its output and notes; the folder is left as it is.

The folder-of-files layout described below still works as before.

## Working in the sidebar

- **Reorder** numbered sections by dragging them in the sidebar; the files are renumbered for you.
- **Rename** a section or folder by double-clicking it (or right-click → Rename). Open files inside a renamed folder stay open.
- **Right-click** a section for Rename, Move up/down and Delete; right-click a folder for Rename, New section, New folder and (for top-level folders) Remove from workspace. Delete is also in a section's ⋯ menu.
- **Delete** doesn't ask first. A toast offers **Undo** for 10 seconds; the files also go to the Recycle Bin. Undo works until the app closes, for the last 20 deletions.

## Dictionary

The Words panel (Ctrl+D) reads a local `wiktionary.db`. If none is found, click **Download Wiktionary** in the panel: it downloads the English Wiktionary extract from kaikki.org (about 500 MB compressed), builds the database in `%APPDATA%\Ogma\wiktionary.db` (roughly 1 GB) and starts using it. You can cancel at any time. **Choose an existing wiktionary.db…** points the app at one you already have.

## Appearance

**Settings** (status bar) has a color scheme (match Windows, light or dark) and a palette: Ogma, Parchment, Slate or Mono. Each palette has a light and a dark variant. Palettes are sets of CSS variables under `[data-palette]` in `app/src/renderer/src/styles.css`, so adding one means a new block there and an entry in `PALETTES` in `app/src/shared/preferences.ts`. The UI is built with Tailwind CSS (utilities read the same variables), Radix UI for menus and dialogs, and Lucide icons.

## AI

Open the **AI** panel (button in the document header, or Ctrl+J). It has two views, **Tools** and **Chat**, and remembers which one you last used.

**Tools** are one-shot tasks:

- **Draft output from notes** — for the focused section, drafts the output from its notes, its current output and the document notes (outline, sources). When it finishes, the draft appears in that section's editor as suggested changes, word by word where a paragraph was edited and whole where it was rewritten. Deletions are struck through and insertions highlighted, each with ✓ / ✕; the bar above the editor has **Next**, **Reject all** and **Accept all**. Nothing changes until you accept, and Ctrl+Z undoes an accept or reject (bringing the suggestion back). Keep writing meanwhile: suggestions follow the text, and one you type over is dropped. The text as it was before the draft is saved to History first, labelled "Before AI: …". **Suggest again** in the AI panel re-places the draft if you dismissed it or the editor was closed.
- **Analyze** — the selection or the focused file: local measurements (reading ease, sentence length and spread, repeated words) plus the model's notes on tone, structure, readability and style.
- **Analyze structure** — order, balance, gaps and overlaps across the whole document, from its outline, section sizes and opening lines.
- **Word choice** — alternatives for the word at the cursor; ↵ replaces it.

**Chat** is a conversation about your work: feedback, ideas, wording. **Enter** sends and **Shift+Enter** starts a new line. With **Attach focused text** on, each message includes the selection, or the whole focused file if nothing is selected (up to about 24,000 characters; inline notes blocks are left out), along with the document and section names. The model sees the whole conversation. The conversation stays put when you switch drawers or close the panel, and keeps streaming meanwhile; **New chat** clears it, and so does reloading the window. Chat follows the same model picker, mode and routing as the tools.

With **Agent** on, the chat can act on your work: ask it to tighten a section, check the piece for consistency, or carry a change through every section. It works in steps, using tools to list the open files, read them (unsaved edits included), read the outline, and search the workspace, then suggests edits. Each tool it uses shows as a line in its reply. Edits are never written directly: they appear in the editor as suggestions, exactly like a draft, so you accept or reject each one. It can only edit files that are open, and the first edit to a file in each answer saves a "Before AI" version to History. **Stop** ends it after the current step, and it stops on its own after 30 steps. Agent mode needs a model that can use tools: Claude, OpenAI or an OpenAI-compatible host (Settings → Routing → Agent); Gemini and the local model are skipped.

Set up providers under **⚙ AI settings**:

- **Keys** — Anthropic, OpenAI, Gemini, and an optional OpenAI-compatible host (base URL + key; works for OpenRouter-style hosts or a local LM Studio/Ollama server). Keys are encrypted with Windows (DPAPI) and passed only to the local AI server.
- **Models** — profiles (provider + model id). Claude defaults to `claude-opus-5`; OpenAI/Gemini/compatible profiles need a model id. **Test** checks one profile with no fallback.
- **Routing** — the order each task tries models in. **Local / Hybrid / Cloud** filters that list; unavailable models are skipped, and a model that fails before writing anything falls back to the next.
- **Prompts** — each task's prompt is an editable Markdown file. In `chat.md` the part above `=== user ===` is the system prompt (with `{{document}}`, `{{section}}` and `{{context}}`), and `{{message}}` is the message you type; earlier turns are sent before it. `agent.md` works the same way for agent mode, but keep its system part free of placeholders: it is resent unchanged with every step.

The local model needs PyTorch and the transformers stack: run `.\scripts\setup-sidecar.ps1` without `-NoTorch`. The first local run downloads the model (Qwen 2.5 7B by default, several GB) and needs an NVIDIA GPU; it loads in 4-bit and unloads after 10 idle minutes.

Every run is logged (task, model, token usage, input hash, output) to `%APPDATA%\Ogma\ai-history\<month>.jsonl`.

## Finding, exporting and tracking

- **Search** (sidebar tab, Ctrl+Shift+F) looks through every text file in the workspace folders. The index is built the first time you open Search and then kept current as files change. *Related to the current passage* lists paragraphs elsewhere that share the focused passage's key words.
- **Export** (Settings → Export, Ctrl+,) writes the open document's outputs, or its notes, in section order as PDF, HTML or Markdown.
- **History** (⟲ on any editor) lists earlier versions of that file — saved automatically at most every 10 minutes while you edit, plus snapshots you take and a "Before AI" version whenever the AI suggests changes — with a diff against the current text and Restore. Versions are kept in `%APPDATA%\Ogma\snapshots`, never in your folders.
- **Stats** (document header) shows notes and output word counts per section, an output goal with progress, and words written per day; today's net count is in the status bar.

## Editing safety

Files are edited in place, so saving is careful:

- The encoding (UTF-8, UTF-8 BOM, UTF-16, Windows-1252) and line endings are detected on open and restored on save. Unchanged files round-trip byte for byte. If you type a character Windows-1252 can't store, the file is saved as UTF-8 and a notice says so.
- Saves are atomic (temp file + rename) and autosave runs 1.2 s after you stop typing, on blur, when switching files and on close.
- Before Ogma first overwrites a file in a session, it copies the original to `%APPDATA%\Ogma\backups\<session>\`. Backups older than 30 days are pruned.
- If the file changed on disk since it was opened, Ogma stops and asks: load the disk version, or keep yours.

Set `OGMA_USER_DATA` to a folder to run against a throwaway profile (settings, backups) instead of your real one.

Ogma uses its own `%APPDATA%\Ogma` profile. Existing Oisín data is left untouched; set `OGMA_USER_DATA` to the old profile folder to keep using it. App-specific environment variables now use the `OGMA_` prefix.

## Checks

```powershell
cd app; npm run lint; npm run typecheck; npm test; npm run build
cd sidecar; .\.venv\Scripts\python.exe -m pytest -q
```

## How the app and sidecar connect

- The app spawns `sidecar/.venv` Python on a free `127.0.0.1` port with a random per-launch bearer token (passed by environment variable, never on the command line).
- Every sidecar route requires the token. The renderer never talks to the sidecar directly; it goes through the main process over IPC.
- The sidecar is given the app's process id and exits when the app does, so it cannot outlive the app, even after a crash.
- If the sidecar dies or fails three health checks, the app restarts it with backoff, up to three attempts, then shows the error and logs.
- `OGMA_PYTHON` and `OGMA_SIDECAR_DIR` override the Python and sidecar locations.
