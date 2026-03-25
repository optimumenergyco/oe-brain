import * as chrono from 'chrono-node';
import type { WhisperService } from '../services/whisper.js';
import type { VaultService } from '../services/vault.js';
import type { EmbeddingsService } from '../services/embeddings.js';
import type { DatabaseService } from '../services/database.js';
import type { ProcessedTracker } from '../services/processed-tracker.js';
import { createAppleReminder } from '../services/reminders.js';
import type { ContextEntry } from '../types.js';

function extractTitle(text: string): string {
  const match = text.match(/^[^.!?]+[.!?]/);
  return match ? match[0].trim() : text.slice(0, 80).trim();
}

const REMINDER_PATTERN = /\bremind(?:er|\s+me)\b/i;

function parseReminder(transcript: string): { title: string; date: Date } | null {
  if (!REMINDER_PATTERN.test(transcript)) return null;

  const parsed = chrono.parse(transcript, new Date(), { forwardDate: true });
  if (parsed.length === 0) return null;

  const date = parsed[0].start.date();

  // Remove the time expression and "remind me/send a reminder" prefix to get the reminder title
  let title = transcript;
  // Remove the parsed date text
  title = title.replace(parsed[0].text, '');
  // Remove common reminder prefixes
  title = title.replace(/^.*?remind(?:er|\s+me)\b\s*/i, '');
  // Remove filler words like "saying that", "to", "about"
  title = title.replace(/^\s*(?:saying\s+that|saying|to|about)\s+/i, '');
  // Clean up whitespace and punctuation
  title = title.replace(/\s+/g, ' ').replace(/^[\s,.]+|[\s,.]+$/g, '').trim();

  if (!title) title = transcript;

  return { title, date };
}

export class VoiceProcessor {
  constructor(
    private whisper: WhisperService,
    private vault: VaultService,
    private embeddings: EmbeddingsService,
    private database: DatabaseService,
    private tracker: ProcessedTracker,
  ) {}

  async process(audioPath: string): Promise<{ vaultPath: string; title: string } | null> {
    if (this.tracker.isProcessed(audioPath)) {
      return null;
    }

    const transcript = await this.whisper.transcribe(audioPath);
    const title = extractTitle(transcript);
    const now = new Date();

    const entry: ContextEntry = {
      type: 'learned',
      title,
      content: transcript,
      metadata: { tags: ['voice-capture'], source: audioPath },
      createdAt: now,
      updatedAt: now,
    };

    const vaultPath = this.vault.writeEntry(entry);
    entry.vaultPath = vaultPath;

    try {
      const available = await this.embeddings.isAvailable();
      if (available) {
        const embedding = await this.embeddings.embed(entry.content);
        await this.database.upsertEntry(entry, embedding);
      } else {
        await this.database.upsertEntry(entry);
      }
    } catch (error) {
      console.error(`Warning: sync failed for ${audioPath}:`, error);
    }

    // Check for reminder intent
    const reminder = parseReminder(transcript);
    if (reminder) {
      const warning = await createAppleReminder(reminder.title, reminder.date);
      if (warning) {
        console.error(`Warning: ${warning}`);
      } else {
        console.log(`Reminder set: "${reminder.title}" at ${reminder.date.toLocaleString()}`);
      }
    }

    this.tracker.markProcessed(audioPath, vaultPath);
    return { vaultPath, title };
  }
}
