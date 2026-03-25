import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Services } from '../server.js';
import type { ContextEntry } from '../../types.js';

function groupByRepoAndType(entries: ContextEntry[]): string {
  const groups = new Map<string, Map<string, ContextEntry[]>>();

  for (const entry of entries) {
    const repo = entry.repo ?? 'unknown';
    if (!groups.has(repo)) groups.set(repo, new Map());
    const repoGroup = groups.get(repo)!;
    if (!repoGroup.has(entry.type)) repoGroup.set(entry.type, []);
    repoGroup.get(entry.type)!.push(entry);
  }

  const parts: string[] = [];

  for (const [repo, typeMap] of groups) {
    parts.push(`# ${repo}`);
    parts.push('');

    for (const [type, typeEntries] of typeMap) {
      parts.push(`## ${type}`);
      parts.push('');
      for (const entry of typeEntries) {
        const date = entry.updatedAt.toISOString().slice(0, 10);
        parts.push(`### ${entry.title}`);
        parts.push(`*Updated: ${date}*`);
        if (entry.branch) parts.push(`*Branch: ${entry.branch}*`);
        if (entry.prNumber) parts.push(`*PR: #${entry.prNumber}*`);
        parts.push('');
        parts.push(entry.content);
        parts.push('');
      }
    }
  }

  return parts.join('\n');
}

export function registerProjectTools(server: McpServer, services: Services): void {
  server.registerTool(
    'get_project_context',
    {
      description:
        'Get all context entries for a project, grouped by repository and type. Useful for getting a broad overview of project activity and knowledge.',
      inputSchema: {
        project: z.string().describe('Project name'),
        since: z
          .string()
          .optional()
          .describe('Only include entries updated after this date (ISO 8601 format, e.g. 2024-01-15)'),
      },
    },
    async ({ project, since }) => {
      try {
        const sinceDate = since ? new Date(since) : undefined;
        const results = await services.database.getByProject(project, sinceDate);

        if (results.length === 0) {
          const msg = since
            ? `No context entries found for project "${project}" since ${since}.`
            : `No context entries found for project "${project}".`;
          return { content: [{ type: 'text' as const, text: msg }] };
        }

        const header = `Found ${results.length} entry(ies) for project "${project}":\n\n`;
        return { content: [{ type: 'text' as const, text: header + groupByRepoAndType(results) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Error getting project context: ${message}` }],
          isError: true,
        };
      }
    }
  );
}
