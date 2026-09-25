# Oisín

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

`samples/` holds example documents: *The Night Sky* (a double document — each section has a `-notes.md` and an `-output.md`, one section has notes only), a notebook in the older extensionless naming, and a regular single-file document. Add the folder with **+** in the sidebar and try the Column / Side by side / Output / Notes views.

## AI

Open the **AI** panel (button in the document header, or Ctrl+J):

- **Draft output from notes** — for the focused section, drafts the output from its notes, its current output and the document notes (outline, sources). You review each changed paragraph and apply the ones you keep; applying is one undoable edit.
- **Analyze** — the selection or the focused file: local measurements (reading ease, sentence length and spread, repeated words) plus the model's notes on tone, structure, readability and style.
- **Word choice** — alternatives for the word at the cursor; ↵ replaces it.

Set up providers under **⚙ AI settings**:

- **Keys** — Anthropic, OpenAI, Gemini, and an optional OpenAI-compatible host (base URL + key; works for OpenRouter-style hosts or a local LM Studio/Ollama server). Keys are encrypted with Windows (DPAPI) and passed only to the local AI server.
- **Models** — profiles (provider + model id). Claude defaults to `claude-opus-5`; OpenAI/Gemini/compatible profiles need a model id. **Test** checks one profile with no fallback.
- **Routing** — the order each task tries models in. **Local / Hybrid / Cloud** filters that list; unavailable models are skipped, and a model that fails before writing anything falls back to the next.
- **Prompts** — each task's prompt is an editable Markdown file.

The local model needs PyTorch and the transformers stack: run `.\scripts\setup-sidecar.ps1` without `-NoTorch`. The first local run downloads the model (Qwen 2.5 7B by default, several GB) and needs an NVIDIA GPU; it loads in 4-bit and unloads after 10 idle minutes.

Every run is logged (task, model, token usage, input hash, output) to `%APPDATA%\Oisín\ai-history\<month>.jsonl`.

## Editing safety

Files are edited in place, so saving is careful:

- The encoding (UTF-8, UTF-8 BOM, UTF-16, Windows-1252) and line endings are detected on open and restored on save. Unchanged files round-trip byte for byte. If you type a character Windows-1252 can't store, the file is saved as UTF-8 and a notice says so.
- Saves are atomic (temp file + rename) and autosave runs 1.2 s after you stop typing, on blur, when switching files and on close.
- Before Oisín first overwrites a file in a session, it copies the original to `%APPDATA%\Oisín\backups\<session>\`. Backups older than 30 days are pruned.
- If the file changed on disk since it was opened, Oisín stops and asks: load the disk version, or keep yours.

Set `OISIN_USER_DATA` to a folder to run against a throwaway profile (settings, backups) instead of your real one.

## Checks

```powershell
cd app; npm run lint; npm run typecheck; npm test; npm run build
cd sidecar; .\.venv\Scripts\python.exe -m pytest -q
```

## How the app and sidecar connect

- The app spawns `sidecar/.venv` Python on a free `127.0.0.1` port with a random per-launch bearer token (passed by environment variable, never on the command line).
- Every sidecar route requires the token. The renderer never talks to the sidecar directly; it goes through the main process over IPC.
- The sidecar exits when its stdin closes, so it cannot outlive the app, even after a crash.
- If the sidecar dies or fails three health checks, the app restarts it with backoff, up to three attempts, then shows the error and logs.
- `OISIN_PYTHON` and `OISIN_SIDECAR_DIR` override the Python and sidecar locations.
