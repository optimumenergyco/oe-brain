import type { FastifyInstance } from 'fastify';
import type { Services } from '../../mcp/server.js';

export async function contextRoutes(app: FastifyInstance, opts: { services: Services }) {
  const { services } = opts;

  app.get('/api/context/branch/:branch', async (request, reply) => {
    const { branch } = request.params as { branch: string };
    const { repo, project } = request.query as { repo?: string; project?: string };

    try {
      const entries = await services.database.getByBranch(branch, repo, project);
      return reply.send({ entries });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: 'Failed to get branch context', message });
    }
  });

  app.get('/api/context/project/:project', async (request, reply) => {
    const { project } = request.params as { project: string };
    const { since } = request.query as { since?: string };

    try {
      const sinceDate = since ? new Date(since) : undefined;
      const entries = await services.database.getByProject(project, sinceDate);
      return reply.send({ entries });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: 'Failed to get project context', message });
    }
  });

  app.get('/api/context/pr/:prNumber', async (request, reply) => {
    const { prNumber } = request.params as { prNumber: string };
    const { repo } = request.query as { repo: string };

    if (!repo) {
      return reply.status(400).send({ error: 'repo query parameter is required' });
    }

    try {
      const entries = await services.database.getByPr(parseInt(prNumber, 10), repo);
      return reply.send({ entries });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: 'Failed to get PR context', message });
    }
  });
}
