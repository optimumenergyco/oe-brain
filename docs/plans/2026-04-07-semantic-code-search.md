# Semantic Code Search Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add semantic code search to oe-brain — index codebases with tree-sitter, search with hybrid pgvector + tsvector via the existing MCP server and CLI.

**Architecture:** New `code_entries` table (separate from `context_entries`). CodeIndexer service walks repos, extracts symbols via tree-sitter, enriches with structural context, embeds via Ollama, upserts to pgvector. `search_code` MCP tool combines vector similarity + keyword search using RRF. CLI `index-code` command for batch indexing.

**Tech Stack:** TypeScript, web-tree-sitter + bundled WASM grammars (no native compilation), pgvector, pg tsvector, Ollama nomic-embed-text, vitest

**Design doc:** `docs/plans/2026-04-07-semantic-code-search-design.md`

---

### Task 1: Install web-tree-sitter and bundle WASM grammars

**Files:**
- Modify: `package.json`
- Create: `src/grammars/tree-sitter-ruby.wasm`
- Create: `src/grammars/tree-sitter-typescript.wasm`
- Create: `src/grammars/tree-sitter-tsx.wasm`

**Step 1: Install web-tree-sitter (WASM-based, no native compilation needed)**

Run:
```bash
cd /Users/kquillen/Code/oe-brain
npm install web-tree-sitter
```

**Step 2: Download WASM grammar files and bundle in repo**

Download the pre-built `.wasm` grammars from the tree-sitter GitHub releases and place them in `src/grammars/`. These are ~200KB each and work on all platforms without compilation.

```bash
mkdir -p src/grammars
# Download from tree-sitter grammar repos (use latest releases)
curl -L -o src/grammars/tree-sitter-ruby.wasm https://github.com/tree-sitter/tree-sitter-ruby/releases/latest/download/tree-sitter-ruby.wasm
curl -L -o src/grammars/tree-sitter-typescript.wasm https://github.com/tree-sitter/tree-sitter-typescript/releases/latest/download/tree-sitter-typescript.wasm
curl -L -o src/grammars/tree-sitter-tsx.wasm https://github.com/tree-sitter/tree-sitter-typescript/releases/latest/download/tree-sitter-tsx.wasm
```

If the direct download URLs don't work, build them from the npm packages:
```bash
npx tree-sitter build --wasm node_modules/tree-sitter-ruby
npx tree-sitter build --wasm node_modules/tree-sitter-typescript/typescript
npx tree-sitter build --wasm node_modules/tree-sitter-typescript/tsx
```

Also copy the `tree-sitter.wasm` runtime from the web-tree-sitter package:
```bash
cp node_modules/web-tree-sitter/tree-sitter.wasm src/grammars/
```

**Step 3: Ensure grammars are included in build output**

Add a `postbuild` script to `package.json` that copies `src/grammars/` to `dist/grammars/`, or reference them via `__dirname` at runtime using `path.resolve`.

**Step 4: Verify installation**

Run:
```bash
node -e "const Parser = require('web-tree-sitter'); Parser.init().then(() => console.log('ok'))"
```
Expected: `ok`

**Step 5: Commit**

```bash
git add package.json package-lock.json src/grammars/
git commit -m "chore: add web-tree-sitter and bundled WASM grammars for code search"
```

---

### Task 2: Database schema — code_entries table

**Files:**
- Modify: `db/schema.sql`

**Step 1: Add code_entries table and search function to schema.sql**

Append to `db/schema.sql`:

