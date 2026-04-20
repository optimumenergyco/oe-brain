import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../types.js';
import type { Services } from '../mcp/server.js';
import { getConfig } from '../config.js';
import { DatabaseService } from '../services/database.js';
import { EmbeddingsService } from '../services/embeddings.js';
import { VaultService } from '../services/vault.js';
import { healthRoutes } from './routes/health.js';
import { captureRoutes } from './routes/capture.js';
import { askRoutes } from './routes/ask.js';
import { conversationRoutes } from './routes/conversations.js';
import { authPlugin } from './plugins/auth.js';
import { searchApiRoutes } from './routes/search-api.js';
import { contextRoutes } from './routes/context.js';
import { tasksApiRoutes } from './routes/tasks-api.js';
import { entryRoutes } from './routes/entries.js';
import { bookmarksApiRoutes } from './routes/bookmarks-api.js';
import { embedApiRoutes } from './routes/embed-api.js';
import { codeSearchApiRoutes } from './routes/code-search-api.js';
import { OllamaChatService } from '../services/ollama-chat.js';
import type { ChatService } from '../services/ollama-chat.js';
import { OpenRouterChatService } from '../services/openrouter-chat.js';
import { SearxngService } from '../services/searxng.js';
import { AskPipeline } from '../services/ask-pipeline.js';
import { IntentRouter } from '../services/intent-router.js';
import { ConversationService } from '../services/conversation.js';
import { EmailService } from '../services/email.js';
import { emailRoutes } from './routes/email.js';

export interface CreateAppOptions {
  /** Callback to register routes inside the auth-protected scope */
  protectedRoutes?: (scoped: FastifyInstance) => Promise<void> | void;
  /** Pre-built services (for testing with mocks) */
  services?: Services;
  /** Pre-built AskPipeline (for testing with mocks) */
  askPipeline?: AskPipeline;
  /** Pre-built IntentRouter (for testing with mocks) */
  intentRouter?: IntentRouter;
  /** Pre-built ConversationService (for testing with mocks) */
  conversations?: ConversationService;
}

function buildServices(config: Config): Services {
  const database = new DatabaseService(config.database.connectionString);
  const embeddings = new EmbeddingsService(config.ollama.baseUrl, config.ollama.model);
  const vault = new VaultService(config.vaultPath, config.contextDir);
  return { database, embeddings, vault, config };
}

function buildChatService(config: Config): ChatService {
  if (config.openrouter) {
    return new OpenRouterChatService(config.openrouter.apiKey, config.openrouter.model);
  }
  return new OllamaChatService(
    config.ollama.baseUrl,
    'gemma3:27b-cloud',
    'gemma3:27b-cloud',
  );
}

export function createApp(config: Config, opts?: CreateAppOptions): FastifyInstance {
  const app = Fastify({ logger: true });
  const services = opts?.services ?? buildServices(config);

  const chatService = buildChatService(config);
  const searxng = new SearxngService(config.searxng?.baseUrl ?? 'http://localhost:8888');
  const modelName = config.openrouter?.model ?? 'Ollama';
  const askPipeline = opts?.askPipeline ?? new AskPipeline(chatService, searxng, services.embeddings, services.database, undefined, modelName);
  const intentRouter = opts?.intentRouter ?? new IntentRouter(chatService);
  const conversationService = opts?.conversations ?? new ConversationService(config.database.connectionString);

  // Public routes -- no auth required
  app.register(healthRoutes);

  // Protected scope -- bearer auth required for all routes registered within
  if (config.server?.apiToken) {
    app.register(async function protectedScope(scoped) {
      await scoped.register(authPlugin, { apiToken: config.server!.apiToken });

      // Capture endpoint
      await scoped.register(captureRoutes, { services });

      // Ask endpoint
      await scoped.register(askRoutes, {
        askPipeline,
        services,
        intentRouter,
        conversations: conversationService,
        chatService,
      });

      // API endpoints for client mode
      await scoped.register(searchApiRoutes, { services });
      await scoped.register(contextRoutes, { services });
      await scoped.register(tasksApiRoutes, { services });
      await scoped.register(entryRoutes, { services });
      await scoped.register(bookmarksApiRoutes, { services });
      await scoped.register(embedApiRoutes, { services });
      await scoped.register(codeSearchApiRoutes, { services });

      // Conversation endpoints
      await scoped.register(conversationRoutes, { conversations: conversationService });

      // Email endpoints (if configured)
      if (config.email?.accounts && config.email.accounts.length > 0) {
        const emailService = new EmailService(config.email.accounts);
        await scoped.register(emailRoutes, { emailService });
      }

      // Register any protected routes passed via options
      if (opts?.protectedRoutes) {
        await opts.protectedRoutes(scoped);
      }
    });
  }

  return app;
}

export async function startServer(): Promise<FastifyInstance> {
  const config = getConfig();

  if (!config.server) {
    throw new Error('Server config is required. Add a "server" section to config.yml.');
  }
  if (!config.server.apiToken) {
    throw new Error('server.api_token is required in config.yml.');
  }

  const app = createApp(config);

  const port = config.server.port ?? 3000;
  await app.listen({ port, host: '0.0.0.0' });

  const provider = config.openrouter ? `OpenRouter (${config.openrouter.model})` : 'Ollama';
  app.log.info(`Server listening on 0.0.0.0:${port} -- LLM: ${provider}`);

  return app;
}

// Start server when run directly
const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (isMain) {
  startServer().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
