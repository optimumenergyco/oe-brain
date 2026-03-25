import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ContextEntry } from '../../src/types.js';

const { mockQuery, mockEnd } = vi.hoisted(() => {
  const mockQuery = vi.fn();
  const mockEnd = vi.fn();
  return { mockQuery, mockEnd };
});

vi.mock('pg', () => {
  class MockPool {
    query = mockQuery;
    end = mockEnd;
  }
  return { default: { Pool: MockPool }, Pool: MockPool };
});

import { DatabaseService } from '../../src/services/database.js';

describe('DatabaseService', () => {
  let service: DatabaseService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new DatabaseService('postgresql://localhost:5432/second_brain');
  });

  afterEach(async () => {
    await service.close();
  });

  it('constructs without error', () => {
    expect(service).toBeInstanceOf(DatabaseService);
  });

  it('has expected methods', () => {
    expect(typeof service.upsertEntry).toBe('function');
    expect(typeof service.searchByEmbedding).toBe('function');
    expect(typeof service.getByBranch).toBe('function');
    expect(typeof service.getByProject).toBe('function');
    expect(typeof service.getByPr).toBe('function');
    expect(typeof service.getTasksByStatus).toBe('function');
    expect(typeof service.findTaskByTitle).toBe('function');
    expect(typeof service.searchWithScores).toBe('function');
    expect(typeof service.deleteTask).toBe('function');
    expect(typeof service.deleteEntry).toBe('function');
    expect(typeof service.updateTask).toBe('function');
    expect(typeof service.updateEntry).toBe('function');
    expect(typeof service.findTasksByQuery).toBe('function');
    expect(typeof service.getBookmarksByStatus).toBe('function');
    expect(typeof service.findBookmarkByQuery).toBe('function');
    expect(typeof service.findEntriesByQuery).toBe('function');
  });

  describe('upsertEntry', () => {
    it('executes an INSERT ... ON CONFLICT upsert with correct params', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const entry: ContextEntry = {
        id: 'test-id',
        type: 'branch_context',
        project: 'my-project',
        repo: 'my-repo',
        branch: 'feature/test',
        prNumber: 42,
        title: 'Test Entry',
        content: 'Some content',
        metadata: { key: 'value' },
        createdAt: new Date('2025-01-01T00:00:00Z'),
        updatedAt: new Date('2025-01-02T00:00:00Z'),
        vaultPath: 'context/test.md',
      };
      const embedding = [0.1, 0.2, 0.3];

      await service.upsertEntry(entry, embedding);

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('INSERT INTO context_entries');
      expect(sql).toContain('ON CONFLICT (vault_path)');
      expect(params).toContain('test-id');
      expect(params).toContain('branch_context');
      expect(params).toContain('my-project');
      expect(params).toContain('my-repo');
      expect(params).toContain('feature/test');
      expect(params).toContain(42);
      expect(params).toContain('Test Entry');
      expect(params).toContain('Some content');
    });

    it('maps undefined optional fields to null', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const entry: ContextEntry = {
        type: 'decision',
        title: 'Minimal',
        content: 'content',
        metadata: {},
        createdAt: new Date('2025-06-01T00:00:00Z'),
        updatedAt: new Date('2025-06-01T00:00:00Z'),
      };

      await service.upsertEntry(entry);

      const params = mockQuery.mock.calls[0][1];
      // id, type, project, repo, branch, pr_number, title, content, embedding, metadata, vault_path, created_at, updated_at
      expect(params[0]).toBeNull(); // id
      expect(params[2]).toBeNull(); // project
      expect(params[3]).toBeNull(); // repo
      expect(params[4]).toBeNull(); // branch
      expect(params[5]).toBeNull(); // pr_number
      expect(params[8]).toBeNull(); // embedding
      expect(params[10]).toBeNull(); // vault_path
    });

    it('throws on query error', async () => {
      mockQuery.mockRejectedValue(new Error('duplicate key'));

      const entry: ContextEntry = {
        type: 'decision',
        title: 'Test',
        content: 'content',
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await expect(service.upsertEntry(entry)).rejects.toThrow('duplicate key');
    });
  });

  describe('searchByEmbedding', () => {
    it('calls match_context_entries function with correct params', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await service.searchByEmbedding([0.1, 0.2, 0.3], {
        project: 'proj',
        repo: 'repo',
        type: 'decision',
        limit: 5,
      });

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('match_context_entries');
      expect(params).toContain('proj');
      expect(params).toContain('repo');
      expect(params).toContain('decision');
    });

    it('maps returned rows to ContextEntry', async () => {
      mockQuery.mockResolvedValue({
        rows: [
          {
            id: 'r1',
            type: 'learned',
            project: null,
            repo: 'my-repo',
            branch: null,
            pr_number: null,
            title: 'Learned Thing',
            content: 'details',
            metadata: { a: 1 },
            vault_path: null,
            created_at: new Date('2025-01-01T00:00:00.000Z'),
            updated_at: new Date('2025-01-02T00:00:00.000Z'),
          },
        ],
      });

      const results = await service.searchByEmbedding([1, 2]);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        id: 'r1',
        type: 'learned',
        project: undefined,
        repo: 'my-repo',
        branch: undefined,
        prNumber: undefined,
        title: 'Learned Thing',
        content: 'details',
        metadata: { a: 1 },
        vaultPath: undefined,
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
        updatedAt: new Date('2025-01-02T00:00:00.000Z'),
      });
    });
  });

  describe('getByBranch', () => {
    it('queries by branch', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await service.getByBranch('feature/x');

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('branch = $');
      expect(params).toContain('feature/x');
    });

    it('adds repo and project filters when provided', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await service.getByBranch('main', 'my-repo', 'my-project');

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('repo = $');
      expect(sql).toContain('project = $');
      expect(params).toContain('my-repo');
      expect(params).toContain('my-project');
    });
  });

  describe('getByProject', () => {
    it('queries by project', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await service.getByProject('my-project');

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('project = $');
      expect(params).toContain('my-project');
    });

    it('adds since filter when provided', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const since = new Date('2025-06-01T00:00:00Z');
      await service.getByProject('proj', since);

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('updated_at >= $');
      expect(params).toContain(since.toISOString());
    });
  });

  describe('getByPr', () => {
    it('queries by pr_number and repo', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await service.getByPr(123, 'my-repo');

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('pr_number = $');
      expect(sql).toContain('repo = $');
      expect(params).toContain(123);
      expect(params).toContain('my-repo');
    });
  });

  describe('getTasksByStatus', () => {
    it('queries tasks filtered by status in metadata', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await service.getTasksByStatus('open');

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain("type = $");
      expect(sql).toContain("metadata->>'status' = $");
      expect(params).toContain('task');
      expect(params).toContain('open');
    });

    it('searches project, title, and content when project filter is provided', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await service.getTasksByStatus('open', { project: 'work' });

      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toContain('ILIKE');
      expect(sql).toContain('project');
      expect(sql).toContain('title');
      expect(sql).toContain('content');
    });

    it('applies limit when provided', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await service.getTasksByStatus('open', { limit: 5 });

      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toContain('LIMIT');
    });
  });

  describe('findTaskByTitle', () => {
    it('searches both title and content', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await service.findTaskByTitle('commit capture');

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain("type = $");
      expect(sql).toContain('ILIKE');
      expect(params).toContain('task');
      expect(params.some((p: unknown) => typeof p === 'string' && p.includes('commit capture'))).toBe(true);
    });

    it('applies status filter when provided', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await service.findTaskByTitle('expense', 'open');

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain("metadata->>'status' = $");
      expect(params).toContain('open');
    });
  });

  describe('searchWithScores', () => {
    it('returns entries with similarity scores', async () => {
      mockQuery.mockResolvedValue({
        rows: [
          {
            id: 'r1',
            type: 'learned',
            project: null,
            repo: 'my-repo',
            branch: null,
            pr_number: null,
            title: 'Learned Thing',
            content: 'details',
            metadata: { a: 1 },
            vault_path: 'notes/learned.md',
            created_at: new Date('2025-01-01T00:00:00.000Z'),
            updated_at: new Date('2025-01-02T00:00:00.000Z'),
            similarity: 0.85,
          },
        ],
      });

      const results = await service.searchWithScores([0.1, 0.2, 0.3]);

      expect(results).toHaveLength(1);
      expect(results[0].similarity).toBe(0.85);
      expect(results[0].entry.title).toBe('Learned Thing');
      expect(results[0].entry.vaultPath).toBe('notes/learned.md');
    });

    it('filters results below default threshold of 0.65', async () => {
      mockQuery.mockResolvedValue({
        rows: [
          {
            id: 'low', type: 'learned', project: null, repo: null, branch: null,
            pr_number: null, title: 'Low Score', content: 'low', metadata: {},
            vault_path: null, created_at: new Date('2025-01-01'), updated_at: new Date('2025-01-01'),
            similarity: 0.5,
          },
          {
            id: 'high', type: 'learned', project: null, repo: null, branch: null,
            pr_number: null, title: 'High Score', content: 'high', metadata: {},
            vault_path: null, created_at: new Date('2025-01-01'), updated_at: new Date('2025-01-01'),
            similarity: 0.9,
          },
        ],
      });

      const results = await service.searchWithScores([1, 2, 3]);

      expect(results).toHaveLength(1);
      expect(results[0].entry.title).toBe('High Score');
    });

    it('respects custom threshold', async () => {
      mockQuery.mockResolvedValue({
        rows: [
          {
            id: 'med', type: 'learned', project: null, repo: null, branch: null,
            pr_number: null, title: 'Med Score', content: 'med', metadata: {},
            vault_path: null, created_at: new Date('2025-01-01'), updated_at: new Date('2025-01-01'),
            similarity: 0.7,
          },
          {
            id: 'high', type: 'learned', project: null, repo: null, branch: null,
            pr_number: null, title: 'High Score', content: 'high', metadata: {},
            vault_path: null, created_at: new Date('2025-01-01'), updated_at: new Date('2025-01-01'),
            similarity: 0.9,
          },
        ],
      });

      const results = await service.searchWithScores([1, 2], { threshold: 0.8 });

      expect(results).toHaveLength(1);
      expect(results[0].entry.title).toBe('High Score');
    });
  });

  describe('deleteTask', () => {
    it('deletes by id', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await service.deleteTask('task-123');

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('DELETE FROM context_entries');
      expect(params).toContain('task-123');
    });
  });

  describe('updateTask', () => {
    it('updates title and content', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await service.updateTask('task-123', { title: 'New Title', content: 'New Content' });

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('UPDATE context_entries');
      expect(params).toContain('task-123');
      expect(params).toContain('New Title');
      expect(params).toContain('New Content');
    });
  });

  describe('getBookmarksByStatus', () => {
    it('queries bookmarks by status', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await service.getBookmarksByStatus('unread');

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain("type = $");
      expect(sql).toContain("metadata->>'status' = $");
      expect(params).toContain('bookmark');
      expect(params).toContain('unread');
    });
  });

  describe('findEntriesByQuery', () => {
    it('searches by query across title and content', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await service.findEntriesByQuery('redis', 'learned');

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('ILIKE');
      expect(params.some((p: unknown) => typeof p === 'string' && p.includes('redis'))).toBe(true);
    });
  });
});
