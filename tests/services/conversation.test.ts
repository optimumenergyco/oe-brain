import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockQuery, mockEnd } = vi.hoisted(() => {
  const mockQuery = vi.fn();
  const mockEnd = vi.fn();
  return { mockQuery, mockEnd };
});

vi.mock('pg', () => {
  class MockPool {
    query = mockQuery;
    end = mockEnd;
  }
  return { default: { Pool: MockPool }, Pool: MockPool };
});

import { ConversationService } from '../../src/services/conversation.js';

describe('ConversationService', () => {
  let service: ConversationService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ConversationService('postgresql://localhost:5432/test');
  });

  afterEach(async () => {
    await service.close();
  });

  it('constructs without error', () => {
    expect(service).toBeInstanceOf(ConversationService);
  });

  describe('createConversation', () => {
    it('inserts a conversation with title and returns mapped object', async () => {
      mockQuery.mockResolvedValue({
        rows: [{
          id: 'conv-1',
          title: 'My Chat',
          created_at: new Date('2026-03-07T00:00:00.000Z'),
          updated_at: new Date('2026-03-07T00:00:00.000Z'),
        }],
      });

      const result = await service.createConversation('My Chat');

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('INSERT INTO conversations');
      expect(params).toContain('My Chat');
      expect(result).toEqual({
        id: 'conv-1',
        title: 'My Chat',
        createdAt: new Date('2026-03-07T00:00:00.000Z'),
        updatedAt: new Date('2026-03-07T00:00:00.000Z'),
      });
    });

    it('inserts with null title when no title provided', async () => {
      mockQuery.mockResolvedValue({
        rows: [{
          id: 'conv-2',
          title: null,
          created_at: new Date('2026-03-07T00:00:00.000Z'),
          updated_at: new Date('2026-03-07T00:00:00.000Z'),
        }],
      });

      const result = await service.createConversation();

      const params = mockQuery.mock.calls[0][1];
      expect(params[0]).toBeNull();
      expect(result.title).toBeNull();
    });

    it('throws on insert error', async () => {
      mockQuery.mockRejectedValue(new Error('insert failed'));

      await expect(service.createConversation()).rejects.toThrow('insert failed');
    });
  });

  describe('addMessage', () => {
    it('inserts a message and updates conversation timestamp', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            id: 'msg-1',
            conversation_id: 'conv-1',
            role: 'user',
            content: 'Hello',
            metadata: {},
            created_at: new Date('2026-03-07T01:00:00.000Z'),
          }],
        })
        .mockResolvedValueOnce({ rows: [] }); // update timestamp

      const result = await service.addMessage('conv-1', 'user', 'Hello');

      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(result).toEqual({
        id: 'msg-1',
        conversationId: 'conv-1',
        role: 'user',
        content: 'Hello',
        metadata: {},
        createdAt: new Date('2026-03-07T01:00:00.000Z'),
      });

      // Verify conversation timestamp was updated
      const [updateSql] = mockQuery.mock.calls[1];
      expect(updateSql).toContain('UPDATE conversations');
    });

    it('passes metadata when provided', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{
            id: 'msg-2',
            conversation_id: 'conv-1',
            role: 'assistant',
            content: 'Hi there',
            metadata: { model: 'gpt-4' },
            created_at: new Date('2026-03-07T01:00:00.000Z'),
          }],
        })
        .mockResolvedValueOnce({ rows: [] });

      const result = await service.addMessage('conv-1', 'assistant', 'Hi there', {
        model: 'gpt-4',
      });

      expect(result.metadata).toEqual({ model: 'gpt-4' });
    });
  });

  describe('getMessages', () => {
    it('returns messages ordered by created_at ascending', async () => {
      mockQuery.mockResolvedValue({
        rows: [
          {
            id: 'msg-1', conversation_id: 'conv-1', role: 'user',
            content: 'Hello', metadata: {}, created_at: new Date('2026-03-07T01:00:00.000Z'),
          },
          {
            id: 'msg-2', conversation_id: 'conv-1', role: 'assistant',
            content: 'Hi', metadata: {}, created_at: new Date('2026-03-07T01:01:00.000Z'),
          },
        ],
      });

      const result = await service.getMessages('conv-1');

      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toContain('ORDER BY created_at ASC');
      expect(result).toHaveLength(2);
      expect(result[0].content).toBe('Hello');
      expect(result[1].content).toBe('Hi');
    });

    it('applies limit when provided', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await service.getMessages('conv-1', 5);

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('LIMIT');
      expect(params).toContain(5);
    });
  });

  describe('listConversations', () => {
    it('returns conversations ordered by updated_at descending', async () => {
      mockQuery.mockResolvedValue({
        rows: [
          {
            id: 'conv-2', title: 'Newer',
            created_at: new Date('2026-03-07T02:00:00.000Z'),
            updated_at: new Date('2026-03-07T03:00:00.000Z'),
          },
          {
            id: 'conv-1', title: 'Older',
            created_at: new Date('2026-03-07T00:00:00.000Z'),
            updated_at: new Date('2026-03-07T01:00:00.000Z'),
          },
        ],
      });

      const result = await service.listConversations();

      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toContain('ORDER BY updated_at DESC');
      expect(result).toHaveLength(2);
      expect(result[0].title).toBe('Newer');
      expect(result[1].title).toBe('Older');
    });

    it('respects custom limit', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await service.listConversations(10);

      const params = mockQuery.mock.calls[0][1];
      expect(params).toContain(10);
    });
  });

  describe('getConversation', () => {
    it('returns a single conversation by id', async () => {
      mockQuery.mockResolvedValue({
        rows: [{
          id: 'conv-1', title: 'Test',
          created_at: new Date('2026-03-07T00:00:00.000Z'),
          updated_at: new Date('2026-03-07T00:00:00.000Z'),
        }],
      });

      const result = await service.getConversation('conv-1');

      expect(result).toEqual({
        id: 'conv-1',
        title: 'Test',
        createdAt: new Date('2026-03-07T00:00:00.000Z'),
        updatedAt: new Date('2026-03-07T00:00:00.000Z'),
      });
    });

    it('returns null when conversation not found', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const result = await service.getConversation('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('deleteConversation', () => {
    it('deletes a conversation by id', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await service.deleteConversation('conv-1');

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('DELETE FROM conversations');
      expect(params).toContain('conv-1');
    });
  });

  describe('getRecentMessages', () => {
    it('returns messages in chronological order after fetching most recent', async () => {
      mockQuery.mockResolvedValue({
        rows: [
          {
            id: 'msg-3', conversation_id: 'conv-1', role: 'assistant',
            content: 'Third', metadata: {}, created_at: new Date('2026-03-07T03:00:00.000Z'),
          },
          {
            id: 'msg-2', conversation_id: 'conv-1', role: 'user',
            content: 'Second', metadata: {}, created_at: new Date('2026-03-07T02:00:00.000Z'),
          },
        ],
      });

      const result = await service.getRecentMessages('conv-1', 2);

      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toContain('ORDER BY created_at DESC');
      // Should be reversed to chronological order
      expect(result[0].content).toBe('Second');
      expect(result[1].content).toBe('Third');
    });
  });
});
