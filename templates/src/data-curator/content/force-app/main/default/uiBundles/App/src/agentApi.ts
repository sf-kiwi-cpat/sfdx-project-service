export type AgentHealth = {
  configured: boolean;
  missingEnv: string[];
  apiHost: string;
  agentId: string | null;
};

export type AgentApiMessage = {
  id: string;
  role: 'assistant' | 'system';
  type: string;
  text: string;
  citations: Array<{
    title: string;
    url: string;
  }>;
};

type SessionResponse = {
  sessionId: string;
  messages: AgentApiMessage[];
};

type MessageResponse = {
  messages: AgentApiMessage[];
};

type DataSdk = {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
};

let dataSdkPromise: Promise<DataSdk> | null = null;

function isSalesforceHost() {
  if (typeof window === 'undefined') {
    return false;
  }

  const hostname = window.location.hostname;
  return hostname !== 'localhost' && hostname !== '127.0.0.1';
}

function getAgentApiBase() {
  const base = (import.meta.env?.BASE_URL ?? '/').replace(/\/$/, '');
  if (isSalesforceHost()) {
    return `${base}/services/apexrest/data-curator-agent/v1`;
  }
  return `${base}/api/agent`;
}

function getAgentUrl(path: string) {
  return `${getAgentApiBase()}${path}`;
}

async function getDataSdk() {
  if (!dataSdkPromise) {
    dataSdkPromise = import('@salesforce/sdk-data').then(async ({ createDataSDK }) => {
      const sdk = await createDataSDK();
      return sdk as DataSdk;
    });
  }

  return dataSdkPromise;
}

async function agentFetch(path: string, init?: RequestInit) {
  const url = getAgentUrl(path);
  if (!isSalesforceHost()) {
    return fetch(url, {
      credentials: 'same-origin',
      ...init,
    });
  }

  const sdk = await getDataSdk();
  return sdk.fetch(url, init);
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T & {
    error?: string;
    details?: unknown;
  };

  if (!response.ok) {
    throw new Error(payload.error ?? 'Agent API request failed.');
  }

  return payload;
}

export async function fetchAgentHealth() {
  const response = await agentFetch('/health');
  return readJson<AgentHealth>(response);
}

export async function createAgentSession() {
  const response = await agentFetch('/session', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });

  return readJson<SessionResponse>(response);
}

export async function sendAgentMessage(payload: {
  sessionId: string;
  text: string;
  sequenceId: number;
}) {
  const response = await agentFetch('/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  return readJson<MessageResponse>(response);
}

export async function endAgentSession(sessionId: string) {
  const response = await agentFetch(`/session/${sessionId}`, { method: 'DELETE' });

  if (!response.ok && response.status !== 204) {
    const payload = (await response.json()) as { error?: string };
    throw new Error(payload.error ?? 'Unable to end the agent session.');
  }
}