```sql
-- Code search entries (separate from context_entries, can be dropped independently)
create table if not exists code_entries (
  id          uuid primary key default gen_random_uuid(),
  repo        text not null,
  file_path   text not null,
  language    text,
  symbol_name text,
  symbol_type text,
  line_start  int,
  line_end    int,
  content     text not null,
  embed_text  text not null,
  embedding   vector(768),
  tsv         tsvector generated always as (to_tsvector('english', embed_text)) stored,
  file_hash   text,
  indexed_at  timestamptz default now(),
  unique(repo, file_path, symbol_name, line_start)
);

create index if not exists idx_code_entries_embedding on code_entries
  using hnsw (embedding vector_cosine_ops);
create index if not exists idx_code_entries_tsv on code_entries using gin(tsv);
create index if not exists idx_code_entries_repo on code_entries (repo);
create index if not exists idx_code_entries_language on code_entries (language);
create index if not exists idx_code_entries_file_path on code_entries (repo, file_path);

-- Hybrid code search function (RRF: Reciprocal Rank Fusion)
create or replace function search_code(
  query_embedding vector(768),
  query_text text,
  match_count int default 10,
  filter_repo text default null,
  filter_language text default null,
  filter_symbol_type text default null
)
returns table (
  id uuid,
  repo text,
  file_path text,
  language text,
  symbol_name text,
  symbol_type text,
  line_start int,
  line_end int,
  content text,
  embed_text text,
  indexed_at timestamptz,
  score float
)
language plpgsql
as $$
begin
  return query
  with semantic as (
    select ce.id, row_number() over (order by ce.embedding <=> query_embedding) as rank
    from code_entries ce
    where ce.embedding is not null
      and (filter_repo is null or ce.repo = filter_repo)
      and (filter_language is null or ce.language = filter_language)
      and (filter_symbol_type is null or ce.symbol_type = filter_symbol_type)
    order by ce.embedding <=> query_embedding
    limit match_count * 3
  ),
  keyword as (
    select ce.id, row_number() over (order by ts_rank(ce.tsv, plainto_tsquery('english', query_text)) desc) as rank
    from code_entries ce
    where ce.tsv @@ plainto_tsquery('english', query_text)
      and (filter_repo is null or ce.repo = filter_repo)
      and (filter_language is null or ce.language = filter_language)
      and (filter_symbol_type is null or ce.symbol_type = filter_symbol_type)
    limit match_count * 3
  ),
  combined as (
    select
      coalesce(s.id, k.id) as id,
      coalesce(1.0 / (60 + s.rank), 0) + coalesce(1.0 / (60 + k.rank), 0) as rrf_score
    from semantic s
    full outer join keyword k on s.id = k.id
  )
  select
    ce.id,
    ce.repo,
    ce.file_path,
    ce.language,
    ce.symbol_name,
    ce.symbol_type,
    ce.line_start,
    ce.line_end,
    ce.content,
    ce.embed_text,
    ce.indexed_at,
    c.rrf_score as score
  from combined c
  join code_entries ce on ce.id = c.id
  order by c.rrf_score desc
  limit match_count;
end;
$$;
```

**Step 2: Commit**

```bash
git add db/schema.sql
git commit -m "feat: add code_entries table and hybrid search function"
```

---

### Task 3: CodeEntry type and database methods

**Files:**
- Create: `src/types/code.ts`
- Modify: `src/services/database.ts`
- Create: `tests/services/code-database.test.ts`

**Step 1: Write the CodeEntry type**

Create `src/types/code.ts`:

```typescript
export interface CodeEntry {
  id?: string;
  repo: string;
  filePath: string;
  language?: string;
  symbolName?: string;
  symbolType?: string;
  lineStart?: number;
  lineEnd?: number;
  content: string;
  embedText: string;
  embedding?: number[];
  fileHash?: string;
  indexedAt?: Date;
}

export interface CodeSearchResult extends CodeEntry {
  score: number;
}
```

**Step 2: Write failing tests for database code search methods**

Create `tests/services/code-database.test.ts`:

