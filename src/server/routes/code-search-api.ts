import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../../mcp/server.js';
import type { DatabaseService } from '../../services/database.js';

const searchCodeBodySchema = z.object({
  embedding: z.array(z.number()).min(1),
  query_text: z.string().min(1),
  repo: z.string().optional(),
  language: z.string().optional(),
  symbol_type: z.string().optional(),
  limit: z.number().optional(),
});

const indexStatusSchema = z.object({});

const dropRepoSchema = z.object({
  repo: z.string().min(1),
});

export async function codeSearchApiRoutes(app: FastifyInstance, opts: { services: Services }) {
  const { services } = opts;
  const db = services.database as DatabaseService;

  app.post('/api/search-code', async (request, reply) => {
    const parsed = searchCodeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.issues.map((i) => i.message) });
    }

    const { embedding, query_text, repo, language, symbol_type, limit } = parsed.data;

    try {
      const results = await db.searchCode(embedding, query_text, {
        repo,
        language,
        symbolType: symbol_type,
        limit: limit ?? 10,
      });
      return reply.send({ results });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: 'Code search failed', message });
    }
  });

  app.get('/api/code-index/status', async (_request, reply) => {
    try {
      const status = await db.getCodeIndexStatus();
      return reply.send({ repos: status });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: 'Failed to get index status', message });
    }
  });
}
