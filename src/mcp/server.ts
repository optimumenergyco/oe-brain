import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../types.js';
import type { IDatabaseService, IEmbeddingsService, IVaultService } from '../services/interfaces.js';
import { DatabaseService } from '../services/database.js';
import { EmbeddingsService } from '../services/embeddings.js';
import { VaultService } from '../services/vault.js';
import { ApiClientDatabaseService, ApiClientEmbeddingsService, ApiClientVaultService, ApiClientContext } from '../services/api-client.js';
import { registerSearchTools } from './tools/search.js';
import { registerBranchTools } from './tools/branch.js';
import { registerProjectTools } from './tools/project.js';
import { registerPrTools } from './tools/pr.js';
import { registerCaptureTools } from './tools/capture.js';
import { registerTaskTools } from './tools/tasks.js';
import { registerStandupTools } from './tools/standup.js';
import { registerNoteTools } from './tools/notes.js';
import { registerEmailTools } from './tools/email.js';
import { registerWebSearchTools } from './tools/web-search.js';
import { registerBookmarkTools } from './tools/bookmarks.js';
import { EmailService } from '../services/email.js';
import { SearxngService } from '../services/searxng.js';

export interface Services {
  database: IDatabaseService;
  embeddings: IEmbeddingsService;
  vault: IVaultService;
  config: Config;
}

export function createServer(config: Config): McpServer {
  const server = new McpServer({
    name: 'oe-brain',
    version: '0.1.0',
  });

  let services: Services;

  if (config.api?.baseUrl) {
    const ctx = new ApiClientContext();
    services = {
      database: new ApiClientDatabaseService(config.api.baseUrl, config.api.apiToken, ctx),
      embeddings: new ApiClientEmbeddingsService(ctx),
      vault: new ApiClientVaultService(),
      config,
    };
  } else {
    const database = new DatabaseService(config.database.connectionString);
    const embeddings = new EmbeddingsService(config.ollama.baseUrl, config.ollama.model);
    const vault = new VaultService(config.vaultPath, config.contextDir);
    services = { database, embeddings, vault, config };
  }

  registerSearchTools(server, services);
  registerBranchTools(server, services);
  registerProjectTools(server, services);
  registerPrTools(server, services);
  registerCaptureTools(server, services);
  registerTaskTools(server, services);
  registerStandupTools(server);
  registerNoteTools(server, services);
  registerBookmarkTools(server, services);

  if (config.email?.accounts && config.email.accounts.length > 0) {
    const emailService = new EmailService(config.email.accounts);
    registerEmailTools(server, emailService);
  }

  const searxngUrl = config.searxng?.baseUrl ?? 'http://localhost:8888';
  const searxng = new SearxngService(searxngUrl);
  registerWebSearchTools(server, searxng);

  return server;
}
