import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, resolveProjectFromPath } from '../src/config.js';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('loadConfig', () => {
  const tmpDir = join(tmpdir(), 'second-brain-test-config');
  const configPath = join(tmpDir, 'config.yml');

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads and parses a valid config file', () => {
    writeFileSync(configPath, `
vault_path: /tmp/vault
context_dir: Work/Dev-Context
database:
  connection_string: postgresql://localhost:5432/second_brain
ollama:
  base_url: http://localhost:11434
  model: nomic-embed-text
projects:
  tesla:
    repos:
      core-ui: /tmp/core-ui
      tesla-site: /tmp/tesla-site
`);
    const config = loadConfig(configPath);
    expect(config.vaultPath).toBe('/tmp/vault');
    expect(config.contextDir).toBe('Work/Dev-Context');
    expect(config.database.connectionString).toBe('postgresql://localhost:5432/second_brain');
    expect(config.ollama.model).toBe('nomic-embed-text');
    expect(config.projects.tesla.repos['core-ui']).toBe('/tmp/core-ui');
  });

  it('expands ~ in vault_path', () => {
    writeFileSync(configPath, `
vault_path: ~/Documents/Vault
context_dir: Dev
database:
  connection_string: postgresql://localhost:5432/test
ollama:
  base_url: http://localhost:11434
  model: nomic-embed-text
projects: {}
`);
    const config = loadConfig(configPath);
    expect(config.vaultPath).not.toContain('~');
    expect(config.vaultPath).toContain('/Documents/Vault');
  });

  it('resolves env vars in database config', () => {
    process.env.TEST_DB_URL = 'postgresql://prod:5432/brain';
    writeFileSync(configPath, `
vault_path: /tmp/vault
context_dir: Dev
database:
  connection_string: \${TEST_DB_URL}
ollama:
  base_url: http://localhost:11434
  model: nomic-embed-text
projects: {}
`);
    const config = loadConfig(configPath);
    expect(config.database.connectionString).toBe('postgresql://prod:5432/brain');
    delete process.env.TEST_DB_URL;
  });

  it('throws on missing config file', () => {
    expect(() => loadConfig('/nonexistent/config.yml')).toThrow();
  });

  it('loads API client config without requiring database or ollama', () => {
    process.env.TEST_API_TOKEN = 'my-api-token';
    writeFileSync(configPath, `
api:
  base_url: http://104.154.140.220:3000
  api_token: \${TEST_API_TOKEN}
projects:
  tesla:
    repos:
      core-ui: /tmp/core-ui
`);
    const config = loadConfig(configPath);
    expect(config.api).toEqual({
      baseUrl: 'http://104.154.140.220:3000',
      apiToken: 'my-api-token',
    });
    expect(config.database.connectionString).toBe('');
    expect(config.ollama.baseUrl).toBe('');
    expect(config.projects.tesla.repos['core-ui']).toBe('/tmp/core-ui');
    delete process.env.TEST_API_TOKEN;
  });
});

describe('resolveProjectFromPath', () => {
  it('finds project and repo for a known path', () => {
    const config = {
      vaultPath: '/tmp',
      contextDir: 'Dev',
      database: { connectionString: '' },
      ollama: { baseUrl: '', model: '' },
      projects: {
        tesla: {
          repos: {
            'core-ui': '/Users/johrt/Code/tesla/projects/core-ui',
            'tesla-site': '/Users/johrt/Code/tesla/projects/tesla-site',
          },
        },
      },
    };
    const result = resolveProjectFromPath('/Users/johrt/Code/tesla/projects/core-ui', config);
    expect(result).toEqual({ project: 'tesla', repo: 'core-ui' });
  });

  it('matches paths inside a repo (subdirectory)', () => {
    const config = {
      vaultPath: '/tmp',
      contextDir: 'Dev',
      database: { connectionString: '' },
      ollama: { baseUrl: '', model: '' },
      projects: {
        tesla: {
          repos: {
            'core-ui': '/Users/johrt/Code/tesla/projects/core-ui',
          },
        },
      },
    };
    const result = resolveProjectFromPath('/Users/johrt/Code/tesla/projects/core-ui/src/components', config);
    expect(result).toEqual({ project: 'tesla', repo: 'core-ui' });
  });

  it('returns undefined for unknown paths', () => {
    const config = {
      vaultPath: '/tmp',
      contextDir: 'Dev',
      database: { connectionString: '' },
      ollama: { baseUrl: '', model: '' },
      projects: {},
    };
    const result = resolveProjectFromPath('/unknown/path', config);
    expect(result).toBeUndefined();
  });
});
