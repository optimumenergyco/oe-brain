import type { ContextEntry, ContextType } from '../types.js';
import type { IDatabaseService, IEmbeddingsService, IVaultService } from './interfaces.js';

export class ApiClientContext {
  lastQueryText = '';
}

function deserializeEntry(raw: Record<string, unknown>): ContextEntry {
  return {
    id: raw.id as string | undefined,
    type: raw.type as ContextType,
    project: raw.project as string | undefined,
    repo: raw.repo as string | undefined,
    branch: raw.branch as string | undefined,
    prNumber: raw.prNumber as number | undefined,
    title: raw.title as string,
    content: raw.content as string,
    metadata: (raw.metadata as Record<string, unknown>) ?? {},
    createdAt: new Date(raw.createdAt as string),
    updatedAt: new Date(raw.updatedAt as string),
    vaultPath: raw.vaultPath as string | undefined,
  };
}

function deserializeEntries(raw: unknown[]): ContextEntry[] {
  return raw.map((r) => deserializeEntry(r as Record<string, unknown>));
}

export class ApiClientDatabaseService implements IDatabaseService {
  constructor(
    private baseUrl: string,
    private apiToken: string,
    private ctx: ApiClientContext,
  ) {}

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiToken}`,
    };
  }

  private async get(path: string, params?: Record<string, string | undefined>): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) url.searchParams.set(k, v);
      }
    }
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`API GET ${path} failed: ${res.status}`);
    return res.json();
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(new URL(path, this.baseUrl), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`API POST ${path} failed: ${res.status}`);
    return res.json();
  }

  private async patch(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(new URL(path, this.baseUrl), {
      method: 'PATCH',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`API PATCH ${path} failed: ${res.status}`);
    return res.json();
  }

  private async delete(path: string): Promise<void> {
    const res = await fetch(new URL(path, this.baseUrl), {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`API DELETE ${path} failed: ${res.status}`);
  }

  async close(): Promise<void> {
    // no-op for API client
  }

  async upsertEntry(entry: ContextEntry, _embedding?: number[]): Promise<void> {
    await this.post('/capture', {
      text: entry.content,
      title: entry.title,
      type: entry.type,
      tags: Array.isArray(entry.metadata?.tags) ? entry.metadata.tags : [],
      project: entry.project,
      repo: entry.repo,
      branch: entry.branch,
      prNumber: entry.prNumber,
      metadata: entry.metadata,
      id: entry.id,
    });
  }

  async searchByEmbedding(
    _embedding: number[],
    opts?: { project?: string; repo?: string; type?: ContextType; tag?: string; limit?: number },
  ): Promise<ContextEntry[]> {
    const data = await this.post('/api/search', {
      query: this.ctx.lastQueryText,
      project: opts?.project,
      repo: opts?.repo,
      type: opts?.type,
      tag: opts?.tag,
      limit: opts?.limit,
    }) as { results: unknown[] };
    return deserializeEntries(data.results);
  }

  async searchWithScores(
    _embedding: number[],
    opts?: { limit?: number; threshold?: number },
  ): Promise<Array<{ entry: ContextEntry; similarity: number }>> {
    const data = await this.post('/api/search', {
      query: this.ctx.lastQueryText,
      limit: opts?.limit,
      withScores: true,
      threshold: opts?.threshold,
    }) as { results: Array<{ entry: unknown; similarity: number }> };

    if (data.results.length > 0 && 'similarity' in data.results[0]) {
      return data.results.map((r) => ({
        entry: deserializeEntry(r.entry as Record<string, unknown>),
        similarity: r.similarity,
      }));
    }
    // Fallback: results are flat entries
    return (data.results as unknown[]).map((r) => ({
      entry: deserializeEntry(r as Record<string, unknown>),
      similarity: 1.0,
    }));
  }

  async getByBranch(branch: string, repo?: string, project?: string): Promise<ContextEntry[]> {
    const data = await this.get(`/api/context/branch/${encodeURIComponent(branch)}`, { repo, project }) as { entries: unknown[] };
    return deserializeEntries(data.entries);
  }

  async getByProject(project: string, since?: Date): Promise<ContextEntry[]> {
    const data = await this.get(`/api/context/project/${encodeURIComponent(project)}`, {
      since: since?.toISOString(),
    }) as { entries: unknown[] };
    return deserializeEntries(data.entries);
  }

  async getByPr(prNumber: number, repo: string): Promise<ContextEntry[]> {
    const data = await this.get(`/api/context/pr/${prNumber}`, { repo }) as { entries: unknown[] };
    return deserializeEntries(data.entries);
  }

  async getTasksByStatus(
    status: string,
    opts?: { project?: string; excludeProject?: string; limit?: number },
  ): Promise<ContextEntry[]> {
    const data = await this.get('/api/tasks', {
      status,
      project: opts?.project,
      excludeProject: opts?.excludeProject,
      limit: opts?.limit?.toString(),
    }) as { tasks: unknown[] };
    return deserializeEntries(data.tasks);
  }

  async findTaskByTitle(titleSubstring: string, statusFilter?: string): Promise<ContextEntry[]> {
    const data = await this.get('/api/entries/search', {
      query: titleSubstring,
      type: 'task',
      statusFilter,
    }) as { entries: unknown[] };
    return deserializeEntries(data.entries);
  }

  async findTasksByQuery(query: string, project?: string): Promise<ContextEntry[]> {
    const data = await this.get('/api/tasks/search', { query, project }) as { tasks: unknown[] };
    return deserializeEntries(data.tasks);
  }

  async getBookmarksByStatus(
    status: string,
    opts?: { project?: string; linkType?: string; limit?: number },
  ): Promise<ContextEntry[]> {
    const data = await this.get('/api/bookmarks', {
      status,
      project: opts?.project,
      linkType: opts?.linkType,
      limit: opts?.limit?.toString(),
    }) as { bookmarks: unknown[] };
    return deserializeEntries(data.bookmarks);
  }

  async findBookmarkByQuery(queryStr: string, statusFilter?: string): Promise<ContextEntry[]> {
    const data = await this.get('/api/bookmarks/search', {
      query: queryStr,
      statusFilter,
    }) as { bookmarks: unknown[] };
    return deserializeEntries(data.bookmarks);
  }

  async findEntriesByQuery(query: string, type?: string, project?: string): Promise<ContextEntry[]> {
    const data = await this.get('/api/entries/search', { query, type, project }) as { entries: unknown[] };
    return deserializeEntries(data.entries);
  }

  async updateTask(
    id: string,
    updates: { title?: string; content?: string; status?: string; metadata?: Record<string, unknown> },
  ): Promise<void> {
    await this.patch(`/api/entries/${id}`, updates);
  }

  async updateEntry(
    id: string,
    updates: { title?: string; content?: string; metadata?: Record<string, unknown> },
  ): Promise<void> {
    await this.patch(`/api/entries/${id}`, updates);
  }

  async deleteTask(id: string): Promise<void> {
    await this.delete(`/api/entries/${id}`);
  }

  async deleteEntry(id: string): Promise<void> {
    await this.delete(`/api/entries/${id}`);
  }
}

export class ApiClientEmbeddingsService implements IEmbeddingsService {
  constructor(private ctx: ApiClientContext) {}

  async embed(text: string): Promise<number[]> {
    this.ctx.lastQueryText = text;
    return [];
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

export class ApiClientVaultService implements IVaultService {
  writeEntry(_entry: ContextEntry): string {
    return '';
  }

  deleteEntry(_filePath: string): boolean {
    return true;
  }

  readEntry(_filePath: string): ContextEntry {
    throw new Error('readEntry is not supported in API client mode');
  }

  listEntries(_subdir?: string): ContextEntry[] {
    return [];
  }

  listAllEntries(): ContextEntry[] {
    return [];
  }
}