```typescript
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
      const sql = mockQuery.mock.calls[0][0];
      expect(sql).toContain('INSERT INTO code_entries');
      expect(sql).toContain('ON CONFLICT');
    });
  });

  describe('searchCode', () => {
    it('calls search_code function with filters', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: '123',
          repo: 'core-ui',
          file_path: 'src/hooks/use-data-layer.ts',
          language: 'typescript',
          symbol_name: 'useDataLayer',
          symbol_type: 'function',
          line_start: 10,
          line_end: 50,
          content: 'export function useDataLayer() {}',
          embed_text: 'useDataLayer hook',
          indexed_at: new Date(),
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
      expect(results[0].score).toBe(0.85);
      const sql = mockQuery.mock.calls[0][0];
      expect(sql).toContain('search_code');
    });
  });

  describe('getCodeIndexStatus', () => {
    it('returns per-repo counts', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { repo: 'core-ui', count: '1200', latest: new Date() },
          { repo: 'tesla-site', count: '3400', latest: new Date() },
        ],
      });
      const status = await service.getCodeIndexStatus();
      expect(status).toHaveLength(2);
      expect(status[0].repo).toBe('core-ui');
      expect(status[0].count).toBe(1200);
    });
  });

  describe('dropCodeEntries', () => {
    it('deletes all entries for a repo', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 500 });
      const count = await service.dropCodeEntries('core-ui');
      expect(count).toBe(500);
      expect(mockQuery.mock.calls[0][1]).toEqual(['core-ui']);
    });
  });

  describe('getFileHashes', () => {
    it('returns hash map for incremental indexing', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { file_path: 'src/app.ts', file_hash: 'abc' },
          { file_path: 'src/index.ts', file_hash: 'def' },
        ],
      });
      const hashes = await service.getCodeFileHashes('core-ui');
      expect(hashes.get('src/app.ts')).toBe('abc');
      expect(hashes.get('src/index.ts')).toBe('def');
    });
  });
});
```

**Step 3: Run tests to verify they fail**

Run: `cd /Users/kquillen/Code/oe-brain && npx vitest run tests/services/code-database.test.ts`
Expected: FAIL — methods don't exist yet

**Step 4: Implement database methods**

Add to `src/services/database.ts`:

```typescript
import type { CodeEntry, CodeSearchResult } from '../types/code.js';
```

Add these methods to the `DatabaseService` class:

