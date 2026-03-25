import pg from 'pg';

const { Pool } = pg;

export interface Conversation {
  id: string;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationWithPreview extends Conversation {
  messageCount: number;
  lastMessagePreview: string | null;
}

export interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

interface DbConversation {
  id: string;
  title: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface DbMessage {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: Date | string;
}

interface DbConversationWithPreview {
  id: string;
  title: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  message_count: number;
  last_message_preview: string | null;
}

export class ConversationService {
  private pool: InstanceType<typeof Pool>;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createConversation(title?: string): Promise<Conversation> {
    const { rows } = await this.pool.query(
      `INSERT INTO conversations (title) VALUES ($1) RETURNING *`,
      [title ?? null],
    );
    return this.toConversation(rows[0]);
  }

  async addMessage(
    conversationId: string,
    role: 'user' | 'assistant',
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<Message> {
    const { rows } = await this.pool.query(
      `INSERT INTO messages (conversation_id, role, content, metadata)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [conversationId, role, content, JSON.stringify(metadata ?? {})],
    );

    // Update conversation timestamp
    await this.pool.query(
      `UPDATE conversations SET updated_at = NOW() WHERE id = $1`,
      [conversationId],
    ).catch((err) => {
      console.error(`Failed to update conversation timestamp: ${err.message}`);
    });

    return this.toMessage(rows[0]);
  }

  async getMessages(conversationId: string, limit?: number): Promise<Message[]> {
    let sql = `SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`;
    const params: unknown[] = [conversationId];
    if (limit) {
      sql += ` LIMIT $2`;
      params.push(limit);
    }
    const { rows } = await this.pool.query(sql, params);
    return rows.map((row: DbMessage) => this.toMessage(row));
  }

  async getRecentMessages(conversationId: string, limit: number = 20): Promise<Message[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [conversationId, limit],
    );
    return rows.map((row: DbMessage) => this.toMessage(row)).reverse();
  }

  async listConversations(limit: number = 50): Promise<Conversation[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM conversations ORDER BY updated_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map((row: DbConversation) => this.toConversation(row));
  }

  async listConversationsWithPreview(limit: number = 50): Promise<ConversationWithPreview[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM conversations_with_preview($1)`,
      [limit],
    );
    return rows.map((row: DbConversationWithPreview) => ({
      id: row.id,
      title: row.title,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      messageCount: row.message_count ?? 0,
      lastMessagePreview: row.last_message_preview ?? null,
    }));
  }

  async deleteConversation(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM conversations WHERE id = $1`, [id]);
  }

  async deleteConversations(ids: string[]): Promise<{ deleted: number; errors: string[] }> {
    const errors: string[] = [];
    let deleted = 0;
    for (const id of ids) {
      try {
        await this.pool.query(`DELETE FROM conversations WHERE id = $1`, [id]);
        deleted++;
      } catch (err) {
        errors.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { deleted, errors };
  }

  async getConversation(id: string): Promise<Conversation | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM conversations WHERE id = $1`,
      [id],
    );
    return rows.length > 0 ? this.toConversation(rows[0]) : null;
  }

  private toConversation(row: DbConversation): Conversation {
    return {
      id: row.id,
      title: row.title,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  private toMessage(row: DbMessage): Message {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      role: row.role as 'user' | 'assistant',
      content: row.content,
      metadata: row.metadata ?? {},
      createdAt: new Date(row.created_at),
    };
  }
}
