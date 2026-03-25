import { getConfig } from '../config.js';
import { getGitContext } from '../services/git.js';
import { DatabaseService } from '../services/database.js';
import { ApiClientDatabaseService, ApiClientContext } from '../services/api-client.js';
import type { IDatabaseService } from '../services/interfaces.js';

interface SessionStartInput {
  cwd: string;
}

export async function handleSessionStart(input: SessionStartInput): Promise<string> {
  const config = getConfig();

  let gitCtx;
  try {
    gitCtx = await getGitContext(input.cwd, config);
  } catch {
    return '';  // Not in a git repo — no context to inject
  }

  let db: IDatabaseService;
  if (config.api?.baseUrl) {
    const ctx = new ApiClientContext();
    db = new ApiClientDatabaseService(config.api.baseUrl, config.api.apiToken, ctx);
  } else {
    db = new DatabaseService(config.database.connectionString);
  }

  const parts: string[] = [];

  // Get branch context
  const branchContext = await db.getByBranch(gitCtx.branch, gitCtx.repoName, gitCtx.project);
  if (branchContext.length > 0) {
    parts.push(`## Current Branch: ${gitCtx.branch}\n\n${branchContext[0].content}`);
  }

  // Get recent project context
  if (gitCtx.project) {
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const projectContext = await db.getByProject(gitCtx.project, oneWeekAgo);

    const otherEntries = projectContext
      .filter((e) => e.branch !== gitCtx!.branch)
      .slice(0, 5);

    if (otherEntries.length > 0) {
      const summaries = otherEntries.map((e) => `- **${e.title}** (${e.type}): ${e.content.split('\n')[0]}`);
      parts.push(`## Recent Project Activity (${gitCtx.project})\n\n${summaries.join('\n')}`);
    }
  }

  if (parts.length === 0) return '';

  return `# OE-Brain Context\n\n${parts.join('\n\n---\n\n')}`;
}
