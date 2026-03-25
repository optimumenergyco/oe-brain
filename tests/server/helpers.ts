import { vi } from 'vitest';
import { createApp } from '../../src/server/index.js';
import type { Config } from '../../src/types.js';
import type { Services } from '../../src/mcp/server.js';
import type { AskPipeline } from '../../src/services/ask-pipeline.js';
import type { IntentRouter } from '../../src/services/intent-router.js';
import type { ConversationService } from '../../src/services/conversation.js';

const TEST_CONFIG: Config = {
  vaultPath: '/tmp/test-vault',
  contextDir: 'context',
  database: { connectionString: 'postgresql://localhost:5432/test' },
  ollama: { baseUrl: 'http://localhost:11434', model: 'test-model' },
  projects: {},
  server: {
    port: 0,
    apiToken: 'test-token-123',
  },
};

export function buildTestApp() {
  return createApp(TEST_CONFIG, {
    protectedRoutes: async (scoped) => {
      scoped.post('/test-protected', async () => {
        return { ok: true };
      });
    },
  });
}

interface MockOverrides {
  vaultWriteEntry?: ReturnType<typeof vi.fn>;
}

export function buildTestAppWithServices(overrides?: MockOverrides) {
  const mockServices: Services = {
    vault: {
      writeEntry: overrides?.vaultWriteEntry ?? vi.fn(() => '/vault/test/note.md'),
      readEntry: vi.fn(),
      listEntries: vi.fn(() => []),
      getEntryPath: vi.fn(() => '/vault/test/note.md'),
    } as unknown as Services['vault'],
    embeddings: {
      isAvailable: vi.fn(async () => false),
      embed: vi.fn(),
    } as unknown as Services['embeddings'],
    database: {
      upsertEntry: vi.fn(async () => {}),
    } as unknown as Services['database'],
    config: TEST_CONFIG,
  };

  return createApp(TEST_CONFIG, { services: mockServices });
}

interface AskMockOverrides {
  askFn?: ReturnType<typeof vi.fn>;
  intentFn?: ReturnType<typeof vi.fn>;
}

export function buildTestAppWithAsk(overrides?: AskMockOverrides) {
  const mockServices: Services = {
    vault: { writeEntry: vi.fn(), readEntry: vi.fn(), listEntries: vi.fn(() => []), getEntryPath: vi.fn() } as unknown as Services['vault'],
    embeddings: { isAvailable: vi.fn(async () => false), embed: vi.fn() } as unknown as Services['embeddings'],
    database: { upsertEntry: vi.fn(async () => {}), findTaskByTitle: vi.fn(async () => []) } as unknown as Services['database'],
    config: TEST_CONFIG,
  };

  const mockAskPipeline = {
    ask: overrides?.askFn ?? vi.fn(async () => ({
      answer: 'test answer',
      sources: [],
      route: 'brain',
      model: 'test-model',
    })),
  } as unknown as AskPipeline;

  const mockIntentRouter = {
    classify: overrides?.intentFn ?? vi.fn(async () => ({ intent: 'ask' })),
  } as unknown as IntentRouter;

  const mockConversations = {
    createConversation: vi.fn(async () => ({ id: 'conv-test-123', title: 'Test', createdAt: new Date(), updatedAt: new Date() })),
    addMessage: vi.fn(async () => ({ id: 'msg-1', conversationId: 'conv-test-123', role: 'user', content: '', metadata: {}, createdAt: new Date() })),
    getRecentMessages: vi.fn(async () => []),
    getMessages: vi.fn(async () => []),
    listConversations: vi.fn(async () => []),
    deleteConversation: vi.fn(async () => {}),
    getConversation: vi.fn(async () => null),
  } as unknown as ConversationService;

  return createApp(TEST_CONFIG, {
    services: mockServices,
    askPipeline: mockAskPipeline,
    intentRouter: mockIntentRouter,
    conversations: mockConversations,
  });
}
