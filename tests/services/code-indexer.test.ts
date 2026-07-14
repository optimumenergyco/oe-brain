import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock SymbolExtractor
vi.mock('../../src/services/symbol-extractor.js', () => {
  const mockInstance = {
    init: vi.fn().mockResolvedValue(undefined),
    extractSymbols: vi.fn().mockResolvedValue([
      {
        symbolName: 'TestClass#test_method',
        symbolType: 'method',
        lineStart: 1,
        lineEnd: 5,
        content: 'def test_method; end',
        embedText: 'Ruby method app/models/test.rb\nTestClass#test_method',
      },
    ]),
  };
  return {
    SymbolExtractor: vi.fn().mockImplementation(function () {
      return mockInstance;
    }),
  };
});

import { CodeIndexer } from '../../src/services/code-indexer.js';

describe('CodeIndexer', () => {
  const mockDatabase = {
    upsertCodeEntry: vi.fn().mockResolvedValue(undefined),
    getCodeFileHashes: vi.fn().mockResolvedValue(new Map()),
    deleteCodeEntriesForFile: vi.fn().mockResolvedValue(undefined),
    getCodeIndexStatus: vi.fn().mockResolvedValue([]),
    dropCodeEntries: vi.fn().mockResolvedValue(0),
    searchCode: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const mockEmbeddings = {
    embed: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
    isAvailable: vi.fn().mockResolvedValue(true),
  };

  let indexer: CodeIndexer;

  beforeEach(() => {
    vi.clearAllMocks();
    indexer = new CodeIndexer(mockDatabase as any, mockEmbeddings as any);
  });

  describe('detectLanguage', () => {
    it('detects Ruby from .rb extension', () => {
      expect(indexer.detectLanguage('app/models/user.rb')).toBe('ruby');
    });
    it('detects TypeScript from .ts extension', () => {
      expect(indexer.detectLanguage('src/hooks/use-data.ts')).toBe('typescript');
    });
    it('detects TSX from .tsx extension', () => {
      expect(indexer.detectLanguage('src/components/Foo.tsx')).toBe('tsx');
    });
    it('returns null for unsupported extensions', () => {
      expect(indexer.detectLanguage('README.md')).toBeNull();
      expect(indexer.detectLanguage('config.yml')).toBeNull();
      expect(indexer.detectLanguage('script.py')).toBeNull();
    });
  });

  describe('shouldIndex', () => {
    it('includes app/ Ruby files', () => {
      expect(indexer.shouldIndex('app/models/user.rb')).toBe(true);
    });
    it('includes src/ TypeScript files', () => {
      expect(indexer.shouldIndex('src/hooks/use-data-layer.ts')).toBe(true);
    });
    it('excludes node_modules/', () => {
      expect(indexer.shouldIndex('node_modules/foo/index.ts')).toBe(false);
    });
    it('excludes vendor/', () => {
      expect(indexer.shouldIndex('vendor/bundle/gems/foo.rb')).toBe(false);
    });
    it('excludes db/migrate/', () => {
      expect(indexer.shouldIndex('db/migrate/20240101_create_users.rb')).toBe(false);
    });
    it('excludes spec/ directory', () => {
      expect(indexer.shouldIndex('spec/models/user_spec.rb')).toBe(false);
    });
    it('excludes .claude/ directory', () => {
      expect(indexer.shouldIndex('.claude/settings.json')).toBe(false);
    });
    it('excludes dist/ directory', () => {
      expect(indexer.shouldIndex('dist/index.js')).toBe(false);
    });
    it('excludes test files by name pattern', () => {
      expect(indexer.shouldIndex('src/components/Foo.test.ts')).toBe(false);
      expect(indexer.shouldIndex('src/components/Foo.spec.ts')).toBe(false);
    });
  });

  describe('computeFileHash', () => {
    it('returns consistent SHA256 hash', () => {
      const h1 = indexer.computeFileHash('hello world');
      const h2 = indexer.computeFileHash('hello world');
      expect(h1).toBe(h2);
      expect(h1).toHaveLength(64);
    });
    it('produces different hashes for different content', () => {
      expect(indexer.computeFileHash('foo')).not.toBe(indexer.computeFileHash('bar'));
    });
  });
});
