import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiClientDatabaseService, ApiClientEmbeddingsService, ApiClientVaultService, ApiClientContext } from '../../src/services/api-client.js';

const BASE_URL = 'http://localhost:3000';
const API_TOKEN = 'test-token';

describe('ApiClientContext', () => {
  it('stores last query text from embed call', async () => {
    const ctx = new ApiClientContext();
    const embeddings = new ApiClientEmbeddingsService(ctx);
    await embeddings.embed('test query');
    expect(ctx.lastQueryText).toBe('test query');
  });
});

describe('ApiClientEmbeddingsService', () => {
  it('returns empty array from embed', async () => {
    const ctx = new ApiClientContext();
    const svc = new ApiClientEmbeddingsService(ctx);
    const result = await svc.embed('hello');
    expect(result).toEqual([]);
  });

  it('isAvailable always returns true', async () => {
    const ctx = new ApiClientContext();
    const svc = new ApiClientEmbeddingsService(ctx);
    expect(await svc.isAvailable()).toBe(true);
  });
});

describe('ApiClientVaultService', () => {
  it('writeEntry returns empty string', () => {
    const svc = new ApiClientVaultService();
    const result = svc.writeEntry({ type: 'learned', title: 'test', content: 'test', metadata: {}, createdAt: new Date(), updatedAt: new Date() });
    expect(result).toBe('');
  });

  it('deleteEntry returns true', () => {
    const svc = new ApiClientVaultService();
    expect(svc.deleteEntry('/some/path')).toBe(true);
  });

  it('listAllEntries returns empty array', () => {
    const svc = new ApiClientVaultService();
    expect(svc.listAllEntries()).toEqual([]);
  });

  it('readEntry throws', () => {
    const svc = new ApiClientVaultService();
    expect(() => svc.readEntry('/path')).toThrow('not supported in API client mode');
  });
});

describe('ApiClientDatabaseService', () => {
  let ctx: ApiClientContext;
  let db: ApiClientDatabaseService;

  beforeEach(() => {
    ctx = new ApiClientContext();
    db = new ApiClientDatabaseService(BASE_URL, API_TOKEN, ctx);
    vi.restoreAllMocks();
  });

  function mockFetch(data: unknown, status = 200) {
    return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => data,
      text: async () => JSON.stringify(data),
    } as Response);
  }

  it('upsertEntry posts to /capture', async () => {
    const fetchSpy = mockFetch({ success: true });
    const entry = {
      type: 'task' as const,
      title: 'Test task',
      content: 'Do the thing',
      metadata: { tags: ['test'] },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await db.upsertEntry(entry);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url.toString()).toContain('/capture');
    expect(opts?.method).toBe('POST');
    const body = JSON.parse(opts?.body as string);
    expect(body.text).toBe('Do the thing');
    expect(body.title).toBe('Test task');
    expect(body.type).toBe('task');
  });

  it('searchByEmbedding uses stored query text', async () => {
    ctx.lastQueryText = 'my search';
    const mockEntry = {
      id: '1', type: 'learned', title: 'Note', content: 'content',
      metadata: {}, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const fetchSpy = mockFetch({ results: [mockEntry] });

    const results = await db.searchByEmbedding([], { project: 'tesla' });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Note');
    expect(results[0].createdAt).toBeInstanceOf(Date);
    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.query).toBe('my search');
    expect(body.project).toBe('tesla');
  });

  it('getByBranch calls correct endpoint', async () => {
    mockFetch({ entries: [] });
    await db.getByBranch('main', 'core-ui', 'tesla');
    const [url] = globalThis.fetch.mock.calls[0] as [URL];
    expect(url.pathname).toBe('/api/context/branch/main');
    expect(url.searchParams.get('repo')).toBe('core-ui');
  });

  it('getByProject calls correct endpoint', async () => {
    mockFetch({ entries: [] });
    const since = new Date('2026-01-01');
    await db.getByProject('tesla', since);
    const [url] = globalThis.fetch.mock.calls[0] as [URL];
    expect(url.pathname).toBe('/api/context/project/tesla');
    expect(url.searchParams.get('since')).toBe(since.toISOString());
  });

  it('getTasksByStatus calls correct endpoint', async () => {
    mockFetch({ tasks: [] });
    await db.getTasksByStatus('open', { project: 'tesla', limit: 10 });
    const [url] = globalThis.fetch.mock.calls[0] as [URL];
    expect(url.pathname).toBe('/api/tasks');
    expect(url.searchParams.get('status')).toBe('open');
    expect(url.searchParams.get('limit')).toBe('10');
  });

  it('deleteEntry calls DELETE', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, status: 200,
    } as Response);

    await db.deleteEntry('abc-123');
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url.pathname).toBe('/api/entries/abc-123');
    expect(opts?.method).toBe('DELETE');
  });

  it('updateEntry calls PATCH', async () => {
    mockFetch({ success: true });
    await db.updateEntry('abc-123', { title: 'New title' });
    const [url, opts] = globalThis.fetch.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe('/api/entries/abc-123');
    expect(opts?.method).toBe('PATCH');
    const body = JSON.parse(opts?.body as string);
    expect(body.title).toBe('New title');
  });

  it('close is a no-op', async () => {
    await expect(db.close()).resolves.toBeUndefined();
  });
});
