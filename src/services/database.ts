import pg from 'pg';
import type { ContextEntry, ContextType } from '../types.js';

const { Pool } = pg;

interface DbRow {
  id?: string;
  type: string;
  project: string | null;
  repo: string | null;
  branch: string | null;
  pr_number: number | null;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  vault_path: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  similarity?: number;
}

export class DatabaseService {
  private pool: InstanceType<typeof Pool>;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async upsertEntry(entry: ContextEntry, embedding?: number[]): Promise<void> {
    const embeddingStr = embedding ? `[${embedding.join(',')}]` : null;
    await this.pool.query(
      `INSERT INTO context_entries
        (id, type, project, repo, branch, pr_number, title, content, embedding, metadata, vault_path, created_at, updated_at)
      VALUES
        (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9::vector, $10, $11, $12, $13)
      ON CONFLICT (vault_path) DO UPDATE SET
        type = EXCLUDED.type,
        project = EXCLUDED.project,
        repo = EXCLUDED.repo,
        branch = EXCLUDED.branch,
        pr_number = EXCLUDED.pr_number,
        title = EXCLUDED.title,
        content = EXCLUDED.content,
        embedding = COALESCE(EXCLUDED.embedding, context_entries.embedding),
        metadata = EXCLUDED.metadata,
        updated_at = EXCLUDED.updated_at`,
      [
        entry.id ?? null,
        entry.type,
        entry.project ?? null,
        entry.repo ?? null,
        entry.branch ?? null,
        entry.prNumber ?? null,
        entry.title,
        entry.content,
        embeddingStr,
        JSON.stringify(entry.metadata),
        entry.vaultPath ?? null,
        entry.createdAt.toISOString(),
        entry.updatedAt.toISOString(),
      ],
    );
  }

  async searchByEmbedding(
    embedding: number[],
    opts?: { project?: string; repo?: string; type?: ContextType; tag?: string; limit?: number },
  ): Promise<ContextEntry[]> {
    const matchCount = opts?.tag ? (opts?.limit ?? 10) * 3 : (opts?.limit ?? 10);
    const embeddingStr = `[${embedding.join(',')}]`;

    const { rows } = await this.pool.query(
      `SELECT * FROM match_context_entries($1::vector, $2, $3, $4, $5)`,
      [embeddingStr, matchCount, opts?.project ?? null, opts?.repo ?? null, opts?.type ?? null],
    );

    let results = rows.map((r: DbRow) => this.toContextEntry(r));

    if (opts?.tag) {
      results = results.filter((entry: ContextEntry) => {
        const tags = entry.metadata?.tags;
        return Array.isArray(tags) && tags.includes(opts.tag);
      });
      results = results.slice(0, opts?.limit ?? 10);
    }

    return results;
  }

  async getByBranch(branch: string, repo?: string, project?: string): Promise<ContextEntry[]> {
    const conditions = ['branch = $1'];
    const params: unknown[] = [branch];

    if (repo) {
      params.push(repo);
      conditions.push(`repo = $${params.length}`);
    }
    if (project) {
      params.push(project);
      conditions.push(`project = $${params.length}`);
    }

    const { rows } = await this.pool.query(
      `SELECT * FROM context_entries WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC`,
      params,
    );
    return rows.map((r: DbRow) => this.toContextEntry(r));
  }

  async getByProject(project: string, since?: Date): Promise<ContextEntry[]> {
    const conditions = ['project = $1'];
    const params: unknown[] = [project];

    if (since) {
      params.push(since.toISOString());
      conditions.push(`updated_at >= $${params.length}`);
    }

    const { rows } = await this.pool.query(
      `SELECT * FROM context_entries WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC`,
      params,
    );
    return rows.map((r: DbRow) => this.toContextEntry(r));
  }

