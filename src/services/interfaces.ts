import type { ContextEntry, ContextType } from '../types.js';

export interface IDatabaseService {
  close(): Promise<void>;
  upsertEntry(entry: ContextEntry, embedding?: number[]): Promise<void>;
  searchByEmbedding(
    embedding: number[],
    opts?: { project?: string; repo?: string; type?: ContextType; tag?: string; limit?: number },
  ): Promise<ContextEntry[]>;
  searchWithScores(
    embedding: number[],
    opts?: { limit?: number; threshold?: number },
  ): Promise<Array<{ entry: ContextEntry; similarity: number }>>;
  getByBranch(branch: string, repo?: string, project?: string): Promise<ContextEntry[]>;
  getByProject(project: string, since?: Date): Promise<ContextEntry[]>;
  getByPr(prNumber: number, repo: string): Promise<ContextEntry[]>;
  getTasksByStatus(
    status: string,
    opts?: { project?: string; excludeProject?: string; limit?: number },
  ): Promise<ContextEntry[]>;
  findTaskByTitle(titleSubstring: string, statusFilter?: string): Promise<ContextEntry[]>;
  findTasksByQuery(query: string, project?: string): Promise<ContextEntry[]>;
  getBookmarksByStatus(
    status: string,
    opts?: { project?: string; linkType?: string; limit?: number },
  ): Promise<ContextEntry[]>;
  findBookmarkByQuery(queryStr: string, statusFilter?: string): Promise<ContextEntry[]>;
  findEntriesByQuery(query: string, type?: string, project?: string): Promise<ContextEntry[]>;
  updateTask(
    id: string,
    updates: { title?: string; content?: string; status?: string; metadata?: Record<string, unknown> },
  ): Promise<void>;
  updateEntry(
    id: string,
    updates: { title?: string; content?: string; metadata?: Record<string, unknown> },
  ): Promise<void>;
  deleteTask(id: string): Promise<void>;
  deleteEntry(id: string): Promise<void>;
}

export interface IEmbeddingsService {
  embed(text: string): Promise<number[]>;
  isAvailable(): Promise<boolean>;
}

export interface IVaultService {
  writeEntry(entry: ContextEntry): string;
  deleteEntry(filePath: string): boolean;
  readEntry(filePath: string): ContextEntry;
  listEntries(subdir?: string): ContextEntry[];
  listAllEntries(): ContextEntry[];
}
