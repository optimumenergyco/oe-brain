import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import { SymbolExtractor } from './symbol-extractor.js';
import type { IDatabaseService, IEmbeddingsService } from './interfaces.js';
import type { CodeEntry } from '../types/code.js';

// Directories/patterns to always exclude
const EXCLUDE_PATTERNS = [
  'node_modules/',
  'vendor/',
  'dist/',
  'build/',
  '.git/',
  '.claude/',
  'tmp/',
  'log/',
  'coverage/',
  'db/migrate/',
  'spec/',
  'test/',
  '__tests__/',
  '.test.',
  '.spec.',
  '-spec.',
  '_spec.',
];

const LANGUAGE_MAP: Record<string, string> = {
  '.rb': 'ruby',
  '.ts': 'typescript',
  '.tsx': 'tsx',
};

export interface IndexResult {
  indexed: number;
  skipped: number;
  errors: number;
}

type CodeDatabaseService = IDatabaseService & {
  upsertCodeEntry: (entry: CodeEntry, embedding?: number[]) => Promise<void>;
  getCodeFileHashes: (repo: string) => Promise<Map<string, string>>;
  deleteCodeEntriesForFile: (repo: string, filePath: string) => Promise<void>;
};

export class CodeIndexer {
  private extractor: SymbolExtractor;
  private extractorReady = false;

  constructor(
    private database: CodeDatabaseService,
    private embeddings: IEmbeddingsService,
  ) {
    this.extractor = new SymbolExtractor();
  }

  detectLanguage(filePath: string): string | null {
    const ext = path.extname(filePath).toLowerCase();
    return LANGUAGE_MAP[ext] ?? null;
  }

  shouldIndex(filePath: string): boolean {
    for (const pattern of EXCLUDE_PATTERNS) {
      if (filePath.includes(pattern)) return false;
    }
    return true;
  }

  computeFileHash(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  private getTrackedFiles(repoPath: string): string[] {
    try {
      const output = execFileSync('git', ['ls-files'], { cwd: repoPath, encoding: 'utf8' });
      return output.trim().split('\n').filter(Boolean);
    } catch {
      // Fallback: not a git repo or git not available
      return [];
    }
  }

  async indexRepo(
    repoPath: string,
    repoName: string,
    opts?: {
      incremental?: boolean;
      onProgress?: (msg: string) => void;
    },
  ): Promise<IndexResult> {
    const log = opts?.onProgress ?? (() => {});

    // Initialize extractor lazily
    if (!this.extractorReady) {
      await this.extractor.init();
      this.extractorReady = true;
    }

    // Get existing file hashes for incremental mode
    const existingHashes = opts?.incremental
      ? await this.database.getCodeFileHashes(repoName)
      : new Map<string, string>();

    // Get tracked files via git ls-files (respects .gitignore)
    const allFiles = this.getTrackedFiles(repoPath);
    const eligibleFiles = allFiles.filter(f => this.shouldIndex(f) && this.detectLanguage(f) !== null);

    log(`Found ${eligibleFiles.length} indexable files (${allFiles.length} total tracked)`);

    let indexed = 0;
    let skipped = 0;
    let errors = 0;

    for (const relPath of eligibleFiles) {
      const absPath = path.join(repoPath, relPath);
      try {
        const content = readFileSync(absPath, 'utf8');
        const hash = this.computeFileHash(content);

        // Skip unchanged files in incremental mode
        if (opts?.incremental && existingHashes.get(relPath) === hash) {
          skipped++;
          continue;
        }

        const language = this.detectLanguage(relPath)!;
        const symbols = await this.extractor.extractSymbols(content, language, relPath);

        if (symbols.length === 0) {
          skipped++;
          continue;
        }

        // Delete old entries for this file before re-indexing
        if (opts?.incremental) {
          await this.database.deleteCodeEntriesForFile(repoName, relPath);
        }

        // Embed and upsert each symbol
        for (const symbol of symbols) {
          const embedding = await this.embeddings.embed(symbol.embedText);
          await this.database.upsertCodeEntry({
            repo: repoName,
            filePath: relPath,
            language,
            symbolName: symbol.symbolName,
            symbolType: symbol.symbolType,
            lineStart: symbol.lineStart,
            lineEnd: symbol.lineEnd,
            content: symbol.content,
            embedText: symbol.embedText,
            fileHash: hash,
          }, embedding);
        }

        indexed++;
        log(`[${indexed}/${eligibleFiles.length - skipped}] ${relPath} (${symbols.length} symbols)`);
      } catch (err) {
        errors++;
        log(`ERROR: ${relPath} — ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { indexed, skipped, errors };
  }
}
