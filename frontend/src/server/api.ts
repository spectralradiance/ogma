import cors from 'cors'
import express, { type NextFunction, type Request, type Response } from 'express'

import { lookupWord, searchWords } from '../lib/dictionary/service.ts'


const PORT = Number(process.env.DICTIONARY_PORT ?? 3001)
const app = express()

app.use(cors({ origin: ['http://localhost:5173', 'http://127.0.0.1:5173'] }))
app.use(express.json())

app.get('/health', (_request, response) => {
  response.json({ status: 'ok' })
})

app.get('/api/define/:word', (request, response, next) => {
  try {
    const entries = lookupWord(request.params.word)
    if (!entries.length) {
      response.status(404).json({ error: 'Word not found' })
      return
    }
    response.json(entries)
  } catch (error) {
    next(error)
  }
})

app.get('/api/search', (request, response, next) => {
  try {
    const query = typeof request.query.q === 'string' ? request.query.q : ''
    const requestedLimit = Number(request.query.limit ?? 20)
    const limit = Number.isFinite(requestedLimit) ? requestedLimit : 20
    response.json(searchWords(query, limit))
  } catch (error) {
    next(error)
  }
})

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  void _next
  const message = error instanceof Error ? error.message : String(error)
  if (/database|directory|file/i.test(message)) {
    response.status(503).json({
      error: 'Dictionary database unavailable',
      detail: 'Run npm run setup:dict from frontend/ before starting dictionary lookups.',
    })
    return
  }
  console.error(error)
  response.status(500).json({ error: 'Dictionary request failed' })
})

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Dictionary server running on http://127.0.0.1:${PORT}`)
})