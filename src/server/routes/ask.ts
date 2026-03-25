import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AskPipeline } from '../../services/ask-pipeline.js';
import type { Services } from '../../mcp/server.js';
import type { IntentRouter } from '../../services/intent-router.js';
import type { ConversationService } from '../../services/conversation.js';
import type { ChatService } from '../../services/ollama-chat.js';
import type { ContextEntry } from '../../types.js';
import { captureEntry } from '../../services/capture.js';
import { createAppleReminder, updateAppleReminder, deleteAppleReminder, listAppleReminders, sendIMessage } from '../../services/reminders.js';

const askBodySchema = z.object({
  text: z.string().min(1, 'text is required'),
  conversation_id: z.string().uuid().optional(),
});

export interface AskRouteDeps {
  askPipeline: AskPipeline;
  services: Services;
  intentRouter: IntentRouter;
  conversations: ConversationService;
  chatService: ChatService;
}

export async function askRoutes(
  app: FastifyInstance,
  opts: AskRouteDeps,
) {
  const { askPipeline, services, intentRouter, conversations, chatService } = opts;

  app.post('/ask', async (request, reply) => {
    const parsed = askBodySchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Invalid request body',
        details: parsed.error.issues.map((i) => i.message),
      });
    }

    const { text, conversation_id } = parsed.data;

    // Get or create conversation
    let conversationId: string;
    if (conversation_id) {
      const existing = await conversations.getConversation(conversation_id);
      conversationId = existing ? existing.id : (await conversations.createConversation(text.slice(0, 60))).id;
    } else {
      conversationId = (await conversations.createConversation(text.slice(0, 60))).id;
    }

    // Store user message
    await conversations.addMessage(conversationId, 'user', text);

    // Get recent messages for context
    const recentMessages = await conversations.getRecentMessages(conversationId);
    const history = recentMessages
      .slice(0, -1) // exclude the message we just added
      .map((m) => ({ role: m.role, content: m.content }));

    // Classify intent
    const intent = await intentRouter.classify(text, history);
    console.log('[ask] intent:', JSON.stringify(intent));

    let answer: string;
    let sources: unknown[] = [];
    let route: string = intent.intent;
    let model: string = 'none';

    try {
      switch (intent.intent) {
        case 'ask': {
          const result = await askPipeline.ask(text, history);
          answer = result.answer;
          sources = result.sources;
          route = result.route;
          model = result.model;
          break;
        }

        case 'reminder': {
          const rawDate = intent.reminder_time ? new Date(intent.reminder_time) : null;
          const reminderDate = rawDate && !isNaN(rawDate.getTime()) ? rawDate : new Date(Date.now() + 60_000);
          console.log('[reminder] title:', intent.title, 'raw_time:', intent.reminder_time, 'parsed:', reminderDate.toISOString());
          const warning = await createAppleReminder(intent.title ?? text, reminderDate);
          const timeStr = reminderDate.toLocaleString('en-US', {
            weekday: 'short', month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit',
          });
          answer = warning
            ? `⚠️ ${warning}`
            : `Reminder set: "${intent.title ?? text}" — ${timeStr}`;
          route = 'reminder';
          break;
        }

        case 'capture_task': {
          const now = new Date();
          const entry: ContextEntry = {
            type: 'task',
            title: intent.title ?? text.slice(0, 60),
            content: intent.content ?? text,
            project: intent.project,
            metadata: { tags: intent.tags ?? [], status: 'open' },
            createdAt: now,
            updatedAt: now,
          };
          await captureEntry(entry, services);
          answer = `Task captured: "${entry.title}"`;
          route = 'capture';
          break;
        }

        case 'capture_note': {
          const now = new Date();
          const entry: ContextEntry = {
            type: 'learned',
            title: intent.title ?? text.slice(0, 60),
            content: intent.content ?? text,
            project: intent.project,
            metadata: { tags: intent.tags ?? [] },
            createdAt: now,
            updatedAt: now,
          };
          await captureEntry(entry, services);
          answer = `Saved to OE-Brain: "${entry.title}"`;
          route = 'capture';
          break;
        }

        case 'update_task': {
          if (!intent.update_query) {
            answer = 'Could not determine which task to update.';
            break;
          }
          // Strip list numbering and project suffix from query
          const updateQuery = intent.update_query
            .replace(/^\d+\.\s*/, '')
            .replace(/\s*\[[^\]]*\]\s*$/, '')
            .trim();
          const matches = await services.database.findTaskByTitle(updateQuery);
          if (matches.length === 0) {
            answer = `No task found matching "${intent.update_query}".`;
            break;
          }
          const task = matches[0];
          if (intent.new_title) task.title = intent.new_title;
          if (intent.new_description) task.content = intent.new_description;
          task.updatedAt = new Date();

          const available = await services.embeddings.isAvailable();
          if (available) {
            const embedding = await services.embeddings.embed(task.content);
            await services.database.upsertEntry(task, embedding);
          } else {
            await services.database.upsertEntry(task);
          }
          answer = `Updated task: "${task.title}"`;
          route = 'update';
          break;
        }

        case 'delete_task': {
          const rawDeleteQuery = intent.update_query ?? intent.title ?? text;
          // Strip list numbering (e.g. "9. ") and project suffix (e.g. " [work]") that
          // appear in the displayed task list but aren't part of the actual title
          const deleteQuery = rawDeleteQuery
            .replace(/^\d+\.\s*/, '')
            .replace(/\s*\[[^\]]*\]\s*$/, '')
            .trim();
          const taskMatches = await services.database.findTaskByTitle(deleteQuery);
          if (taskMatches.length === 0) {
            answer = `No task found matching "${deleteQuery}".`;
            break;
          }
          if (taskMatches.length > 1) {
            const list = taskMatches.map((t) => `- ${t.title}`).join('\n');
            answer = `Multiple tasks match "${deleteQuery}". Be more specific:\n${list}`;
            break;
          }
          const taskToDelete = taskMatches[0];

          // Delete vault file if it exists
          if (taskToDelete.vaultPath) {
            services.vault.deleteEntry(taskToDelete.vaultPath);
          }

          // Delete from Supabase
          if (taskToDelete.id) {
            await services.database.deleteTask(taskToDelete.id);
          }

          answer = `Deleted task: "${taskToDelete.title}"`;
          route = 'delete_task';
          break;
        }

        case 'list_tasks': {
          const tasks = await services.database.getTasksByStatus('open', {
            project: intent.project,
            excludeProject: intent.exclude_project,
            limit: 20,
          });
          if (tasks.length === 0) {
            answer = 'No open tasks found.';
          } else {
            const lines = tasks.map((t, i) => {
              const project = t.project ? ` [${t.project}]` : '';
              return `${i + 1}. ${t.title}${project}`;
            });
            answer = `You have ${tasks.length} open task${tasks.length === 1 ? '' : 's'}:\n\n${lines.join('\n')}`;
          }
          route = 'list_tasks';
          break;
        }

        case 'send_message': {
          if (!intent.recipient) {
            answer = 'Who should I send the message to? Please include a name or phone number.';
            break;
          }
          if (!intent.message_body) {
            answer = `What would you like to say to ${intent.recipient}?`;
            break;
          }
          const sendErr = await sendIMessage(intent.recipient, intent.message_body, chatService);
          answer = sendErr
            ? `⚠️ ${sendErr}`
            : `Message sent to ${intent.recipient}: "${intent.message_body}"`;
          route = 'send_message';
          break;
        }

        case 'update_reminder': {
          if (!intent.update_query) {
            answer = 'Could not determine which reminder to update.';
            break;
          }
          const updates: { newTitle?: string; newDate?: Date } = {};
          if (intent.new_title) updates.newTitle = intent.new_title;
          if (intent.reminder_time) updates.newDate = new Date(intent.reminder_time);
          const result = await updateAppleReminder(intent.update_query, updates);
          answer = result
            ? `⚠️ ${result}`
            : `Updated reminder: "${intent.update_query}"`;
          route = 'update';
          break;
        }

        case 'delete_reminder': {
          const deleteQuery = intent.update_query ?? intent.title ?? text;
          const deleteResult = await deleteAppleReminder(deleteQuery);
          answer = deleteResult
            ? `⚠️ ${deleteResult}`
            : `Deleted reminder: "${deleteQuery}"`;
          route = 'delete_reminder';
          break;
        }

        case 'list_reminders': {
          const reminders = await listAppleReminders(intent.list_name);
          if (reminders.length === 0) {
            answer = intent.list_name
              ? `No reminders found in "${intent.list_name}".`
              : 'No uncompleted reminders found.';
          } else {
            const lines = reminders.map((r, i) => {
              const date = r.remindDate ? ` — ${r.remindDate}` : '';
              const list = r.list ? ` [${r.list}]` : '';
              return `${i + 1}. ${r.title}${date}${list}`;
            });
            answer = `You have ${reminders.length} reminder${reminders.length === 1 ? '' : 's'}:\n\n${lines.join('\n')}`;
          }
          route = 'list_reminders';
          break;
        }

        case 'edit_note': {
          const editQuery = intent.update_query ?? intent.title ?? text;
          const noteMatches = await services.database.findEntriesByQuery(editQuery, 'learned');
          if (noteMatches.length === 0) {
            answer = `No note found matching "${editQuery}".`;
            break;
          }
          if (noteMatches.length > 1) {
            const list = noteMatches.slice(0, 5).map((n) => `- ${n.title}`).join('\n');
            answer = `Multiple notes match "${editQuery}". Be more specific:\n${list}`;
            break;
          }
          const noteToEdit = noteMatches[0];
          if (intent.new_title) noteToEdit.title = intent.new_title;
          if (intent.new_description) noteToEdit.content = intent.new_description;
          if (intent.content) noteToEdit.content = intent.content;
          noteToEdit.updatedAt = new Date();

          // Re-write vault file
          const editVaultPath = services.vault.writeEntry(noteToEdit);
          noteToEdit.vaultPath = editVaultPath;

          // Re-embed and sync
          const editAvailable = await services.embeddings.isAvailable();
          if (editAvailable) {
            const embedding = await services.embeddings.embed(noteToEdit.content);
            await services.database.upsertEntry(noteToEdit, embedding);
          } else {
            await services.database.upsertEntry(noteToEdit);
          }
          answer = `Updated note: "${noteToEdit.title}"`;
          route = 'edit_note';
          break;
        }

        case 'delete_note': {
          const deleteNoteQuery = intent.update_query ?? intent.title ?? text;
          const deleteNoteMatches = await services.database.findEntriesByQuery(deleteNoteQuery, 'learned');
          if (deleteNoteMatches.length === 0) {
            answer = `No note found matching "${deleteNoteQuery}".`;
            break;
          }
          if (deleteNoteMatches.length > 1) {
            const list = deleteNoteMatches.slice(0, 5).map((n) => `- ${n.title}`).join('\n');
            answer = `Multiple notes match "${deleteNoteQuery}". Be more specific:\n${list}`;
            break;
          }
          const noteToDelete = deleteNoteMatches[0];

          // Delete vault file if it exists
          if (noteToDelete.vaultPath) {
            services.vault.deleteEntry(noteToDelete.vaultPath);
          }

          // Delete from Supabase
          if (noteToDelete.id) {
            await services.database.deleteEntry(noteToDelete.id);
          }

          answer = `Deleted note: "${noteToDelete.title}"`;
          route = 'delete_note';
          break;
        }

        case 'search_notes': {
          const searchQuery = intent.update_query ?? intent.title ?? text;
          let searchResults: import('../../types.js').ContextEntry[] = [];

          // Try semantic search first via embeddings
          const searchAvailable = await services.embeddings.isAvailable();
          if (searchAvailable) {
            const searchEmbedding = await services.embeddings.embed(searchQuery);
            searchResults = await services.database.searchByEmbedding(searchEmbedding, {
              type: 'learned',
              limit: 10,
            });
          }

          // Fall back to text search if no embedding results
          if (searchResults.length === 0) {
            searchResults = await services.database.findEntriesByQuery(searchQuery, 'learned');
          }

          if (searchResults.length === 0) {
            answer = `No notes found matching "${searchQuery}".`;
          } else {
            const lines = searchResults.slice(0, 10).map((n, i) => {
              const project = n.project ? ` [${n.project}]` : '';
              const snippet = n.content.slice(0, 100).replace(/\n/g, ' ');
              return `${i + 1}. **${n.title}**${project}\n   ${snippet}...`;
            });
            answer = `Found ${searchResults.length} note${searchResults.length === 1 ? '' : 's'}:\n\n${lines.join('\n\n')}`;
          }
          route = 'search_notes';
          break;
        }

        case 'save_link': {
          const now = new Date();
          const url = intent.url ?? text;
          const linkContent = intent.description
            ? `${url}\n\n${intent.description}`
            : url;
          const linkEntry: ContextEntry = {
            type: 'bookmark',
            title: intent.title ?? url.slice(0, 60),
            content: linkContent,
            project: intent.project ?? 'personal',
            metadata: {
              status: 'unread',
              url,
              linkType: intent.link_type ?? 'article',
              tags: intent.tags ?? [],
            },
            createdAt: now,
            updatedAt: now,
          };
          await captureEntry(linkEntry, services);
          answer = `Saved link: "${linkEntry.title}"`;
          route = 'save_link';
          break;
        }

        case 'list_links': {
          const bookmarks = await services.database.getBookmarksByStatus('unread', {
            project: intent.project,
            limit: 20,
          });
          if (bookmarks.length === 0) {
            answer = 'No saved links to read/watch.';
          } else {
            const lines = bookmarks.map((b, i) => {
              const meta = b.metadata as Record<string, unknown>;
              const typeLabel = meta.linkType ? `[${meta.linkType}]` : '';
              const project = b.project ? ` [${b.project}]` : '';
              return `${i + 1}. ${typeLabel} ${b.title}${project}\n   ${meta.url}`;
            });
            answer = `You have ${bookmarks.length} saved link${bookmarks.length === 1 ? '' : 's'}:\n\n${lines.join('\n\n')}`;
          }
          route = 'list_links';
          break;
        }

        case 'complete_link': {
          const completeQuery = intent.update_query ?? intent.title ?? text;
          const linkMatches = await services.database.findBookmarkByQuery(completeQuery, 'unread');
          if (linkMatches.length === 0) {
            answer = `No unread bookmark matching "${completeQuery}".`;
            break;
          }
          if (linkMatches.length > 1) {
            const list = linkMatches.map((b) => `- ${b.title}`).join('\n');
            answer = `Multiple bookmarks match "${completeQuery}". Be more specific:\n${list}`;
            break;
          }
          const linkToComplete = linkMatches[0];
          linkToComplete.metadata = { ...linkToComplete.metadata, status: 'read', completedAt: new Date().toISOString() };
          linkToComplete.updatedAt = new Date();

          const completePath = services.vault.writeEntry(linkToComplete);
          linkToComplete.vaultPath = completePath;

          const completeAvailable = await services.embeddings.isAvailable();
          if (completeAvailable) {
            const embedding = await services.embeddings.embed(linkToComplete.content);
            await services.database.upsertEntry(linkToComplete, embedding);
          } else {
            await services.database.upsertEntry(linkToComplete);
          }
          answer = `Marked as read: "${linkToComplete.title}"`;
          route = 'complete_link';
          break;
        }

        case 'delete_link': {
          const deleteLinkQuery = intent.update_query ?? intent.title ?? text;
          const deleteLinkMatches = await services.database.findBookmarkByQuery(deleteLinkQuery);
          if (deleteLinkMatches.length === 0) {
            answer = `No bookmark matching "${deleteLinkQuery}".`;
            break;
          }
          if (deleteLinkMatches.length > 1) {
            const list = deleteLinkMatches.map((b) => `- ${b.title}`).join('\n');
            answer = `Multiple bookmarks match "${deleteLinkQuery}". Be more specific:\n${list}`;
            break;
          }
          const linkToDelete = deleteLinkMatches[0];
          if (linkToDelete.vaultPath) services.vault.deleteEntry(linkToDelete.vaultPath);
          if (linkToDelete.id) await services.database.deleteEntry(linkToDelete.id);
          answer = `Deleted bookmark: "${linkToDelete.title}"`;
          route = 'delete_link';
          break;
        }

        default:
          answer = 'Unrecognized intent.';
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: 'Ask failed', message });
    }

    // Store assistant response with metadata
    try {
      await conversations.addMessage(conversationId, 'assistant', answer, {
        route,
        model,
        sources,
        intent: intent.intent,
      });
    } catch (storeError) {
      const msg = storeError instanceof Error ? storeError.message : String(storeError);
      console.error(`[ask] Failed to store assistant message: ${msg}`);
      // Still return the answer even if storage failed
    }

    return reply.send({
      answer,
      sources,
      route,
      model,
      conversation_id: conversationId,
    });
  });
}
