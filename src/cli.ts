#!/usr/bin/env node

import { Command } from 'commander';
import { handlePostCommit } from './hooks/post-commit.js';
import { handlePrEvent } from './hooks/pr-event.js';
import { handleSessionStart } from './hooks/session-start.js';

const program = new Command();

program
  .name('oe-brain')
  .description('Dev context capture and retrieval for Claude Code')
  .version('0.1.0');

program
  .command('capture-hook')
  .description('Handle a Claude Code hook event')
  .requiredOption('--event <type>', 'Hook event type (post-commit, pr-event)')
  .action(async (opts) => {
    let input: { cwd: string; tool_input?: { command?: string }; tool_response?: unknown };
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString().trim();
      if (!raw) {
        console.error('oe-brain: no stdin provided, skipping capture-hook');
        return;
      }
      input = JSON.parse(raw);
    } catch {
      console.error('oe-brain: invalid or missing stdin for capture-hook, skipping');
      return;
    }

    switch (opts.event) {
      case 'post-commit':
        await handlePostCommit(input);
        break;
      case 'pr-event':
        await handlePrEvent(input);
        break;
      default:
        console.error(`Unknown event: ${opts.event}`);
        process.exit(1);
    }
  });

program
  .command('session-context')
  .description('Output context for current session (called by SessionStart hook)')
  .action(async () => {
    let input: { cwd: string };
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString().trim();
      if (!raw) {
        console.error('oe-brain: no stdin provided, skipping session-context');
        return;
      }
      input = JSON.parse(raw);
    } catch {
      console.error('oe-brain: invalid or missing stdin for session-context, skipping');
      return;
    }

    const context = await handleSessionStart(input);
    if (context) {
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: context,
        },
      }));
    }
  });

program
  .command('sync')
  .description('Re-embed any vault entries missing from the database')
  .action(async () => {
    const { getConfig } = await import('./config.js');
    const { VaultService } = await import('./services/vault.js');
    const { EmbeddingsService } = await import('./services/embeddings.js');
    const { DatabaseService } = await import('./services/database.js');

    const config = getConfig();
    const vault = new VaultService(config.vaultPath, config.contextDir);
    const embeddings = new EmbeddingsService(config.ollama.baseUrl, config.ollama.model);
    const db = new DatabaseService(config.database.connectionString);

    const entries = vault.listAllEntries();
    console.log(`Found ${entries.length} vault entries (full vault). Syncing...`);

    let synced = 0;
    for (const entry of entries) {
      try {
        const embedding = await embeddings.embed(entry.content);
        await db.upsertEntry(entry, embedding);
        synced++;
        console.log(`  Synced: ${entry.vaultPath}`);
      } catch (err) {
        console.error(`  Failed: ${entry.vaultPath} — ${err instanceof Error ? err.message : 'unknown'}`);
      }
    }

    console.log(`Done. Synced ${synced}/${entries.length} entries.`);
  });

program
  .command('index-code <repo-path>')
  .description('Index a codebase for semantic code search')
  .option('--incremental', 'Only re-index changed files (skip files with matching hash)')
  .option('--repo-name <name>', 'Override repo name (default: directory basename)')
  .action(async (repoPath: string, opts: { incremental?: boolean; repoName?: string }) => {
    const pathMod = await import('path');
    const { getConfig } = await import('./config.js');
    const { EmbeddingsService } = await import('./services/embeddings.js');
    const { DatabaseService } = await import('./services/database.js');
    const { CodeIndexer } = await import('./services/code-indexer.js');

    const config = getConfig();
    const embeddings = new EmbeddingsService(config.ollama.baseUrl, config.ollama.model);
    const db = new DatabaseService(config.database.connectionString);

    const available = await embeddings.isAvailable();
    if (!available) {
      console.error(`Error: Ollama is not available at ${config.ollama.baseUrl}`);
      console.error(`Start Ollama and ensure the "${config.ollama.model}" model is pulled.`);
      process.exit(1);
    }

    const resolvedPath = pathMod.resolve(repoPath);
    const repoName = opts.repoName ?? pathMod.basename(resolvedPath);
    const indexer = new CodeIndexer(db as any, embeddings);

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
  .description('Show code index statistics per repo')
  .action(async () => {
    const { getConfig } = await import('./config.js');
    const { DatabaseService } = await import('./services/database.js');

    const config = getConfig();
    const db = new DatabaseService(config.database.connectionString);

    const status = await (db as any).getCodeIndexStatus();
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

    const count = await (db as any).dropCodeEntries(repo);
    console.log(`Dropped ${count} entries for "${repo}".`);
    await db.close();
  });

program
  .command('voice-watch')
  .description('Watch for new Voice Memos and transcribe them into the second brain')
  .action(async () => {
    const { getConfig } = await import('./config.js');
    const { VaultService } = await import('./services/vault.js');
    const { EmbeddingsService } = await import('./services/embeddings.js');
    const { DatabaseService } = await import('./services/database.js');
    const { WhisperService } = await import('./services/whisper.js');
    const { ProcessedTracker } = await import('./services/processed-tracker.js');
    const { VoiceProcessor } = await import('./voice/processor.js');
    const { VoiceWatcher } = await import('./voice/watcher.js');

    const config = getConfig();
    if (!config.voice) {
      console.error('No voice config found in ~/.oe-brain/config.yml');
      console.error('Add a voice section with watch_dir pointing to your Voice Memos directory.');
      process.exit(1);
    }

    const vault = new VaultService(config.vaultPath, config.contextDir);
    const embeddings = new EmbeddingsService(config.ollama.baseUrl, config.ollama.model);
    const db = new DatabaseService(config.database.connectionString);
    const whisper = new WhisperService(config.voice.whisperBinary, config.voice.whisperModel);
    const tracker = new ProcessedTracker(config.voice.processedLog);
    const processor = new VoiceProcessor(whisper, vault, embeddings, db, tracker);
    const watcher = new VoiceWatcher(config.voice.watchDir, processor);

    await watcher.processExisting();
    watcher.start();
  });

program.parse();
