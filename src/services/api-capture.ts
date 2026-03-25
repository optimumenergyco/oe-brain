import type { ContextEntry } from '../types.js';

export async function captureViaApi(
  entry: ContextEntry,
  apiConfig: { baseUrl: string; apiToken: string },
): Promise<void> {
  const response = await fetch(`${apiConfig.baseUrl}/capture`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiConfig.apiToken}`,
    },
    body: JSON.stringify({
      text: entry.content,
      title: entry.title,
      type: entry.type,
      project: entry.project,
      repo: entry.repo,
      branch: entry.branch,
      prNumber: entry.prNumber,
      tags: Array.isArray(entry.metadata?.tags) ? entry.metadata.tags : [],
      metadata: entry.metadata,
      id: entry.id,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`API capture failed: ${response.status} ${text}`);
  }
}