```typescript
  async upsertCodeEntry(entry: CodeEntry, embedding?: number[]): Promise<void> {
    const embeddingStr = embedding ? `[${embedding.join(',')}]` : null;
    await this.pool.query(
      `INSERT INTO code_entries
        (repo, file_path, language, symbol_name, symbol_type, line_start, line_end, content, embed_text, embedding, file_hash)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::vector, $11)
      ON CONFLICT (repo, file_path, symbol_name, line_start) DO UPDATE SET
        language = EXCLUDED.language,
        symbol_type = EXCLUDED.symbol_type,
        line_end = EXCLUDED.line_end,
        content = EXCLUDED.content,
        embed_text = EXCLUDED.embed_text,
        embedding = COALESCE(EXCLUDED.embedding, code_entries.embedding),
        file_hash = EXCLUDED.file_hash,
        indexed_at = NOW()`,
      [
        entry.repo,
        entry.filePath,
        entry.language ?? null,
        entry.symbolName ?? null,
        entry.symbolType ?? null,
        entry.lineStart ?? null,
        entry.lineEnd ?? null,
        entry.content,
        entry.embedText,
        embeddingStr,
        entry.fileHash ?? null,
      ],
    );
  }

  async searchCode(
    embedding: number[],
    queryText: string,
    opts?: { repo?: string; language?: string; symbolType?: string; limit?: number },
  ): Promise<CodeSearchResult[]> {
    const embeddingStr = `[${embedding.join(',')}]`;
    const { rows } = await this.pool.query(
      `SELECT * FROM search_code($1::vector, $2, $3, $4, $5, $6)`,
      [
        embeddingStr,
        queryText,
        opts?.limit ?? 10,
        opts?.repo ?? null,
        opts?.language ?? null,
        opts?.symbolType ?? null,
      ],
    );
    return rows.map((r: any) => this.toCodeSearchResult(r));
  }

  async getCodeIndexStatus(): Promise<Array<{ repo: string; count: number; latest: Date }>> {
    const { rows } = await this.pool.query(
      `SELECT repo, count(*)::int as count, max(indexed_at) as latest
       FROM code_entries GROUP BY repo ORDER BY repo`,
    );
    return rows.map((r: any) => ({ repo: r.repo, count: Number(r.count), latest: new Date(r.latest) }));
  }

  async dropCodeEntries(repo: string): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM code_entries WHERE repo = $1`,
      [repo],
    );
    return result.rowCount ?? 0;
  }

  async getCodeFileHashes(repo: string): Promise<Map<string, string>> {
    const { rows } = await this.pool.query(
      `SELECT DISTINCT ON (file_path) file_path, file_hash
       FROM code_entries WHERE repo = $1 AND file_hash IS NOT NULL`,
      [repo],
    );
    return new Map(rows.map((r: any) => [r.file_path, r.file_hash]));
  }

  async deleteCodeEntriesForFile(repo: string, filePath: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM code_entries WHERE repo = $1 AND file_path = $2`,
      [repo, filePath],
    );
  }

  private toCodeSearchResult(row: any): CodeSearchResult {
    return {
      id: row.id,
      repo: row.repo,
      filePath: row.file_path,
      language: row.language ?? undefined,
      symbolName: row.symbol_name ?? undefined,
      symbolType: row.symbol_type ?? undefined,
      lineStart: row.line_start ?? undefined,
      lineEnd: row.line_end ?? undefined,
      content: row.content,
      embedText: row.embed_text,
      indexedAt: row.indexed_at ? new Date(row.indexed_at) : undefined,
      score: row.score ?? 0,
    };
  }
```

**Step 5: Run tests to verify they pass**

Run: `cd /Users/kquillen/Code/oe-brain && npx vitest run tests/services/code-database.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/types/code.ts src/services/database.ts tests/services/code-database.test.ts
git commit -m "feat: add CodeEntry type and database methods for code search"
```

---

### Task 4: Tree-sitter symbol extractor

**Files:**
- Create: `src/services/symbol-extractor.ts`
- Create: `tests/services/symbol-extractor.test.ts`

**Step 1: Write failing tests**

Create `tests/services/symbol-extractor.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { extractSymbols } from '../../src/services/symbol-extractor.js';

describe('extractSymbols', () => {
  describe('Ruby', () => {
    it('extracts class and method definitions', () => {
      const code = `
class UserService
  # Authenticates a user by email and password
  def authenticate(email, password)
    user = User.find_by(email: email)
    user&.valid_password?(password) ? user : nil
  end

  def reset_password(user)
    token = SecureRandom.hex(20)
    user.update!(reset_token: token)
    token
  end
end`;
      const symbols = extractSymbols(code, 'ruby', 'app/services/user_service.rb');

      expect(symbols).toHaveLength(3); // class + 2 methods
      const classSymbol = symbols.find(s => s.symbolType === 'class');
      expect(classSymbol).toBeDefined();
      expect(classSymbol!.symbolName).toBe('UserService');

      const authMethod = symbols.find(s => s.symbolName === 'UserService#authenticate');
      expect(authMethod).toBeDefined();
      expect(authMethod!.symbolType).toBe('method');
      expect(authMethod!.content).toContain('def authenticate');
    });

    it('extracts modules', () => {
      const code = `
module TagsV2
  class DataMapper
    def map(entity)
      entity.tags
    end
  end
end`;
      const symbols = extractSymbols(code, 'ruby', 'app/services/tags_v2/data_mapper.rb');
      const moduleSymbol = symbols.find(s => s.symbolType === 'module');
      expect(moduleSymbol).toBeDefined();
      expect(moduleSymbol!.symbolName).toBe('TagsV2');
    });

    it('includes YARD docs in embed_text', () => {
      const code = `
class Foo
  # @param name [String] the user name
  # @return [Boolean] whether it worked
  def bar(name)
    true
  end
end`;
      const symbols = extractSymbols(code, 'ruby', 'app/models/foo.rb');
      const method = symbols.find(s => s.symbolName === 'Foo#bar');
      expect(method!.embedText).toContain('@param name');
    });
  });

  describe('TypeScript', () => {
    it('extracts exported functions', () => {
      const code = `
export function useDataLayer(descriptor: DataLayerDescriptor): DataLayerResult {
  const [data, setData] = useState<PointData[]>([]);
  // ...
  return { data, loading };
}`;
      const symbols = extractSymbols(code, 'typescript', 'src/hooks/use-data-layer.ts');
      expect(symbols).toHaveLength(1);
      expect(symbols[0].symbolName).toBe('useDataLayer');
      expect(symbols[0].symbolType).toBe('function');
    });

    it('extracts React components (arrow function)', () => {
      const code = `
export const TimeChartRenderer: React.FC<Props> = ({ config, points }) => {
  return <div>chart</div>;
};`;
      const symbols = extractSymbols(code, 'tsx', 'src/components/time-chart-renderer.tsx');
      expect(symbols).toHaveLength(1);
      expect(symbols[0].symbolName).toBe('TimeChartRenderer');
      expect(symbols[0].symbolType).toBe('component');
    });

    it('extracts interfaces', () => {
      const code = `
export interface DataLayerDescriptor {
  pointIds: string[];
  startTime: Date;
  endTime: Date;
}`;
      const symbols = extractSymbols(code, 'typescript', 'src/types.ts');
      expect(symbols).toHaveLength(1);
      expect(symbols[0].symbolName).toBe('DataLayerDescriptor');
      expect(symbols[0].symbolType).toBe('interface');
    });

    it('extracts classes', () => {
      const code = `
export class ApiClient {
  constructor(private baseUrl: string) {}

  async fetch(path: string): Promise<Response> {
    return fetch(this.baseUrl + path);
  }
}`;
      const symbols = extractSymbols(code, 'typescript', 'src/services/api-client.ts');
      const cls = symbols.find(s => s.symbolType === 'class');
      expect(cls).toBeDefined();
      expect(cls!.symbolName).toBe('ApiClient');

      const method = symbols.find(s => s.symbolName === 'ApiClient#fetch');
      expect(method).toBeDefined();
    });
  });

  describe('embed_text enrichment', () => {
    it('includes file path and language in embed_text', () => {
      const code = `def hello; end`;
      // Wrap in class so extractor finds it
      const fullCode = `class Greeter\n  ${code}\nend`;
      const symbols = extractSymbols(fullCode, 'ruby', 'app/services/greeter.rb');
      const method = symbols.find(s => s.symbolName === 'Greeter#hello');
      expect(method!.embedText).toContain('Ruby method');
      expect(method!.embedText).toContain('app/services/greeter.rb');
      expect(method!.embedText).toContain('Greeter#hello');
    });
  });

  describe('fallback chunking', () => {
    it('falls back to window chunking for unsupported languages', () => {
      const lines = Array.from({ length: 150 }, (_, i) => `line ${i + 1}`);
      const code = lines.join('\n');
      const symbols = extractSymbols(code, 'json', 'config/settings.json');
      expect(symbols.length).toBeGreaterThan(0);
      expect(symbols[0].symbolType).toBe('chunk');
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /Users/kquillen/Code/oe-brain && npx vitest run tests/services/symbol-extractor.test.ts`
Expected: FAIL — module doesn't exist

**Step 3: Implement symbol extractor**

Create `src/services/symbol-extractor.ts`. This is the core chunking service using **web-tree-sitter** (WASM) for Ruby and TypeScript, with fallback window chunking for other languages.

Key responsibilities:
- Initialize web-tree-sitter and load WASM grammars from `src/grammars/` (async init, cached after first call)
- Parse source code into AST
- Walk AST to extract classes, modules, methods, functions, interfaces, components
- Build enriched `embedText` from file path + symbol name + comments + signature
- Fall back to sliding-window chunks (~100 lines, 20-line overlap) for unsupported languages or files without clear symbols

The `SymbolExtractor` class (async because web-tree-sitter init is async):
```typescript
export class SymbolExtractor {
  private parsers: Map<string, Parser> = new Map();

  async init(): Promise<void>  // call once — loads Parser.init() + grammar .wasm files

  async extractSymbols(
    code: string,
    language: string,
    filePath: string,
  ): Promise<Array<{
    symbolName: string;
    symbolType: string;
    lineStart: number;
    lineEnd: number;
    content: string;
    embedText: string;
  }>>
}
```

WASM grammar loading:
```typescript
import Parser from 'web-tree-sitter';

await Parser.init();  // one-time WASM runtime init
const lang = await Parser.Language.load(
  path.resolve(__dirname, '../grammars/tree-sitter-ruby.wasm')
);
const parser = new Parser();
parser.setLanguage(lang);
```

Language label mapping:
- `ruby` → `tree-sitter-ruby.wasm`
- `typescript` → `tree-sitter-typescript.wasm`
- `tsx` → `tree-sitter-tsx.wasm`

Ruby AST node types to extract: `class`, `module`, `method` (with `identifier` child for name). Comments immediately preceding a method node = YARD docs.

TypeScript AST node types: `export_statement` containing `function_declaration`, `class_declaration`, `interface_declaration`, `lexical_declaration` (for `const Foo: React.FC`). Method definitions inside classes → `ClassName#methodName`.

embedText template:
```
{Language} {symbolType} {filePath}
{SymbolName}
{comments/YARD docs if present}
{first line of code / signature}
```

**Step 4: Run tests to verify they pass**

Run: `cd /Users/kquillen/Code/oe-brain && npx vitest run tests/services/symbol-extractor.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/services/symbol-extractor.ts tests/services/symbol-extractor.test.ts
git commit -m "feat: tree-sitter symbol extractor for Ruby and TypeScript"
```

---

### Task 5: CodeIndexer service

**Files:**
- Create: `src/services/code-indexer.ts`
- Create: `tests/services/code-indexer.test.ts`

**Step 1: Write failing tests**

Create `tests/services/code-indexer.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CodeIndexer } from '../../src/services/code-indexer.js';

describe('CodeIndexer', () => {
  const mockDatabase = {
    upsertCodeEntry: vi.fn(),
    getCodeFileHashes: vi.fn().mockResolvedValue(new Map()),
    deleteCodeEntriesForFile: vi.fn(),
    getCodeIndexStatus: vi.fn(),
    dropCodeEntries: vi.fn(),
    searchCode: vi.fn(),
    close: vi.fn(),
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
    it('detects Ruby files', () => {
      expect(indexer.detectLanguage('app/models/user.rb')).toBe('ruby');
    });
    it('detects TypeScript files', () => {
      expect(indexer.detectLanguage('src/hooks/use-data.ts')).toBe('typescript');
    });
    it('detects TSX files', () => {
      expect(indexer.detectLanguage('src/components/Foo.tsx')).toBe('tsx');
    });
    it('returns null for unsupported files', () => {
      expect(indexer.detectLanguage('README.md')).toBeNull();
    });
  });

  describe('shouldIndex', () => {
    it('includes app/ Ruby files', () => {
      expect(indexer.shouldIndex('app/models/user.rb')).toBe(true);
    });
    it('excludes node_modules', () => {
      expect(indexer.shouldIndex('node_modules/foo/index.ts')).toBe(false);
    });
    it('excludes vendor/', () => {
      expect(indexer.shouldIndex('vendor/bundle/gems/foo.rb')).toBe(false);
    });
    it('excludes db/migrate/', () => {
      expect(indexer.shouldIndex('db/migrate/20240101_create_users.rb')).toBe(false);
    });
    it('excludes spec/fixtures/', () => {
      expect(indexer.shouldIndex('spec/fixtures/users.yml')).toBe(false);
    });
    it('excludes .claude/', () => {
      expect(indexer.shouldIndex('.claude/settings.json')).toBe(false);
    });
  });

  describe('computeFileHash', () => {
    it('returns consistent SHA256 for same content', () => {
      const hash1 = indexer.computeFileHash('hello world');
      const hash2 = indexer.computeFileHash('hello world');
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA256 hex
    });
    it('returns different hash for different content', () => {
      const hash1 = indexer.computeFileHash('hello');
      const hash2 = indexer.computeFileHash('world');
      expect(hash1).not.toBe(hash2);
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /Users/kquillen/Code/oe-brain && npx vitest run tests/services/code-indexer.test.ts`
Expected: FAIL

**Step 3: Implement CodeIndexer**

Create `src/services/code-indexer.ts`:

Key responsibilities:
- Walk repo directory, respecting `.gitignore` (use `git ls-files` for accurate file list)
- Detect language from file extension
- Filter files (exclude vendor, node_modules, migrations, fixtures, .claude, dist, build, tmp, log)
- Read each file, compute SHA256 hash, skip if unchanged (incremental mode)
- Call `extractSymbols()` for supported languages
- Embed each symbol via `EmbeddingsService`
- Upsert to database via `DatabaseService.upsertCodeEntry()`
- Progress reporting callback for CLI output

Constructor: `CodeIndexer(database: DatabaseService, embeddings: EmbeddingsService)`

Main method: `async indexRepo(repoPath: string, repoName: string, opts?: { incremental?: boolean; onProgress?: (msg: string) => void }): Promise<{ indexed: number; skipped: number; errors: number }>`

Helper methods (public for testability):
- `detectLanguage(filePath: string): string | null`
- `shouldIndex(filePath: string): boolean`
- `computeFileHash(content: string): string`

File list: use `git ls-files` to get tracked files (automatically respects .gitignore).

**Step 4: Run tests to verify they pass**

Run: `cd /Users/kquillen/Code/oe-brain && npx vitest run tests/services/code-indexer.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/services/code-indexer.ts tests/services/code-indexer.test.ts
git commit -m "feat: CodeIndexer service for repo walking and indexing"
```

---

### Task 6: search_code MCP tool

**Files:**
- Create: `src/mcp/tools/code-search.ts`
- Modify: `src/mcp/server.ts`

**Step 1: Implement the MCP tool**

Create `src/mcp/tools/code-search.ts`:

```typescript
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Services } from '../server.js';
import type { CodeSearchResult } from '../../types/code.js';

function formatCodeResult(result: CodeSearchResult): string {
  const parts: string[] = [];
  const location = result.lineStart
    ? `${result.filePath}:${result.lineStart}-${result.lineEnd}`
    : result.filePath;
  const meta = [result.repo, result.language, result.symbolType].filter(Boolean).join(' | ');
  parts.push(`## ${result.symbolName ?? location}`);
  parts.push(`\`${location}\` (${meta}) — score: ${result.score.toFixed(3)}`);
  parts.push('');
  parts.push('```' + (result.language ?? ''));
  parts.push(result.content);
  parts.push('```');
  return parts.join('\n');
}

