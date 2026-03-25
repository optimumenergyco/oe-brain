import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AskPipeline } from '../../src/services/ask-pipeline.js';
import type { OllamaChatService } from '../../src/services/ollama-chat.js';
import type { SearxngService } from '../../src/services/searxng.js';
import type { EmbeddingsService } from '../../src/services/embeddings.js';
import type { DatabaseService } from '../../src/services/database.js';

function createMocks() {
  const ollamaChat = {
    classify: vi.fn(),
    chatWithFallback: vi.fn(),
    chat: vi.fn(),
  } as unknown as OllamaChatService;

  const searxng = {
    search: vi.fn(),
  } as unknown as SearxngService;

  const embeddings = {
    embed: vi.fn(),
    isAvailable: vi.fn(),
  } as unknown as EmbeddingsService;

  const database = {
    searchWithScores: vi.fn(),
  } as unknown as DatabaseService;

  return { ollamaChat, searxng, embeddings, database };
}

describe('AskPipeline', () => {
  let mocks: ReturnType<typeof createMocks>;
  let pipeline: AskPipeline;

  beforeEach(() => {
    mocks = createMocks();
    pipeline = new AskPipeline(
      mocks.ollamaChat,
      mocks.searxng,
      mocks.embeddings,
      mocks.database,
    );
  });

  it('routes brain question through embed + database + chatWithFallback', async () => {
    vi.mocked(mocks.embeddings.embed).mockResolvedValue([0.1, 0.2, 0.3]);
    vi.mocked(mocks.database.searchWithScores).mockResolvedValue([
      {
        entry: {
          id: '1',
          type: 'learned' as const,
          title: 'TypeScript Notes',
          content: 'My TS notes content',
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date(),
          vaultPath: 'notes/typescript.md',
        },
        similarity: 0.85,
      },
    ]);
    vi.mocked(mocks.searxng.search).mockResolvedValue([]);
    vi.mocked(mocks.ollamaChat.chatWithFallback).mockResolvedValue({
      content: 'Based on your notes, TypeScript is...',
      model: 'qwen3.5:cloud',
    });

    const result = await pipeline.ask('What did I write about TypeScript?');

    expect(result.route).toBe('brain');
    expect(result.answer).toBe('Based on your notes, TypeScript is...');
    expect(result.model).toBe('qwen3.5:cloud');
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toEqual({
      type: 'vault',
      path: 'notes/typescript.md',
      title: 'TypeScript Notes',
      similarity: 0.85,
    });

    expect(mocks.embeddings.embed).toHaveBeenCalledWith('What did I write about TypeScript?');
  });

  it('routes web question when only web results are found', async () => {
    vi.mocked(mocks.embeddings.embed).mockResolvedValue([0.1, 0.2]);
    vi.mocked(mocks.database.searchWithScores).mockResolvedValue([]);
    vi.mocked(mocks.searxng.search).mockResolvedValue([
      { title: 'Quantum Physics Intro', url: 'https://example.com/quantum', content: 'Quantum is...', engine: 'google', score: 0.9 },
    ]);
    vi.mocked(mocks.ollamaChat.chatWithFallback).mockResolvedValue({
      content: 'Quantum physics is...',
      model: 'qwen2.5:7b',
    });

    const result = await pipeline.ask('What is quantum physics?');

    expect(result.route).toBe('web');
    expect(result.answer).toBe('Quantum physics is...');
    expect(result.model).toBe('qwen2.5:7b');
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toEqual({
      type: 'web',
      url: 'https://example.com/quantum',
      title: 'Quantum Physics Intro',
    });
  });

  it('routes both question through brain + web + chatWithFallback', async () => {
    vi.mocked(mocks.ollamaChat.classify).mockResolvedValue('both');
    vi.mocked(mocks.embeddings.embed).mockResolvedValue([0.1, 0.2]);
    vi.mocked(mocks.database.searchWithScores).mockResolvedValue([
      {
        entry: {
          id: '1', type: 'learned' as const, title: 'My ML Notes',
          content: 'Notes on ML', metadata: {}, createdAt: new Date(),
          updatedAt: new Date(), vaultPath: 'notes/ml.md',
        },
        similarity: 0.78,
      },
    ]);
    vi.mocked(mocks.searxng.search).mockResolvedValue([
      { title: 'ML Tutorial', url: 'https://ml.com', content: 'ML basics', engine: 'google', score: 0.8 },
    ]);
    vi.mocked(mocks.ollamaChat.chatWithFallback).mockResolvedValue({
      content: 'Based on your notes and web results...',
      model: 'qwen3.5:cloud',
    });

    const result = await pipeline.ask('Tell me about ML from my notes and the web');

    expect(result.route).toBe('both');
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0]).toEqual({
      type: 'vault', path: 'notes/ml.md', title: 'My ML Notes', similarity: 0.78,
    });
    expect(result.sources[1]).toEqual({
      type: 'web', url: 'https://ml.com', title: 'ML Tutorial',
    });
  });

  it('falls back from brain to web when no vault results pass threshold', async () => {
    vi.mocked(mocks.ollamaChat.classify).mockResolvedValue('brain');
    vi.mocked(mocks.embeddings.embed).mockResolvedValue([0.1, 0.2]);
    vi.mocked(mocks.database.searchWithScores).mockResolvedValue([]);
    vi.mocked(mocks.searxng.search).mockResolvedValue([
      { title: 'Web Result', url: 'https://example.com', content: 'Info', engine: 'google', score: 0.7 },
    ]);
    vi.mocked(mocks.ollamaChat.chatWithFallback).mockResolvedValue({
      content: 'From web search...',
      model: 'qwen3.5:cloud',
    });

    const result = await pipeline.ask('Something not in my vault');

    expect(result.route).toBe('web');
    expect(mocks.searxng.search).toHaveBeenCalled();
    expect(result.sources[0]).toEqual({
      type: 'web', url: 'https://example.com', title: 'Web Result',
    });
  });

  it('falls back to web when embeddings service throws', async () => {
    vi.mocked(mocks.ollamaChat.classify).mockResolvedValue('brain');
    vi.mocked(mocks.embeddings.embed).mockRejectedValue(new Error('Ollama down'));
    vi.mocked(mocks.searxng.search).mockResolvedValue([
      { title: 'Fallback Result', url: 'https://fallback.com', content: 'Data', engine: 'google', score: 0.6 },
    ]);
    vi.mocked(mocks.ollamaChat.chatWithFallback).mockResolvedValue({
      content: 'From web fallback...',
      model: 'qwen2.5:7b',
    });

    const result = await pipeline.ask('My vault question');

    expect(result.route).toBe('web');
    expect(mocks.searxng.search).toHaveBeenCalled();
  });

  it('includes model name from chatWithFallback result', async () => {
    vi.mocked(mocks.embeddings.embed).mockResolvedValue([0.1]);
    vi.mocked(mocks.database.searchWithScores).mockResolvedValue([]);
    vi.mocked(mocks.searxng.search).mockResolvedValue([]);
    vi.mocked(mocks.ollamaChat.chatWithFallback).mockResolvedValue({
      content: 'Answer',
      model: 'qwen2.5:7b',
    });

    const result = await pipeline.ask('A question');

    expect(result.model).toBe('qwen2.5:7b');
  });

  it('generates with no-context prompt when both sources fail', async () => {
    vi.mocked(mocks.ollamaChat.classify).mockResolvedValue('both');
    vi.mocked(mocks.embeddings.embed).mockRejectedValue(new Error('embed fail'));
    vi.mocked(mocks.searxng.search).mockRejectedValue(new Error('searxng fail'));
    vi.mocked(mocks.ollamaChat.chatWithFallback).mockResolvedValue({
      content: 'General knowledge answer',
      model: 'qwen3.5:cloud',
    });

    const result = await pipeline.ask('Something');

    expect(result.answer).toBe('General knowledge answer');
    expect(result.sources).toHaveLength(0);
    expect(mocks.ollamaChat.chatWithFallback).toHaveBeenCalled();
  });
});
