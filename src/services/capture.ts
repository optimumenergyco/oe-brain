import type { Services } from '../mcp/server.js';
import type { ContextEntry } from '../types.js';

export async function captureEntry(entry: ContextEntry, services: Services): Promise<string> {
  const vaultPath = services.vault.writeEntry(entry);
  entry.vaultPath = vaultPath;

  try {
    const available = await services.embeddings.isAvailable();
    if (available) {
      const embedding = await services.embeddings.embed(entry.content);
      await services.database.upsertEntry(entry, embedding);
    } else {
      await services.database.upsertEntry(entry);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Captured "${entry.title}" to vault (${vaultPath}). Warning: sync failed — ${message}`;
  }

  return `Captured "${entry.title}" to vault (${vaultPath}) and synced to database.`;
}
