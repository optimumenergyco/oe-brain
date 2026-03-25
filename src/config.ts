import { readFileSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import yaml from 'js-yaml';
import type { Config } from './types.js';

function expandTilde(p: string): string {
  return p.startsWith('~') ? resolve(homedir(), p.slice(2)) : p;
}

function resolveEnvVars(str: string): string {
  return str.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? '');
}

function resolveEnvVarsDeep(obj: unknown): unknown {
  if (typeof obj === 'string') return resolveEnvVars(obj);
  if (Array.isArray(obj)) return obj.map(resolveEnvVarsDeep);
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = resolveEnvVarsDeep(v);
    }
    return result;
  }
  return obj;
}

export function loadConfig(configPath: string): Config {
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = resolveEnvVarsDeep(yaml.load(raw)) as Record<string, unknown>;

  const api = parsed.api as Record<string, string> | undefined;
  const apiConfig = api
    ? { baseUrl: api.base_url, apiToken: api.api_token }
    : undefined;

  const database = parsed.database as Record<string, string> | undefined;
  const ollama = parsed.ollama as Record<string, string> | undefined;
  const projects = parsed.projects as Record<string, { repos: Record<string, string>; related_repos?: string[] }>;

  const resolvedProjects: Config['projects'] = {};
  for (const [name, proj] of Object.entries(projects ?? {})) {
    const repos: Record<string, string> = {};
    for (const [repoName, repoPath] of Object.entries(proj.repos ?? {})) {
      repos[repoName] = expandTilde(repoPath);
    }
    resolvedProjects[name] = { repos, relatedRepos: proj.related_repos };
  }

  const voice = parsed.voice as Record<string, string> | undefined;
  const voiceConfig = voice
    ? {
        watchDir: expandTilde(voice.watch_dir),
        processedLog: expandTilde(voice.processed_log ?? '~/.oe-brain/processed-voice.json'),
        whisperBinary: voice.whisper_binary ?? 'whisper-cli',
        whisperModel: voice.whisper_model ? expandTilde(voice.whisper_model) : '',
      }
    : undefined;

  const server = parsed.server as Record<string, unknown> | undefined;
  const serverConfig = server
    ? {
        port: (server.port as number) ?? 3000,
        apiToken: server.api_token as string,
      }
    : undefined;

  const openrouter = parsed.openrouter as Record<string, string> | undefined;
  const openrouterConfig = openrouter
    ? { apiKey: openrouter.api_key, model: openrouter.model }
    : undefined;

  const emailRaw = parsed.email as { accounts?: Array<Record<string, string>> } | undefined;
  const emailConfig = emailRaw?.accounts
    ? {
        accounts: emailRaw.accounts.map((a) => ({
          provider: a.provider as 'gmail' | 'microsoft',
          label: a.label,
          clientId: a.client_id,
          clientSecret: a.client_secret,
          redirectUri: a.redirect_uri ?? 'http://localhost:3000/auth/callback',
          refreshToken: a.refresh_token,
          tenantId: a.tenant_id,
        })),
      }
    : undefined;

  return {
    vaultPath: parsed.vault_path ? expandTilde(parsed.vault_path as string) : '',
    contextDir: (parsed.context_dir as string) ?? '',
    database: { connectionString: database?.connection_string ?? '' },
    ollama: { baseUrl: ollama?.base_url ?? '', model: ollama?.model ?? '' },
    openrouter: openrouterConfig,
    projects: resolvedProjects,
    voice: voiceConfig,
    server: serverConfig,
    email: emailConfig,
    api: apiConfig,
  };
}

const DEFAULT_CONFIG_PATH = resolve(homedir(), '.oe-brain', 'config.yml');

export function getConfig(configPath?: string): Config {
  return loadConfig(configPath ?? process.env.OE_BRAIN_CONFIG ?? DEFAULT_CONFIG_PATH);
}

export function resolveProjectFromPath(
  dirPath: string,
  config: Config
): { project: string; repo: string } | undefined {
  const normalized = resolve(dirPath);
  for (const [projectName, projectConfig] of Object.entries(config.projects)) {
    for (const [repoName, repoPath] of Object.entries(projectConfig.repos)) {
      const resolvedRepo = resolve(expandTilde(repoPath));
      if (normalized === resolvedRepo || normalized.startsWith(resolvedRepo + '/')) {
        return { project: projectName, repo: repoName };
      }
    }
  }
  return undefined;
}
