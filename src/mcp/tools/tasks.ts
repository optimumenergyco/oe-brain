import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Services } from '../server.js';

export function registerTaskTools(server: McpServer, services: Services): void {
  server.registerTool(
    'list_tasks',
    {
      description:
        'List tasks — use this tool whenever the user asks about their tasks, TODOs, or what they need to do. Returns all matching tasks with full metadata so you can filter, sort, and classify them yourself. When unsure which project a user means, call with no project filter and use the results to determine relevance.',
      inputSchema: {
        project: z.string().optional().describe('Filter by project name (case-insensitive). Omit to get tasks across ALL projects — prefer this when the user\'s intent is ambiguous.'),
        status: z.enum(['open', 'done']).optional().describe('Filter by status (default: open)'),
        limit: z.number().optional().describe('Max results (default: 50)'),
      },
    },
    async ({ project, status, limit }) => {
      const tasks = await services.database.getTasksByStatus(
        status ?? 'open',
        { project: project ?? undefined, limit: limit ?? 50 }
      );

      if (tasks.length === 0) {
        const scope = project ? ` for project "${project}"` : '';
        return { content: [{ type: 'text' as const, text: `No ${status ?? 'open'} tasks${scope}.` }] };
      }

      const lines = tasks.map((t, i) => {
        const parts: string[] = [];
        parts.push(`${i + 1}. ${t.title}`);
        if (t.project) parts.push(`   Project: ${t.project}`);
        if (t.content && t.content !== t.title) parts.push(`   Details: ${t.content}`);
        const meta = t.metadata as Record<string, unknown>;
        if (meta.status) parts.push(`   Status: ${meta.status}`);
        const tags = meta.tags as string[] | undefined;
        if (tags && tags.length > 0) parts.push(`   Tags: ${tags.join(', ')}`);
        parts.push(`   Created: ${t.createdAt.toISOString().slice(0, 10)}`);
        return parts.join('\n');
      });

      return { content: [{ type: 'text' as const, text: lines.join('\n\n') }] };
    }
  );

  server.registerTool(
    'edit_task',
    {
      description:
        'Edit a task\'s title, content, or status. Provide a search query to find the task — it searches both title and content.',
      inputSchema: {
        query: z.string().describe('Search query to find the task (searches title and content)'),
        new_title: z.string().optional().describe('New title for the task'),
        new_content: z.string().optional().describe('New content/description for the task'),
        new_status: z.enum(['open', 'done']).optional().describe('New status for the task'),
      },
    },
    async ({ query, new_title, new_content, new_status }) => {
      const matches = await services.database.findTaskByTitle(query);

      if (matches.length === 0) {
        return { content: [{ type: 'text' as const, text: `No task matching "${query}".` }] };
      }

      if (matches.length > 1) {
        const list = matches.map((t) => `- ${t.title}`).join('\n');
        return {
          content: [{
            type: 'text' as const,
            text: `Multiple tasks match "${query}". Be more specific:\n${list}`,
          }],
        };
      }

      const task = matches[0];
      if (new_title) task.title = new_title;
      if (new_content) task.content = new_content;
      if (new_status) task.metadata = { ...task.metadata, status: new_status };
      task.updatedAt = new Date();

      // Re-write vault file
      const vaultPath = services.vault.writeEntry(task);
      task.vaultPath = vaultPath;

      // Re-embed and sync
      try {
        const available = await services.embeddings.isAvailable();
        if (available) {
          const embedding = await services.embeddings.embed(task.content);
          await services.database.upsertEntry(task, embedding);
        } else {
          await services.database.upsertEntry(task);
        }
      } catch {
        return {
          content: [{
            type: 'text' as const,
            text: `Updated "${task.title}" in vault. Warning: Supabase sync failed.`,
          }],
        };
      }

      return { content: [{ type: 'text' as const, text: `Updated task: "${task.title}"` }] };
    }
  );

  server.registerTool(
    'delete_task',
    {
      description:
        'Delete a task. Provide the task title or a substring — it searches title and content across all tasks.',
      inputSchema: {
        title: z.string().describe('Task title or substring to search for'),
      },
    },
    async ({ title }) => {
      const matches = await services.database.findTaskByTitle(title);

      if (matches.length === 0) {
        return { content: [{ type: 'text' as const, text: `No task matching "${title}".` }] };
      }

      if (matches.length > 1) {
        const list = matches.map((t) => `- ${t.title}`).join('\n');
        return {
          content: [{
            type: 'text' as const,
            text: `Multiple tasks match "${title}". Be more specific:\n${list}`,
          }],
        };
      }

      const task = matches[0];

      // Delete vault file if it exists
      if (task.vaultPath) {
        services.vault.deleteEntry(task.vaultPath);
      }

      // Delete from Supabase
      try {
        if (task.id) {
          await services.database.deleteTask(task.id);
        }
      } catch {
        return {
          content: [{
            type: 'text' as const,
            text: `Deleted "${task.title}" from vault. Warning: Supabase delete failed.`,
          }],
        };
      }

      return { content: [{ type: 'text' as const, text: `Deleted task: "${task.title}"` }] };
    }
  );

  server.registerTool(
    'complete_task',
    {
      description:
        'Mark a task as done. Provide the task title or a substring — it searches title and content of open tasks.',
      inputSchema: {
        title: z.string().describe('Task title or substring to search for'),
      },
    },
    async ({ title }) => {
      const matches = await services.database.findTaskByTitle(title, 'open');

      if (matches.length === 0) {
        return { content: [{ type: 'text' as const, text: `No open task matching "${title}".` }] };
      }

      if (matches.length > 1) {
        const list = matches.map((t) => `- ${t.title}`).join('\n');
        return {
          content: [{
            type: 'text' as const,
            text: `Multiple tasks match "${title}". Be more specific:\n${list}`,
          }],
        };
      }

      const task = matches[0];
      const now = new Date();
      task.metadata = { ...task.metadata, status: 'done', completedAt: now.toISOString() };
      task.updatedAt = now;

      // Re-write vault file
      const vaultPath = services.vault.writeEntry(task);
      task.vaultPath = vaultPath;

      // Re-embed and sync
      try {
        const available = await services.embeddings.isAvailable();
        if (available) {
          const embedding = await services.embeddings.embed(task.content);
          await services.database.upsertEntry(task, embedding);
        } else {
          await services.database.upsertEntry(task);
        }
      } catch {
        return {
          content: [{
            type: 'text' as const,
            text: `Completed "${task.title}" in vault. Warning: Supabase sync failed.`,
          }],
        };
      }

      return { content: [{ type: 'text' as const, text: `Completed: "${task.title}"` }] };
    }
  );
}
