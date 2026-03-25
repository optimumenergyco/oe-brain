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
