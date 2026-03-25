import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Services } from '../server.js';

export function registerNoteTools(server: McpServer, services: Services): void {
  server.registerTool(
    'edit_note',
    {
      description:
        'Edit an existing note (learned entry). Searches by title substring, then updates the title and/or content.',
      inputSchema: {
        query: z.string().describe('Title substring to match the note to edit'),
        new_title: z.string().optional().describe('New title for the note'),
        new_content: z.string().optional().describe('New content for the note'),
        project: z.string().optional().describe('Filter by project name'),
      },
    },
    async ({ query, new_title, new_content, project }) => {
      const matches = await services.database.findEntriesByQuery(query, 'learned', project);

      if (matches.length === 0) {
        return { content: [{ type: 'text' as const, text: `No note found matching "${query}".` }] };
      }

      if (matches.length > 1) {
        const list = matches.slice(0, 5).map((n) => `- ${n.title}`).join('\n');
        return {
          content: [{
            type: 'text' as const,
            text: `Multiple notes match "${query}". Be more specific:\n${list}`,
          }],
        };
      }

      const note = matches[0];
      if (new_title) note.title = new_title;
      if (new_content) note.content = new_content;
      note.updatedAt = new Date();

      // Re-write vault file
      const vaultPath = services.vault.writeEntry(note);
      note.vaultPath = vaultPath;

      // Re-embed and sync
      try {
        const available = await services.embeddings.isAvailable();
        if (available) {
          const embedding = await services.embeddings.embed(note.content);
          await services.database.upsertEntry(note, embedding);
        } else {
          await services.database.upsertEntry(note);
        }
      } catch {
        return {
          content: [{
            type: 'text' as const,
            text: `Updated "${note.title}" in vault. Warning: Supabase sync failed.`,
          }],
        };
      }

      return { content: [{ type: 'text' as const, text: `Updated note: "${note.title}"` }] };
    }
  );

  server.registerTool(
    'delete_note',
    {
      description:
        'Delete a note (learned entry). Searches by title substring, then deletes from both the vault and Supabase.',
      inputSchema: {
        query: z.string().describe('Title substring to match the note to delete'),
        project: z.string().optional().describe('Filter by project name'),
      },
    },
    async ({ query, project }) => {
      const matches = await services.database.findEntriesByQuery(query, 'learned', project);

      if (matches.length === 0) {
        return { content: [{ type: 'text' as const, text: `No note found matching "${query}".` }] };
      }

      if (matches.length > 1) {
        const list = matches.slice(0, 5).map((n) => `- ${n.title}`).join('\n');
        return {
          content: [{
            type: 'text' as const,
            text: `Multiple notes match "${query}". Be more specific:\n${list}`,
          }],
        };
      }

      const note = matches[0];

      // Delete vault file if it exists
      if (note.vaultPath) {
        services.vault.deleteEntry(note.vaultPath);
      }

      // Delete from Supabase
      if (note.id) {
        await services.database.deleteEntry(note.id);
      }

      return { content: [{ type: 'text' as const, text: `Deleted note: "${note.title}"` }] };
    }
  );

  server.registerTool(
    'search_notes',
    {
      description:
        'Search notes (learned entries) by keyword or semantic similarity. Returns matching notes with titles and content snippets.',
      inputSchema: {
        query: z.string().describe('Search query'),
        project: z.string().optional().describe('Filter by project name'),
        limit: z.number().optional().describe('Max results (default: 10)'),
      },
    },
    async ({ query, project, limit }) => {
      const maxResults = limit ?? 10;
      let results: import('../../types.js').ContextEntry[] = [];

      // Try semantic search first
      try {
        const available = await services.embeddings.isAvailable();
        if (available) {
          const embedding = await services.embeddings.embed(query);
          results = await services.database.searchByEmbedding(embedding, {
            type: 'learned',
            project,
            limit: maxResults,
          });
        }
      } catch {
        // Fall through to text search
      }

      // Fall back to text search if no embedding results
      if (results.length === 0) {
        results = await services.database.findEntriesByQuery(query, 'learned', project);
        results = results.slice(0, maxResults);
      }

      if (results.length === 0) {
        return { content: [{ type: 'text' as const, text: `No notes found matching "${query}".` }] };
      }

      const lines = results.map((n, i) => {
        const proj = n.project ? ` [${n.project}]` : '';
        const snippet = n.content.slice(0, 120).replace(/\n/g, ' ');
        return `${i + 1}. ${n.title}${proj}\n   ${snippet}...`;
      });

      return {
        content: [{
          type: 'text' as const,
          text: `Found ${results.length} note${results.length === 1 ? '' : 's'}:\n\n${lines.join('\n\n')}`,
        }],
      };
    }
  );
}
