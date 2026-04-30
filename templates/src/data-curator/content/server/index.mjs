import crypto from 'node:crypto'
import dotenv from 'dotenv'
import express from 'express'

dotenv.config()

const app = express()
app.use(express.json({ limit: '1mb' }))

const tokenCache = {
  accessToken: null,
  expiresAt: 0
}

function getConfig() {
  return {
    agentDomain: process.env.SF_AGENT_DOMAIN?.trim() ?? '',
    apiHost: process.env.SF_AGENT_API_HOST?.trim() || 'https://api.salesforce.com',
    agentId: process.env.SF_AGENT_ID?.trim() ?? '',
    clientId: process.env.SF_ECA_CLIENT_ID?.trim() ?? '',
    clientSecret: process.env.SF_ECA_CLIENT_SECRET?.trim() ?? '',
    bypassUser: (process.env.SF_AGENT_BYPASS_USER ?? 'true').toLowerCase() !== 'false'
  }
}

function getMissingEnv(config) {
  const required = [
    ['SF_AGENT_DOMAIN', config.agentDomain],
    ['SF_AGENT_ID', config.agentId],
    ['SF_ECA_CLIENT_ID', config.clientId],
    ['SF_ECA_CLIENT_SECRET', config.clientSecret]
  ]

  return required.filter(([, value]) => !value).map(([key]) => key)
}

function buildError(message, status = 500, details) {
  const error = new Error(message)
  error.status = status
  error.details = details
  return error
}

async function mintAccessToken(config) {
  const now = Date.now()
  if (tokenCache.accessToken && tokenCache.expiresAt > now + 60_000) {
    return tokenCache.accessToken
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.clientId,
    client_secret: config.clientSecret
  })

  const response = await fetch(`${config.agentDomain}/services/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  })

  if (!response.ok) {
    const details = await response.text()
    throw buildError('Unable to mint a Salesforce access token.', response.status, details)
  }

  const payload = await response.json()
  tokenCache.accessToken = payload.access_token
  tokenCache.expiresAt = now + Number(payload.expires_in ?? 600) * 1000
  return tokenCache.accessToken
}

async function callAgentApi(path, options = {}) {
  const config = getConfig()
  const missingEnv = getMissingEnv(config)

  if (missingEnv.length > 0) {
    throw buildError('Missing Salesforce Agent API environment variables.', 503, { missingEnv })
  }

  const accessToken = await mintAccessToken(config)
  const response = await fetch(`${config.apiHost}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Accept: options.accept ?? 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers ?? {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  })

  if (!response.ok) {
    const details = await response.text()
    throw buildError('Salesforce Agent API request failed.', response.status, details)
  }

  return response
}

function flattenText(value) {
  if (typeof value === 'string') {
    return value
  }

  if (Array.isArray(value)) {
    return value.map(flattenText).filter(Boolean).join('\n')
  }

  if (value && typeof value === 'object') {
    const preferredKeys = ['message', 'text', 'content', 'outputText', 'value']

    for (const key of preferredKeys) {
      if (key in value) {
        const text = flattenText(value[key])
        if (text) {
          return text
        }
      }
    }
  }

  return ''
}

function normalizeMessages(messages = []) {
  return messages
    .map((message, index) => {
      const text = flattenText(message)
      if (!text) {
        return null
      }

      const type = message.type ?? message.messageType ?? 'Inform'
      const citations = Array.isArray(message.citedReferences)
        ? message.citedReferences.map((reference) => ({
            title: reference.title ?? reference.name ?? 'Source',
            url: reference.url ?? reference.uri ?? ''
          }))
        : []

      return {
        id: message.id ?? `${type}-${index}`,
        role: type === 'Inform' || type === 'TextChunk' ? 'assistant' : 'system',
        type,
        text,
        citations
      }
    })
    .filter(Boolean)
}

app.get('/api/agent/health', (_req, res) => {
  const config = getConfig()
  const missingEnv = getMissingEnv(config)

  res.json({
    configured: missingEnv.length === 0,
    missingEnv,
    apiHost: config.apiHost,
    agentId: config.agentId || null
  })
})

app.post('/api/agent/session', async (req, res, next) => {
  try {
    const config = getConfig()
    const response = await callAgentApi(`/einstein/ai-agent/v1/agents/${config.agentId}/sessions`, {
      method: 'POST',
      body: {
        externalSessionKey: crypto.randomUUID(),
        instanceConfig: {
          endpoint: config.agentDomain
        },
        featureSupport: 'Streaming',
        streamingCapabilities: {
          chunkTypes: ['Text']
        },
        bypassUser: config.bypassUser,
        variables: req.body?.variables ?? []
      }
    })

    const payload = await response.json()
    res.json({
      sessionId: payload.sessionId,
      messages: normalizeMessages(payload.messages)
    })
  } catch (error) {
    next(error)
  }
})

app.post('/api/agent/messages', async (req, res, next) => {
  try {
    const { sessionId, text, sequenceId, variables = [] } = req.body ?? {}

    if (!sessionId || !text || typeof sequenceId !== 'number') {
      throw buildError('`sessionId`, `text`, and numeric `sequenceId` are required.', 400)
    }

    const response = await callAgentApi(`/einstein/ai-agent/v1/sessions/${sessionId}/messages`, {
      method: 'POST',
      body: {
        message: {
          sequenceId,
          type: 'Text',
          text
        },
        variables
      }
    })

    const payload = await response.json()
    res.json({
      messages: normalizeMessages(payload.messages)
    })
  } catch (error) {
    next(error)
  }
})

app.delete('/api/agent/session/:sessionId', async (req, res, next) => {
  try {
    await callAgentApi(`/einstein/ai-agent/v1/sessions/${req.params.sessionId}`, {
      method: 'DELETE',
      headers: {
        'x-session-end-reason': 'UserRequest'
      }
    })

    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

app.use((error, _req, res, _next) => {
  const status = Number(error.status ?? 500)
  res.status(status).json({
    error: error.message || 'Unexpected server error.',
    details: error.details ?? null
  })
})

const port = Number(process.env.PORT ?? 8787)
const host = process.env.HOST ?? '127.0.0.1'
app.listen(port, host, () => {
  console.log(`Agent bridge listening on http://${host}:${port}`)
})
