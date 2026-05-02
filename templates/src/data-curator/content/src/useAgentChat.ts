import { startTransition, useEffect, useRef, useState } from 'react';
import {
  createAgentSession,
  endAgentSession,
  fetchAgentHealth,
  sendAgentMessage,
  type AgentApiMessage,
} from './agentApi';

type ChatRole = 'assistant' | 'system' | 'user';

export type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  type?: string;
  citations?: AgentApiMessage['citations'];
};

type AgentStatus = 'checking' | 'ready' | 'misconfigured' | 'error';

type PersistedChatState = {
  draft: string;
  messages: ChatMessage[];
  sessionId: string | null;
  status: AgentStatus;
  statusNote: string;
};

const CHAT_STORAGE_KEY = 'metadata-management-center-agent-chat';
const processingMessages = [
  'Tracing metadata ownership threads through the org...',
  'Coaxing the agent into a crisp admin-ready answer...',
  'Comparing stale assets, duplicate risks, and likely next moves...',
  'Pulling together a governance brief with the messy parts included...',
  'Checking what changed, what is stale, and what deserves attention first...',
];

const seedMessage: ChatMessage = {
  id: 'seed-welcome',
  role: 'assistant',
  text: 'I can review stale metadata, recover ownership, summarize health posture, and draft a duplicate cleanup plan.',
};

function readPersistedState(): PersistedChatState | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const raw = window.sessionStorage.getItem(CHAT_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as PersistedChatState;
  } catch (_error) {
    return null;
  }
}

function mapAgentMessage(message: AgentApiMessage): ChatMessage {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    type: message.type,
    citations: message.citations,
  };
}

export function useAgentChat() {
  const persistedState = readPersistedState();
  const [messages, setMessages] = useState<ChatMessage[]>(
    persistedState?.messages?.length ? persistedState.messages : [seedMessage]
  );
  const [draft, setDraft] = useState(persistedState?.draft ?? '');
  const [status, setStatus] = useState<AgentStatus>(persistedState?.status ?? 'checking');
  const [statusNote, setStatusNote] = useState(
    persistedState?.statusNote ?? 'Checking the agent service...'
  );
  const [isSending, setIsSending] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(persistedState?.sessionId ?? null);
  const [processingNote, setProcessingNote] = useState(processingMessages[0]);
  const sequenceRef = useRef(1);
  const startedRef = useRef(Boolean(persistedState?.sessionId));

  useEffect(() => {
    let ignore = false;

    async function loadHealth() {
      try {
        const health = await fetchAgentHealth();
        if (ignore) {
          return;
        }

        if (health.configured) {
          setStatus('ready');
          setStatusNote('Connected to the Metadata Management Center agent service.');
          return;
        }

        setStatus('misconfigured');
        setStatusNote(`Missing environment variables: ${health.missingEnv.join(', ')}`);
      } catch (error) {
        if (ignore) {
          return;
        }

        setStatus('error');
        setStatusNote(
          error instanceof Error ? error.message : 'Unable to contact the agent service.'
        );
      }
    }

    void loadHealth();

    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    if (status !== 'ready' || startedRef.current || sessionId) {
      return;
    }

    startedRef.current = true;

    void initializeSession();
  }, [sessionId, status]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.sessionStorage.setItem(
      CHAT_STORAGE_KEY,
      JSON.stringify({
        draft,
        messages,
        sessionId,
        status,
        statusNote,
      } satisfies PersistedChatState)
    );
  }, [draft, messages, sessionId, status, statusNote]);

  useEffect(() => {
    if (!isSending) {
      setProcessingNote(processingMessages[0]);
      return;
    }

    let index = 0;
    const intervalId = window.setInterval(() => {
      index = (index + 1) % processingMessages.length;
      setProcessingNote(processingMessages[index]);
    }, 1700);

    return () => window.clearInterval(intervalId);
  }, [isSending]);

  async function initializeSession() {
    try {
      const payload = await createAgentSession();
      sequenceRef.current = 1;
      setSessionId(payload.sessionId);

      if (payload.messages.length > 0) {
        startTransition(() => {
          setMessages(payload.messages.map(mapAgentMessage));
        });
      }
    } catch (error) {
      setStatus('error');
      setStatusNote(error instanceof Error ? error.message : 'Unable to start an agent session.');
    }
  }

  async function handleSubmit(input: string) {
    const text = input.trim();
    if (!text || isSending) {
      return;
    }

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      text,
    };

    setDraft('');
    setIsSending(true);
    startTransition(() => {
      setMessages((current) => [...current, userMessage]);
    });

    try {
      let activeSessionId = sessionId;

      if (!activeSessionId) {
        const payload = await createAgentSession();
        activeSessionId = payload.sessionId;
        setSessionId(payload.sessionId);

        if (payload.messages.length > 0) {
          startTransition(() => {
            setMessages((current) => {
              const seeded = current.filter((message) => message.id !== seedMessage.id);
              return [...payload.messages.map(mapAgentMessage), ...seeded];
            });
          });
        }
      }

      const response = await sendAgentMessage({
        sessionId: activeSessionId,
        text,
        sequenceId: sequenceRef.current,
      });

      sequenceRef.current += 1;
      const assistantMessages =
        response.messages.length > 0
          ? response.messages.map(mapAgentMessage)
          : [
              {
                id: crypto.randomUUID(),
                role: 'system' as const,
                text: 'The agent responded without a displayable message.',
                type: 'EmptyResponse',
              },
            ];

      startTransition(() => {
        setMessages((current) => [...current, ...assistantMessages]);
      });
    } catch (error) {
      const fallbackMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'system',
        text: error instanceof Error ? error.message : 'Unable to reach the Salesforce agent.',
        type: 'Error',
      };

      startTransition(() => {
        setMessages((current) => [...current, fallbackMessage]);
      });
    } finally {
      setIsSending(false);
    }
  }

  async function resetSession() {
    if (sessionId) {
      try {
        await endAgentSession(sessionId);
      } catch (_error) {
        // The next session creation should recover from any cleanup failure.
      }
    }

    sequenceRef.current = 1;
    startedRef.current = false;
    setSessionId(null);
    setMessages([seedMessage]);
    if (typeof window !== 'undefined') {
      window.sessionStorage.removeItem(CHAT_STORAGE_KEY);
    }

    if (status === 'ready') {
      startedRef.current = true;
      void initializeSession();
    }
  }

  return {
    draft,
    isSending,
    messages,
    sessionId,
    setDraft,
    status,
    statusNote,
    processingNote,
    submitMessage: handleSubmit,
    resetSession,
  };
}