  async getByPr(prNumber: number, repo: string): Promise<ContextEntry[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM context_entries WHERE pr_number = $1 AND repo = $2`,
      [prNumber, repo],
    );
    return rows.map((r: DbRow) => this.toContextEntry(r));
  }

  async getTasksByStatus(
    status: string,
    opts?: { project?: string; excludeProject?: string; limit?: number },
  ): Promise<ContextEntry[]> {
    const conditions = ["type = $1", "metadata->>'status' = $2"];
    const params: unknown[] = ['task', status];

    if (opts?.project) {
      params.push(`%${opts.project}%`);
      const i = params.length;
      conditions.push(`(project ILIKE $${i} OR title ILIKE $${i} OR content ILIKE $${i})`);
    }
    if (opts?.excludeProject) {
      params.push(`%${opts.excludeProject}%`);
      const i = params.length;
      conditions.push(`(project IS NULL OR project NOT ILIKE $${i})`);
      conditions.push(`title NOT ILIKE $${i}`);
    }

    let sql = `SELECT * FROM context_entries WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`;
    if (opts?.limit) {
      params.push(opts.limit);
      sql += ` LIMIT $${params.length}`;
    }

    const { rows } = await this.pool.query(sql, params);
    return rows.map((r: DbRow) => this.toContextEntry(r));
  }

  async findTaskByTitle(titleSubstring: string, statusFilter?: string): Promise<ContextEntry[]> {
    const conditions = ["type = $1", "(title ILIKE $2 OR content ILIKE $2)"];
    const params: unknown[] = ['task', `%${titleSubstring}%`];

    if (statusFilter) {
      params.push(statusFilter);
      conditions.push(`metadata->>'status' = $${params.length}`);
    }

    const { rows } = await this.pool.query(
      `SELECT * FROM context_entries WHERE ${conditions.join(' AND ')}`,
      params,
    );
    return rows.map((r: DbRow) => this.toContextEntry(r));
  }

  async searchWithScores(
    embedding: number[],
    opts?: { limit?: number; threshold?: number },
  ): Promise<Array<{ entry: ContextEntry; similarity: number }>> {
    const embeddingStr = `[${embedding.join(',')}]`;
    const { rows } = await this.pool.query(
      `SELECT * FROM match_context_entries($1::vector, $2, $3, $4, $5)`,
      [embeddingStr, opts?.limit ?? 5, null, null, null],
    );

    const threshold = opts?.threshold ?? 0.65;
    return rows
      .filter((row: DbRow) => (row.similarity ?? 0) >= threshold)
      .map((row: DbRow) => ({
        entry: this.toContextEntry(row),
        similarity: row.similarity ?? 0,
      }));
  }

  async deleteTask(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM context_entries WHERE id = $1`, [id]);
  }

  async deleteEntry(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM context_entries WHERE id = $1`, [id]);
  }

  async updateTask(
    id: string,
    updates: { title?: string; content?: string; status?: string; metadata?: Record<string, unknown> },
  ): Promise<void> {
    const sets = ['updated_at = NOW()'];
    const params: unknown[] = [];

    if (updates.title !== undefined) {
      params.push(updates.title);
      sets.push(`title = $${params.length}`);
    }
    if (updates.content !== undefined) {
      params.push(updates.content);
      sets.push(`content = $${params.length}`);
    }
    if (updates.metadata !== undefined) {
      params.push(JSON.stringify(updates.metadata));
      sets.push(`metadata = $${params.length}`);
    }

    params.push(id);
    await this.pool.query(
      `UPDATE context_entries SET ${sets.join(', ')} WHERE id = $${params.length}`,
      params,
    );
  }

  async updateEntry(
    id: string,
    updates: { title?: string; content?: string; metadata?: Record<string, unknown> },
  ): Promise<void> {
    const sets = ['updated_at = NOW()'];
    const params: unknown[] = [];

    if (updates.title !== undefined) {
      params.push(updates.title);
      sets.push(`title = $${params.length}`);
    }
    if (updates.content !== undefined) {
      params.push(updates.content);
      sets.push(`content = $${params.length}`);
    }
    if (updates.metadata !== undefined) {
      params.push(JSON.stringify(updates.metadata));
      sets.push(`metadata = $${params.length}`);
    }

    params.push(id);
    await this.pool.query(
      `UPDATE context_entries SET ${sets.join(', ')} WHERE id = $${params.length}`,
      params,
    );
  }

  async findTasksByQuery(query: string, project?: string): Promise<ContextEntry[]> {
    const conditions = ["type = $1", "(title ILIKE $2 OR content ILIKE $2)"];
    const params: unknown[] = ['task', `%${query}%`];

    if (project) {
      params.push(project);
      conditions.push(`project = $${params.length}`);
    }

    const { rows } = await this.pool.query(
      `SELECT * FROM context_entries WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC`,
      params,
    );
    return rows.map((r: DbRow) => this.toContextEntry(r));
  }

  async getBookmarksByStatus(
    status: string,
    opts?: { project?: string; linkType?: string; limit?: number },
  ): Promise<ContextEntry[]> {
    const conditions = ["type = $1", "metadata->>'status' = $2"];
    const params: unknown[] = ['bookmark', status];

    if (opts?.project) {
      params.push(`%${opts.project}%`);
      conditions.push(`project ILIKE $${params.length}`);
    }
    if (opts?.linkType) {
      params.push(opts.linkType);
      conditions.push(`metadata->>'linkType' = $${params.length}`);
    }

    let sql = `SELECT * FROM context_entries WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`;
    if (opts?.limit) {
      params.push(opts.limit);
      sql += ` LIMIT $${params.length}`;
    }

    const { rows } = await this.pool.query(sql, params);
    return rows.map((r: DbRow) => this.toContextEntry(r));
  }

  async findBookmarkByQuery(queryStr: string, statusFilter?: string): Promise<ContextEntry[]> {
    const conditions = ["type = $1", "(title ILIKE $2 OR content ILIKE $2)"];
    const params: unknown[] = ['bookmark', `%${queryStr}%`];

    if (statusFilter) {
      params.push(statusFilter);
      conditions.push(`metadata->>'status' = $${params.length}`);
    }

    const { rows } = await this.pool.query(
      `SELECT * FROM context_entries WHERE ${conditions.join(' AND ')}`,
      params,
    );
    return rows.map((r: DbRow) => this.toContextEntry(r));
  }

  async findEntriesByQuery(query: string, type?: string, project?: string): Promise<ContextEntry[]> {
    const conditions = ["(title ILIKE $1 OR content ILIKE $1)"];
    const params: unknown[] = [`%${query}%`];

    if (type) {
      params.push(type);
      conditions.push(`type = $${params.length}`);
    }
    if (project) {
      params.push(project);
      conditions.push(`project = $${params.length}`);
    }

    const { rows } = await this.pool.query(
      `SELECT * FROM context_entries WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC`,
      params,
    );
    return rows.map((r: DbRow) => this.toContextEntry(r));
  }

  private toContextEntry(row: DbRow): ContextEntry {
    return {
      id: row.id,
      type: row.type as ContextType,
      project: row.project ?? undefined,
      repo: row.repo ?? undefined,
      branch: row.branch ?? undefined,
      prNumber: row.pr_number ?? undefined,
      title: row.title,
      content: row.content,
      metadata: row.metadata ?? {},
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      vaultPath: row.vault_path ?? undefined,
    };
  }
}
