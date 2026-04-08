import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Services } from '../server.js';
import type { CodeSearchResult } from '../../types/code.js';

function formatCodeResult(result: CodeSearchResult): string {
  const parts: string[] = [];

  const location = result.lineStart
    ? `${result.filePath}:${result.lineStart}-${result.lineEnd}`
    : result.filePath;

  const metaParts = [result.repo, result.language, result.symbolType].filter(Boolean);
  const meta = metaParts.join(' | ');

  parts.push(`## ${result.symbolName ?? result.filePath}`);
  parts.push(`\`${location}\` (${meta}) — relevance: ${(result.score * 100).toFixed(0)}%`);
  parts.push('');
  parts.push('```' + (result.language ?? ''));
  parts.push(result.content.trim());
  parts.push('```');

  return parts.join('\n');
}

export function registerCodeSearchTools(server: McpServer, services: Services): void {
  server.registerTool(
    'search_code',
    {
      description:
        'Semantic code search across indexed repositories. Finds functions, classes, methods, and code snippets by meaning — use this instead of grep when you need to find code by what it does rather than exact text. Returns results with file:line references. Repos must be indexed first with `oe-brain index-code <repo-path>`.',
      inputSchema: {
        query: z.string().describe('Natural language query or code pattern, e.g. "authentication handler" or "def authenticate"'),
        repo: z.string().optional().describe('Filter to a specific repo, e.g. "core-ui" or "tesla-site"'),
        language: z.string().optional().describe('Filter by language: ruby, typescript, or tsx'),
        symbol_type: z.string().optional().describe('Filter by symbol type: function, class, method, module, interface, component, chunk'),
        limit: z.number().optional().describe('Maximum number of results (default 10)'),
      },
    },
    async ({ query, repo, language, symbol_type, limit }) => {
      try {
        const embedding = await services.embeddings.embed(query);
        const results = await (services.database as any).searchCode(embedding, query, {
          repo,
          language,
          symbolType: symbol_type,
          limit: limit ?? 10,
        });

        if (results.length === 0) {
          const hint = repo
            ? `No code found in repo "${repo}". Run: oe-brain index-code <path-to-${repo}>`
            : 'No code found. Repos must be indexed first — run: oe-brain index-code <repo-path>';
          return { content: [{ type: 'text' as const, text: hint }] };
        }

        const formatted = (results as CodeSearchResult[]).map(formatCodeResult).join('\n\n---\n\n');
        const header = `Found ${results.length} result(s):\n\n`;
        return { content: [{ type: 'text' as const, text: header + formatted }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Error searching code: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
