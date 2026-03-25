import { getConfig } from '../config.js';
import { getGitContext } from '../services/git.js';
import { VaultService } from '../services/vault.js';
import { EmbeddingsService } from '../services/embeddings.js';
import { DatabaseService } from '../services/database.js';
import { captureViaApi } from '../services/api-capture.js';
import type { ContextEntry } from '../types.js';

interface HookInput {
  cwd: string;
  tool_input?: {
    command?: string;
  };
}

export async function handlePrEvent(input: HookInput): Promise<void> {
  const { cwd, tool_input } = input;
  const command = tool_input?.command ?? '';

  if (!command.match(/gh\s+pr\s+(create|edit)/)) return;

  const config = getConfig();
  const gitCtx = await getGitContext(cwd, config);

  const now = new Date();
  const entry: ContextEntry = {
    type: 'pr_context',
    project: gitCtx.project,
    repo: gitCtx.repoName,
    branch: gitCtx.branch,
    title: `PR from ${gitCtx.branch}`,
    content: `## PR Event\nBranch: ${gitCtx.branch}\nCommand: \`${command}\`\nTimestamp: ${now.toISOString()}`,
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };

  if (config.api?.baseUrl) {
    try {
      await captureViaApi(entry, config.api);
    } catch {
      // API capture failed — non-blocking
    }
    return;
  }

  const vault = new VaultService(config.vaultPath, config.contextDir);
  const embeddings = new EmbeddingsService(config.ollama.baseUrl, config.ollama.model);
  const db = new DatabaseService(config.database.connectionString);

  const vaultPath = vault.writeEntry(entry);
  entry.vaultPath = vaultPath;

  try {
    if (await embeddings.isAvailable()) {
      const embedding = await embeddings.embed(entry.content);
      await db.upsertEntry(entry, embedding);
    }
  } catch {
    // Vault is primary, DB sync later
  }
}
