# Agent API Integration

The React app's Agent Command page now uses a local server bridge instead of hard-coded chat bubbles.

## Runtime flow

1. The browser calls `GET /api/agent/health` to check whether the bridge is configured.
2. The browser calls `POST /api/agent/session` to start or refresh a Salesforce Agent API session.
3. Each prompt is sent to `POST /api/agent/messages`.
4. The bridge mints an access token by using the external client app credentials.
5. The bridge forwards requests to the Salesforce Agent API and normalizes the returned messages.
6. The browser renders the returned `Inform`-style messages and cited references.

## Local endpoints

- `GET /api/agent/health`
- `POST /api/agent/session`
- `POST /api/agent/messages`
- `DELETE /api/agent/session/:sessionId`

## Why a bridge is used

- It keeps the client secret out of the browser.
- It gives the React app a stable shape even if the Salesforce payload changes.
- It centralizes token minting, error handling, and session cleanup.

## Current assumptions

- The org has an activated agent that supports the Agent API.
- The external client app is configured for client credentials flow and has `chatbot_api` plus `sfap_api`.
- The app uses synchronous message sends for now, which is simpler to operate while still giving you a proper session-based chat.

