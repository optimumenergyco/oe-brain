import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../../mcp/server.js';

const embedBodySchema = z.object({
  text: z.string().min(1),
});

const batchEmbedBodySchema = z.object({
  texts: z.array(z.string().min(1)).min(1).max(100),
});

export async function embedApiRoutes(app: FastifyInstance, opts: { services: Services }) {
  const { services } = opts;

  app.post('/api/embed', async (request, reply) => {
    const parsed = embedBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.issues.map((i) => i.message) });
    }

    try {
      const available = await services.embeddings.isAvailable();
      if (!available) {
        return reply.status(503).send({ error: 'Embeddings service unavailable' });
      }

      const embedding = await services.embeddings.embed(parsed.data.text);
      return reply.send({ embedding });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: 'Embedding failed', message });
    }
  });

  app.post('/api/embed/batch', async (request, reply) => {
    const parsed = batchEmbedBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.issues.map((i) => i.message) });
    }

    try {
      const available = await services.embeddings.isAvailable();
      if (!available) {
        return reply.status(503).send({ error: 'Embeddings service unavailable' });
      }

      const embeddings = await Promise.all(
        parsed.data.texts.map((text) => services.embeddings.embed(text)),
      );
      return reply.send({ embeddings });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: 'Batch embedding failed', message });
    }
  });
}
