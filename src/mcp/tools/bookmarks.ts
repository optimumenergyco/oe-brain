import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Services } from '../server.js';
import type { ContextEntry } from '../../types.js';
import { captureEntry } from '../../services/capture.js';

export function registerBookmarkTools(server: McpServer, services: Services): void {
  server.registerTool(
    'save_link',
    {
      description:
        'Save a link (article, video, etc.) to read or watch later. Stores the URL with a title and optional description.',
      inputSchema: {
        url: z.string().describe('The URL to save'),
        title: z.string().describe('Title or short description of the link'),
        description: z.string().optional().describe('Optional longer description or notes about the link'),
        link_type: z.enum(['article', 'video', 'podcast', 'other']).optional().describe('Type of content (default: article)'),
        tags: z.array(z.string()).optional().describe('Optional tags for categorization'),
        project: z.string().optional().describe('Project to associate with (default: personal)'),
      },
    },
    async ({ url, title, description, link_type, tags, project }) => {
      const now = new Date();
      const content = description
        ? `${url}\n\n${description}`
        : url;

      const entry: ContextEntry = {
        type: 'bookmark',
        title,
        content,
        project: project ?? 'personal',
        metadata: {
          status: 'unread',
          url,
          linkType: link_type ?? 'article',
          tags: tags ?? [],
        },
        createdAt: now,
        updatedAt: now,
      };

      const result = await captureEntry(entry, services);
      return { content: [{ type: 'text' as const, text: result }] };
    }
  );

  server.registerTool(
    'list_links',
    {
      description:
        'List saved links/bookmarks. Use this when the user asks about their reading list, saved links, or things to watch/read later.',
      inputSchema: {
        status: z.enum(['unread', 'read']).optional().describe('Filter by status (default: unread)'),
        link_type: z.enum(['article', 'video', 'podcast', 'other']).optional().describe('Filter by content type'),
        project: z.string().optional().describe('Filter by project name'),
        limit: z.number().optional().describe('Max results (default: 25)'),
      },
    },
    async ({ status, link_type, project, limit }) => {
      const bookmarks = await services.database.getBookmarksByStatus(
        status ?? 'unread',
        { project: project ?? undefined, linkType: link_type ?? undefined, limit: limit ?? 25 }
      );

      if (bookmarks.length === 0) {
        const filters: string[] = [];
        if (status) filters.push(status);
        if (link_type) filters.push(link_type);
        if (project) filters.push(`project "${project}"`);
        const scope = filters.length > 0 ? ` (${filters.join(', ')})` : '';
        return { content: [{ type: 'text' as const, text: `No ${status ?? 'unread'} bookmarks${scope}.` }] };
      }

      const lines = bookmarks.map((b, i) => {
        const parts: string[] = [];
        const meta = b.metadata as Record<string, unknown>;
        const typeLabel = meta.linkType ? `[${meta.linkType}]` : '';
        parts.push(`${i + 1}. ${typeLabel} ${b.title}`);
        if (meta.url) parts.push(`   URL: ${meta.url}`);
        if (b.project) parts.push(`   Project: ${b.project}`);
        const tags = meta.tags as string[] | undefined;
        if (tags && tags.length > 0) parts.push(`   Tags: ${tags.join(', ')}`);
        parts.push(`   Saved: ${b.createdAt.toISOString().slice(0, 10)}`);
        return parts.join('\n');
      });

      return { content: [{ type: 'text' as const, text: lines.join('\n\n') }] };
    }
  );

  server.registerTool(
    'complete_link',
    {
      description:
        'Mark a saved link as read/watched. Searches by title or URL substring.',
      inputSchema: {
        query: z.string().describe('Title or URL substring to find the bookmark'),
      },
    },
    async ({ query }) => {
      const matches = await services.database.findBookmarkByQuery(query, 'unread');

      if (matches.length === 0) {
        return { content: [{ type: 'text' as const, text: `No unread bookmark matching "${query}".` }] };
      }

      if (matches.length > 1) {
        const list = matches.map((b) => `- ${b.title}`).join('\n');
        return {
          content: [{
            type: 'text' as const,
            text: `Multiple bookmarks match "${query}". Be more specific:\n${list}`,
          }],
        };
      }

      const bookmark = matches[0];
      const now = new Date();
      bookmark.metadata = { ...bookmark.metadata, status: 'read', completedAt: now.toISOString() };
      bookmark.updatedAt = now;

      const vaultPath = services.vault.writeEntry(bookmark);
      bookmark.vaultPath = vaultPath;

      try {
        const available = await services.embeddings.isAvailable();
        if (available) {
          const embedding = await services.embeddings.embed(bookmark.content);
          await services.database.upsertEntry(bookmark, embedding);
        } else {
          await services.database.upsertEntry(bookmark);
        }
      } catch {
        return {
          content: [{
            type: 'text' as const,
            text: `Marked "${bookmark.title}" as read in vault. Warning: Supabase sync failed.`,
          }],
        };
      }

      return { content: [{ type: 'text' as const, text: `Marked as read: "${bookmark.title}"` }] };
    }
  );

  server.registerTool(
    'edit_link',
    {
      description:
        'Edit a saved bookmark\'s title, description, tags, or type.',
      inputSchema: {
        query: z.string().describe('Title or URL substring to find the bookmark'),
        new_title: z.string().optional().describe('New title'),
        new_description: z.string().optional().describe('New description'),
        new_tags: z.array(z.string()).optional().describe('New tags (replaces existing)'),
        new_link_type: z.enum(['article', 'video', 'podcast', 'other']).optional().describe('New content type'),
      },
    },
    async ({ query, new_title, new_description, new_tags, new_link_type }) => {
      const matches = await services.database.findBookmarkByQuery(query);

      if (matches.length === 0) {
        return { content: [{ type: 'text' as const, text: `No bookmark matching "${query}".` }] };
      }

      if (matches.length > 1) {
        const list = matches.map((b) => `- ${b.title}`).join('\n');
        return {
          content: [{
            type: 'text' as const,
            text: `Multiple bookmarks match "${query}". Be more specific:\n${list}`,
          }],
        };
      }

      const bookmark = matches[0];
      if (new_title) bookmark.title = new_title;
      if (new_description) {
        const url = (bookmark.metadata as Record<string, unknown>).url as string;
        bookmark.content = `${url}\n\n${new_description}`;
      }
      if (new_tags) bookmark.metadata = { ...bookmark.metadata, tags: new_tags };
      if (new_link_type) bookmark.metadata = { ...bookmark.metadata, linkType: new_link_type };
      bookmark.updatedAt = new Date();

      const vaultPath = services.vault.writeEntry(bookmark);
      bookmark.vaultPath = vaultPath;

      try {
        const available = await services.embeddings.isAvailable();
        if (available) {
          const embedding = await services.embeddings.embed(bookmark.content);
          await services.database.upsertEntry(bookmark, embedding);
        } else {
          await services.database.upsertEntry(bookmark);
        }
      } catch {
        return {
          content: [{
            type: 'text' as const,
            text: `Updated "${bookmark.title}" in vault. Warning: Supabase sync failed.`,
          }],
        };
      }

      return { content: [{ type: 'text' as const, text: `Updated bookmark: "${bookmark.title}"` }] };
    }
  );

  server.registerTool(
    'delete_link',
    {
      description:
        'Delete a saved bookmark. Searches by title or URL substring.',
      inputSchema: {
        query: z.string().describe('Title or URL substring to find the bookmark'),
      },
    },
    async ({ query }) => {
      const matches = await services.database.findBookmarkByQuery(query);

      if (matches.length === 0) {
        return { content: [{ type: 'text' as const, text: `No bookmark matching "${query}".` }] };
      }

      if (matches.length > 1) {
        const list = matches.map((b) => `- ${b.title}`).join('\n');
        return {
          content: [{
            type: 'text' as const,
            text: `Multiple bookmarks match "${query}". Be more specific:\n${list}`,
          }],
        };
      }

      const bookmark = matches[0];

      if (bookmark.vaultPath) {
        services.vault.deleteEntry(bookmark.vaultPath);
      }

      if (bookmark.id) {
        await services.database.deleteEntry(bookmark.id);
      }

      return { content: [{ type: 'text' as const, text: `Deleted bookmark: "${bookmark.title}"` }] };
    }
  );
}
