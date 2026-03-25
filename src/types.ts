export const CONTEXT_TYPES = [
  'branch_context',
  'pr_context',
  'decision',
  'learned',
  'session',
  'task',
  'bookmark',
] as const;

export type ContextType = (typeof CONTEXT_TYPES)[number];

export interface ContextEntry {
  id?: string;
  type: ContextType;
  project?: string;
  repo?: string;
  branch?: string;
  prNumber?: number;
  title: string;
  content: string;
  embedding?: number[];
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  vaultPath?: string;
}

export interface Frontmatter {
  type: ContextType;
  project?: string;
  repo?: string;
  branch?: string;
  pr?: number;
  created: string;
  updated: string;
  tags: string[];
}

export interface ProjectConfig {
  repos: Record<string, string>;
  relatedRepos?: string[];
}

export interface EmailAccountConfig {
  provider: 'gmail' | 'microsoft';
  label: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  refreshToken: string;
  tenantId?: string; // Microsoft only
}

export interface Config {
  vaultPath: string;
  contextDir: string;
  database: {
    connectionString: string;
  };
  ollama: {
    baseUrl: string;
    model: string;
  };
  openrouter?: {
    apiKey: string;
    model: string;
  };
  projects: Record<string, ProjectConfig>;
  voice?: {
    watchDir: string;
    processedLog: string;
    whisperBinary: string;
    whisperModel: string;
  };
  server?: {
    port: number;
    apiToken: string;
  };
  email?: {
    accounts: EmailAccountConfig[];
  };
  searxng?: {
    baseUrl: string;
  };
  api?: {
    baseUrl: string;
    apiToken: string;
  };
}

export interface GitContext {
  branch: string;
  repoRoot: string;
  repoName: string;
  project?: string;
}