export function registerCodeSearchTools(server: McpServer, services: Services): void {
  server.registerTool(
    'search_code',
    {
      description:
        'Semantic code search across indexed repositories. Finds functions, classes, methods, and code snippets by meaning using hybrid vector + keyword search. Use this instead of grep when you need to find code by what it does rather than exact text.',
      inputSchema: {
        query: z.string().describe('Natural language query or code pattern to search for'),
        repo: z.string().optional().describe('Filter to specific repo (e.g. "core-ui", "tesla-site")'),
        language: z.string().optional().describe('Filter by language (ruby, typescript, tsx)'),
        symbol_type: z.string().optional().describe('Filter by symbol type (function, class, method, module, interface, component)'),
        limit: z.number().optional().describe('Max results (default 10)'),
      },
    },
    async ({ query, repo, language, symbol_type, limit }) => {
      try {
        const embedding = await services.embeddings.embed(query);
        const results = await services.database.searchCode(embedding, query, {
          repo,
          language,
          symbolType: symbol_type,
          limit: limit ?? 10,
        });

        if (results.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No matching code found. The repo may need indexing — run `oe-brain index-code <repo-path>`.' }] };
        }

        const formatted = results.map(formatCodeResult).join('\n\n---\n\n');
        return { content: [{ type: 'text' as const, text: `Found ${results.length} result(s):\n\n${formatted}` }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Error searching code: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
```

**Step 2: Register in server.ts**

Add import and registration call in `src/mcp/server.ts`:

```typescript
import { registerCodeSearchTools } from './tools/code-search.js';
```

Add after the existing `registerSearchTools(server, services);` line:

```typescript
  registerCodeSearchTools(server, services);
```

**Step 3: Commit**

```bash
git add src/mcp/tools/code-search.ts src/mcp/server.ts
git commit -m "feat: search_code MCP tool with hybrid vector + keyword search"
```

---

### Task 7: CLI index-code command

**Files:**
- Modify: `src/cli.ts`

**Step 1: Add the index-code command**

Add to `src/cli.ts` after the existing `sync` command:

```typescript
program
  .command('index-code <repo-path>')
  .description('Index a codebase for semantic code search')
  .option('--incremental', 'Only re-index changed files')
  .option('--repo-name <name>', 'Override repo name (default: directory basename)')
  .action(async (repoPath: string, opts: { incremental?: boolean; repoName?: string }) => {
    const path = await import('path');
    const { getConfig } = await import('./config.js');
    const { EmbeddingsService } = await import('./services/embeddings.js');
    const { DatabaseService } = await import('./services/database.js');
    const { CodeIndexer } = await import('./services/code-indexer.js');

    const config = getConfig();
    const embeddings = new EmbeddingsService(config.ollama.baseUrl, config.ollama.model);
    const db = new DatabaseService(config.database.connectionString);

    const available = await embeddings.isAvailable();
    if (!available) {
      console.error('Error: Ollama is not available at', config.ollama.baseUrl);
      console.error('Start Ollama and ensure the', config.ollama.model, 'model is pulled.');
      process.exit(1);
    }

    const resolvedPath = path.resolve(repoPath);
    const repoName = opts.repoName ?? path.basename(resolvedPath);
    const indexer = new CodeIndexer(db, embeddings);

    console.log(`Indexing ${repoName} at ${resolvedPath}...`);
    if (opts.incremental) console.log('(incremental mode — skipping unchanged files)');

    const result = await indexer.indexRepo(resolvedPath, repoName, {
      incremental: opts.incremental,
      onProgress: (msg) => console.log(`  ${msg}`),
    });

    console.log(`\nDone. Indexed: ${result.indexed}, Skipped: ${result.skipped}, Errors: ${result.errors}`);
    await db.close();
  });

program
  .command('index-status')
  .description('Show code index statistics')
  .action(async () => {
    const { getConfig } = await import('./config.js');
    const { DatabaseService } = await import('./services/database.js');

    const config = getConfig();
    const db = new DatabaseService(config.database.connectionString);

    const status = await db.getCodeIndexStatus();
    if (status.length === 0) {
      console.log('No repos indexed yet. Run: oe-brain index-code <repo-path>');
    } else {
      console.log('Indexed repositories:\n');
      for (const s of status) {
        console.log(`  ${s.repo}: ${s.count} symbols (last indexed: ${s.latest.toISOString().slice(0, 16)})`);
      }
    }
    await db.close();
  });

program
  .command('index-drop <repo>')
  .description('Remove all code index entries for a repo')
  .action(async (repo: string) => {
    const { getConfig } = await import('./config.js');
    const { DatabaseService } = await import('./services/database.js');

    const config = getConfig();
    const db = new DatabaseService(config.database.connectionString);

    const count = await db.dropCodeEntries(repo);
    console.log(`Dropped ${count} entries for ${repo}.`);
    await db.close();
  });
```

**Step 2: Commit**

```bash
git add src/cli.ts
git commit -m "feat: CLI commands for index-code, index-status, index-drop"
```

---

### Task 8: Apply schema to database

**Step 1: Run the schema SQL against the remote database**

The oe-brain DB runs on the remote server (34.66.86.52). The schema needs to be applied there. Check if there's a migration mechanism or if it needs to be run manually.

If direct DB access: run the new table + function SQL from `db/schema.sql` against the database.

If API-only access: this may need to be done on the server. Document the SQL that needs to be run and note it in the PR description.

**Step 2: Commit any migration scripts if created**

---

### Task 9: Build and verify

**Step 1: Build the project**

Run: `cd /Users/kquillen/Code/oe-brain && npm run build`
Expected: Compiles without errors

**Step 2: Run all tests**

Run: `cd /Users/kquillen/Code/oe-brain && npm test`
Expected: All tests pass (existing + new)

**Step 3: Smoke test CLI help**

Run: `cd /Users/kquillen/Code/oe-brain && npx tsx src/cli.ts index-code --help`
Expected: Shows help for index-code command

**Step 4: Commit any fixes**

---

### Task 10: Create PR

Create a draft PR in the oe-brain repo with:
- Summary of all changes
- Schema SQL to apply
- Usage examples for CLI and MCP tool
- Note that this is a new, isolated table that can be dropped cleanly
