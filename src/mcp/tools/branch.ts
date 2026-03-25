import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Services } from '../server.js';
import type { ContextEntry } from '../../types.js';

function formatEntries(entries: ContextEntry[]): string {
  return entries
    .map((entry) => {
      const meta: string[] = [];
      meta.push(`**Type:** ${entry.type}`);
      if (entry.prNumber) meta.push(`**PR:** #${entry.prNumber}`);
      meta.push(`**Updated:** ${entry.updatedAt.toISOString().slice(0, 10)}`);

      return `## ${entry.title}\n\n${meta.join(' | ')}\n\n${entry.content}`;
    })
    .join('\n\n---\n\n');
}

export function registerBranchTools(server: McpServer, services: Services): void {
  server.registerTool(
    'get_branch_context',
    {
      description:
        'Get all context entries for a specific branch. Useful for resuming work on a branch or understanding what has been done.',
      inputSchema: {
        branch: z.string().optional().describe('Branch name (auto-detected from git if omitted)'),
        repo: z.string().optional().describe('Repository name (auto-detected if omitted)'),
        project: z.string().optional().describe('Project name (auto-detected if omitted)'),
      },
    },
    async ({ branch, repo, project }) => {
      try {
        if (!branch) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Error: branch name is required. Provide it explicitly or ensure git context is available.',
              },
            ],
            isError: true,
          };
        }

        const results = await services.database.getByBranch(branch, repo, project);

        if (results.length === 0) {
          return {
            content: [
              { type: 'text' as const, text: `No context entries found for branch "${branch}".` },
            ],
          };
        }

        const header = `Found ${results.length} entry(ies) for branch "${branch}":\n\n`;
        return { content: [{ type: 'text' as const, text: header + formatEntries(results) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Error getting branch context: ${message}` }],
          isError: true,
        };
      }
    }
  );
}
