import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Services } from '../server.js';
import type { ContextEntry } from '../../types.js';

function formatPrEntries(entries: ContextEntry[]): string {
  return entries
    .map((entry) => {
      const meta: string[] = [];
      meta.push(`**Type:** ${entry.type}`);
      if (entry.branch) meta.push(`**Branch:** ${entry.branch}`);
      meta.push(`**Updated:** ${entry.updatedAt.toISOString().slice(0, 10)}`);

      return `## ${entry.title}\n\n${meta.join(' | ')}\n\n${entry.content}`;
    })
    .join('\n\n---\n\n');
}

export function registerPrTools(server: McpServer, services: Services): void {
  server.registerTool(
    'get_pr_context',
    {
      description:
        'Get all context entries associated with a specific pull request. Returns PR summaries, related decisions, and any linked context.',
      inputSchema: {
        pr_number: z.number().describe('The pull request number'),
        repo: z.string().describe('The repository name'),
      },
    },
    async ({ pr_number, repo }) => {
      try {
        const results = await services.database.getByPr(pr_number, repo);

        if (results.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No context entries found for PR #${pr_number} in ${repo}.`,
              },
            ],
          };
        }

        const header = `Found ${results.length} entry(ies) for PR #${pr_number} in ${repo}:\n\n`;
        return { content: [{ type: 'text' as const, text: header + formatPrEntries(results) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Error getting PR context: ${message}` }],
          isError: true,
        };
      }
    }
  );
}
