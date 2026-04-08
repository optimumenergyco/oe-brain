import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

describe('DatabaseService — code search', () => {
  let service: DatabaseService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new DatabaseService('postgresql://localhost:5432/test');
  });

  afterEach(async () => {
    await service.close();
  });

  describe('upsertCodeEntry', () => {
    it('inserts a code entry with embedding', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const entry = {
        repo: 'core-ui',
        filePath: 'src/hooks/use-data-layer.ts',
        language: 'typescript',
        symbolName: 'useDataLayer',
        symbolType: 'function',
        lineStart: 10,
        lineEnd: 50,
        content: 'export function useDataLayer() { ... }',
        embedText: 'TypeScript function src/hooks/use-data-layer.ts\nuseDataLayer',
        fileHash: 'abc123',
      };
      const embedding = new Array(768).fill(0.1);
      await service.upsertCodeEntry(entry, embedding);
      expect(mockQuery).toHaveBeenCalledOnce();
      const sql = mockQuery.mock.calls[0][0] as string;
      expect(sql).toContain('INSERT INTO code_entries');
      expect(sql).toContain('ON CONFLICT');
    });

    it('inserts without embedding (graceful fallback)', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const entry = {
        repo: 'tesla-site',
        filePath: 'app/models/user.rb',
        language: 'ruby',
        symbolName: 'User',
        symbolType: 'class',
        lineStart: 1,
        lineEnd: 100,
        content: 'class User < ApplicationRecord; end',
        embedText: 'Ruby class app/models/user.rb\nUser',
        fileHash: 'def456',
      };
      await service.upsertCodeEntry(entry);
      expect(mockQuery).toHaveBeenCalledOnce();
    });
  });

  describe('searchCode', () => {
    it('calls search_code function and returns results', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: '123e4567-e89b-12d3-a456-426614174000',
          repo: 'core-ui',
          file_path: 'src/hooks/use-data-layer.ts',
          language: 'typescript',
          symbol_name: 'useDataLayer',
          symbol_type: 'function',
          line_start: 10,
          line_end: 50,
          content: 'export function useDataLayer() {}',
          embed_text: 'useDataLayer hook',
          indexed_at: new Date('2026-04-08'),
          score: 0.85,
        }],
      });

      const embedding = new Array(768).fill(0.1);
      const results = await service.searchCode(embedding, 'data layer hook', {
        repo: 'core-ui',
        limit: 5,
      });

      expect(results).toHaveLength(1);
      expect(results[0].symbolName).toBe('useDataLayer');
      expect(results[0].filePath).toBe('src/hooks/use-data-layer.ts');
      expect(results[0].score).toBe(0.85);
      const sql = mockQuery.mock.calls[0][0] as string;
      expect(sql).toContain('search_code');
    });

    it('applies filters correctly', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const embedding = new Array(768).fill(0.1);
      await service.searchCode(embedding, 'auth', {
        repo: 'tesla-site',
        language: 'ruby',
        symbolType: 'method',
        limit: 3,
      });
      const params = mockQuery.mock.calls[0][1] as unknown[];
      expect(params).toContain('tesla-site');
      expect(params).toContain('ruby');
      expect(params).toContain('method');
      expect(params).toContain(3);
    });
  });

  describe('getCodeIndexStatus', () => {
    it('returns per-repo counts', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { repo: 'core-ui', count: 1200, latest: new Date('2026-04-08') },
          { repo: 'tesla-site', count: 3400, latest: new Date('2026-04-07') },
        ],
      });
      const status = await service.getCodeIndexStatus();
      expect(status).toHaveLength(2);
      expect(status[0].repo).toBe('core-ui');
      expect(status[0].count).toBe(1200);
    });
  });

  describe('dropCodeEntries', () => {
    it('deletes all entries for a repo and returns count', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 500 });
      const count = await service.dropCodeEntries('core-ui');
      expect(count).toBe(500);
      const params = mockQuery.mock.calls[0][1] as unknown[];
      expect(params).toEqual(['core-ui']);
    });
  });

  describe('getCodeFileHashes', () => {
    it('returns a Map of file_path -> file_hash', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { file_path: 'src/app.ts', file_hash: 'abc' },
          { file_path: 'src/index.ts', file_hash: 'def' },
        ],
      });
      const hashes = await service.getCodeFileHashes('core-ui');
      expect(hashes.get('src/app.ts')).toBe('abc');
      expect(hashes.get('src/index.ts')).toBe('def');
      expect(hashes.size).toBe(2);
    });
  });

  describe('deleteCodeEntriesForFile', () => {
    it('deletes entries for a specific file', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 5 });
      await service.deleteCodeEntriesForFile('core-ui', 'src/hooks/use-data-layer.ts');
      const params = mockQuery.mock.calls[0][1] as unknown[];
      expect(params).toEqual(['core-ui', 'src/hooks/use-data-layer.ts']);
    });
  });
});
