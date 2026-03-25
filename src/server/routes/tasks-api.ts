import type { FastifyInstance } from 'fastify';
import type { Services } from '../../mcp/server.js';

export async function tasksApiRoutes(app: FastifyInstance, opts: { services: Services }) {
  const { services } = opts;

  app.get('/api/tasks', async (request, reply) => {
    const { status, project, excludeProject, limit } = request.query as {
      status?: string;
      project?: string;
      excludeProject?: string;
      limit?: string;
    };

    try {
      const tasks = await services.database.getTasksByStatus(status ?? 'open', {
        project,
        excludeProject,
        limit: limit ? parseInt(limit, 10) : undefined,
      });
      return reply.send({ tasks });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: 'Failed to list tasks', message });
    }
  });

  app.get('/api/tasks/search', async (request, reply) => {
    const { query, project } = request.query as { query?: string; project?: string };

    if (!query) {
      return reply.status(400).send({ error: 'query parameter is required' });
    }

    try {
      const tasks = await services.database.findTasksByQuery(query, project);
      return reply.send({ tasks });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: 'Failed to search tasks', message });
    }
  });
}
