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
