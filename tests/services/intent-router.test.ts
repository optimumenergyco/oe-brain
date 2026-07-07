import { describe, it, expect, vi } from 'vitest';
import type { OllamaChatService } from '../../src/services/ollama-chat.js';
import { IntentRouter } from '../../src/services/intent-router.js';

function createMockChat(response: string) {
  return {
    chatWithFallback: vi.fn(async () => ({ content: response, model: 'test' })),
    chat: vi.fn(),
    classify: vi.fn(),
  } as unknown as OllamaChatService;
}

describe('IntentRouter', () => {
  it('returns "ask" intent for a question', async () => {
    const mock = createMockChat('{"intent": "ask"}');
    const router = new IntentRouter(mock);

    const result = await router.classify('What is TypeScript?', []);

    expect(result).toEqual({ intent: 'ask' });
  });

  it('returns "capture_task" intent with extracted title, project, and tags', async () => {
    const response = JSON.stringify({
      intent: 'capture_task',
      title: 'Fix login bug',
      project: 'second-brain',
      tags: ['bug', 'auth'],
    });
    const mock = createMockChat(response);
    const router = new IntentRouter(mock);

    const result = await router.classify('Add a task to fix the login bug in second-brain', []);

    expect(result.intent).toBe('capture_task');
    expect(result.title).toBe('Fix login bug');
    expect(result.project).toBe('second-brain');
    expect(result.tags).toEqual(['bug', 'auth']);
  });

  it('returns "update_task" intent with update_query and new_description', async () => {
    const response = JSON.stringify({
      intent: 'update_task',
      update_query: 'login bug',
      new_description: 'Fix the OAuth token refresh issue',
    });
    const mock = createMockChat(response);
    const router = new IntentRouter(mock);

    const result = await router.classify(
      'Update the login bug task to say fix the OAuth token refresh issue',
      [],
    );

    expect(result.intent).toBe('update_task');
    expect(result.update_query).toBe('login bug');
    expect(result.new_description).toBe('Fix the OAuth token refresh issue');
  });

  it('returns "reminder" intent with title and reminder_time', async () => {
    const response = JSON.stringify({
      intent: 'reminder',
      title: 'Team standup',
      reminder_time: '2026-03-08T09:00:00Z',
    });
    const mock = createMockChat(response);
    const router = new IntentRouter(mock);

    const result = await router.classify('Remind me about team standup tomorrow at 9am', []);

    expect(result.intent).toBe('reminder');
    expect(result.title).toBe('Team standup');
    expect(result.reminder_time).toBe('2026-03-08T09:00:00Z');
  });

  it('falls back to "ask" on invalid JSON from LLM', async () => {
    const mock = createMockChat('Sure, I can help with that!');
    const router = new IntentRouter(mock);

    const result = await router.classify('Hello there', []);

    // Fallback attaches the raw text (first 60 chars) as a provisional title.
    expect(result).toEqual({ intent: 'ask', title: 'Hello there' });
  });

  it('falls back to "ask" on LLM error (thrown exception)', async () => {
    const mock = {
      chatWithFallback: vi.fn(async () => {
        throw new Error('Connection refused');
      }),
      chat: vi.fn(),
      classify: vi.fn(),
    } as unknown as OllamaChatService;
    const router = new IntentRouter(mock);

    const result = await router.classify('Hello', []);

    // Fallback attaches the raw text (first 60 chars) as a provisional title.
    expect(result).toEqual({ intent: 'ask', title: 'Hello' });
  });

  it('includes conversation history in the prompt when provided', async () => {
    // Use a message that triggers a non-ask intent (capture_task) so LLM extraction is called
    const response = JSON.stringify({ title: 'Update docs' });
    const mock = createMockChat(response);
    const router = new IntentRouter(mock);

    const history = [
      { role: 'user', content: 'Tell me about my project' },
      { role: 'assistant', content: 'Your project is a knowledge system.' },
    ];

    await router.classify('Add a task to update docs', history);

    const calls = (mock.chatWithFallback as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);

    const messages = calls[0][0];
    // Should have system prompt, history context, and user message
    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('system');
    expect(messages[1].content).toContain('Recent conversation history');
    expect(messages[1].content).toContain('Tell me about my project');
    expect(messages[1].content).toContain('Your project is a knowledge system.');
    expect(messages[2].role).toBe('user');

    // Format should be 'json'
    expect(calls[0][1]).toBe('json');
  });

  it('does not include history message when conversation history is empty', async () => {
    // Use a message that triggers a non-ask intent (capture_task) so LLM extraction is called
    const response = JSON.stringify({ title: 'Fix bug' });
    const mock = createMockChat(response);
    const router = new IntentRouter(mock);

    await router.classify('Add a task to fix bug', []);

    const calls = (mock.chatWithFallback as ReturnType<typeof vi.fn>).mock.calls;
    const messages = calls[0][0];
    // Should have only system prompt and user message (no history)
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
  });
});
