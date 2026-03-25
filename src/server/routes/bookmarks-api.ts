import type { FastifyInstance } from 'fastify';
import type { Services } from '../../mcp/server.js';

export async function bookmarksApiRoutes(app: FastifyInstance, opts: { services: Services }) {
  const { services } = opts;

  app.get('/api/bookmarks', async (request, reply) => {
    const { status, project, linkType, limit } = request.query as {
      status?: string;
      project?: string;
      linkType?: string;
      limit?: string;
    };

    try {
      const bookmarks = await services.database.getBookmarksByStatus(status ?? 'unread', {
        project,
        linkType,
        limit: limit ? parseInt(limit, 10) : undefined,
      });
      return reply.send({ bookmarks });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: 'Failed to list bookmarks', message });
    }
  });

  app.get('/api/bookmarks/search', async (request, reply) => {
    const { query, statusFilter } = request.query as { query?: string; statusFilter?: string };

    if (!query) {
      return reply.status(400).send({ error: 'query parameter is required' });
    }

    try {
      const bookmarks = await services.database.findBookmarkByQuery(query, statusFilter);
      return reply.send({ bookmarks });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: 'Failed to search bookmarks', message });
    }
  });
}
