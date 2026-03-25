import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../../mcp/server.js';

const searchBodySchema = z.object({
  query: z.string().min(1),
  project: z.string().optional(),
  repo: z.string().optional(),
  type: z.string().optional(),
  tag: z.string().optional(),
  limit: z.number().optional(),
  withScores: z.boolean().optional(),
  threshold: z.number().optional(),
});

export async function searchApiRoutes(app: FastifyInstance, opts: { services: Services }) {
  const { services } = opts;

  app.post('/api/search', async (request, reply) => {
    const parsed = searchBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.issues.map((i) => i.message) });
    }

    const { query, project, repo, type, tag, limit, withScores, threshold } = parsed.data;

    try {
      const available = await services.embeddings.isAvailable();
      if (!available) {
        // Fall back to text search
        const entries = await services.database.findEntriesByQuery(query, type, project);
        return reply.send({ results: entries });
      }

      const embedding = await services.embeddings.embed(query);

      if (withScores) {
        const scored = await services.database.searchWithScores(embedding, { limit, threshold });
        return reply.send({ results: scored.map((s) => ({ entry: s.entry, similarity: s.similarity })) });
      }

      const results = await services.database.searchByEmbedding(embedding, {
        project,
        repo,
        type: type as import('../../types.js').ContextType | undefined,
        tag,
        limit,
      });
      return reply.send({ results });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: 'Search failed', message });
    }
  });
}
