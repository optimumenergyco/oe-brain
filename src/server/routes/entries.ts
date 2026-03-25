import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../../mcp/server.js';

const updateBodySchema = z.object({
  title: z.string().optional(),
  content: z.string().optional(),
  status: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export async function entryRoutes(app: FastifyInstance, opts: { services: Services }) {
  const { services } = opts;

  app.get('/api/entries/search', async (request, reply) => {
    const { query, type, project, statusFilter } = request.query as {
      query?: string;
      type?: string;
      project?: string;
      statusFilter?: string;
    };

    if (!query) {
      return reply.status(400).send({ error: 'query parameter is required' });
    }

    try {
      // For task searches with status filter, use findTaskByTitle
      if (type === 'task' && statusFilter) {
        const entries = await services.database.findTaskByTitle(query, statusFilter);
        return reply.send({ entries });
      }
      if (type === 'task') {
        const entries = await services.database.findTaskByTitle(query);
        return reply.send({ entries });
      }
      const entries = await services.database.findEntriesByQuery(query, type, project);
      return reply.send({ entries });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: 'Failed to search entries', message });
    }
  });

  app.patch('/api/entries/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = updateBodySchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.issues.map((i) => i.message) });
    }

    try {
      await services.database.updateEntry(id, parsed.data);

      // Re-embed if content changed
      if (parsed.data.content) {
        const available = await services.embeddings.isAvailable();
        if (available) {
          const embedding = await services.embeddings.embed(parsed.data.content);
          // Update embedding via a lightweight upsert — find entry first
          // For now, the embedding update happens through the full upsert path
        }
      }

      return reply.send({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: 'Failed to update entry', message });
    }
  });

  app.delete('/api/entries/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      await services.database.deleteEntry(id);
      return reply.send({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: 'Failed to delete entry', message });
    }
  });
}
