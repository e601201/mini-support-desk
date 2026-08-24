/**
 * バックエンド — aws-blocks/index.ts
 *
 * ユーザーごとの分離、楽観的ロック、セカンダリインデックスを備えたリアルタイムTodoアプリ。
 *
 * このファイルはAPI、認証、データモデル、リアルタイムチャネルを定義します。
 * フロントエンドは `import { ... } from 'aws-blocks'` で、これらのエクスポートを直接インポートします。
 *
 * ─── 重要 ─────────────────────────────────────────────────────────────────────
 * 永続化のためにローカルファイル、メモリ上の配列、ローカルデータベースを使用しないでください。
 * クラウドの永続化やその他の一般的なクラウド抽象化には Building Blocks を使用してください。
 * これらはローカルでは自動モックで動作し、設定不要でAWSにデプロイできます。
 *
 * ブロックの全一覧と使い方については、以下を参照してください:
 *   node_modules/@aws-blocks/blocks/README.md
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { ApiNamespace, Scope, DistributedTable, Realtime, AuthCognito, Database, sql, FileBucket, Logger, Metrics, Dashboard, EmailClient, AsyncJob, CronJob } from '@aws-blocks/blocks';
import { z } from 'zod';

type TicketStatus = 'open' | 'triage_required' | 'in_progress' | 'closed';
type TicketPriority = 'normal' | 'high';

type Ticket = {
  id: string;
  owner_sub: string;
  title: string;
  body: string;
  status: TicketStatus;
  priority: TicketPriority;
  attachment_key: string | null;
  created_at: string;
  updated_at: string;
};

const scope = new Scope('mini-support-desk');

const db = new Database(scope, 'main', {
  migrationsPath: './aws-blocks/migrations',
});

// ─── 認証 ─────────────────────────────────────────────────────────────────────
const auth = new AuthCognito(scope, 'auth', {
  passwordPolicy: { minLength: 8 },
  signInWith: 'email',
  // ローカルモック専用: 確認コードをターミナルに出力する
  codeDelivery: async (username, code) => {
    console.log(`[auth] ${username} の確認コード: ${code}`);
  },
});

// サインアップ／サインインの状態遷移をフロントに公開する
export const authApi = auth.createApi();

// ─── データ ───────────────────────────────────────────────────────────────────
// Zodスキーマ = ランタイムバリデーション + TypeScriptの型 + DynamoDBテーブルの形状。
const todoSchema = z.object({
  userId: z.string(),       // パーティションキー — ユーザーごとの分離
  todoId: z.string(),       // ソートキー — ユーザー内で一意
  title: z.string(),
  completed: z.boolean(),
  priority: z.number(),     // 1=高, 2=中, 3=低
  version: z.number(),      // 楽観的ロック — 更新のたびにインクリメント
  createdAt: z.number(),
});

const todos = new DistributedTable(scope, 'todos', {
  schema: todoSchema,
  key: { partitionKey: 'userId', sortKey: 'todoId' },
  indexes: {
    // セカンダリインデックス: priorityまたはtitleでソートしてTodoをクエリする。
    // パーティションキーは常にuserId(ユーザーごとの分離)で、ソートキーは可変。
    byPriority: { partitionKey: 'userId', sortKey: 'priority' },
    byTitle: { partitionKey: 'userId', sortKey: 'title' },
  },
});

// ─── リアルタイム ─────────────────────────────────────────────────────────────
const rt = new Realtime(scope, 'live', {
  namespaces: {
    todos: Realtime.namespace(z.object({
      action: z.enum(['created', 'updated', 'deleted']),
      todoId: z.string(),
    })),
  },
});

// ─── メール ───────────────────────────────────────────────────────────────────
const email = new EmailClient(scope, 'mail', {
  fromAddress: 'support@example.com',
});

const { messageId } = await email.send({
  to: 'support@example.com',
  subject: '件名',
  body: '本文',
});

// ─── 非同期ジョブ ─────────────────────────────────────────────────────────────
new CronJob(scope, 'open-ticket-report', {
  schedule: 'rate(1 minute)',
  timezone: 'Asia/Tokyo',
  handler: async (event) => {
    const row = await db.queryOne<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM tickets WHERE status = 'open'`
    );
    log.info('open ticket report', { open: row?.count, at: event.scheduledTime });
    await email.send({
      to: 'support@example.com',
      subject: 'open チケット数レポート',
      body: `現在の open チケット数: ${row?.count}`,
    });
  },
});

const newId = () => `t_${Date.now().toString(36)}${Math.floor(performance.now()).toString(36)}`;

const ticketCreatedJob = new AsyncJob(scope, 'ticket-created', {
  handler: async (payload: { ticketId: string; title: string }, ctx) => {
    // 通知履歴を記録
    await db.execute(sql`
      INSERT INTO notification_logs (id, ticket_id, type, status)
      VALUES (${newId()}, ${payload.ticketId}, 'ticket_created', 'sent')
    `);
    // メール通知
    await email.send({
      to: 'support@example.com',
      subject: `新しい問い合わせ: ${payload.title}`,
      body: `チケット ${payload.ticketId} が作成されました。`,
    });
    log.info('notification sent', { ticketId: payload.ticketId, jobId: ctx.jobId });
  },
});

const attachments = new FileBucket(scope, 'attachments');

const log = new Logger(scope, 'log');
const metrics = new Metrics(scope, 'metrics');

const dashboard = new Dashboard(scope, 'dashboard', {
  logger: log,
  metrics,
  metricConfigs: [{ name: 'RequestCreated', stat: 'Sum' }],
});

// ─── API ──────────────────────────────────────────────────────────────────────
export const api = new ApiNamespace(scope, 'api', (context) => ({

  async whoami() {
    const user = await auth.requireAuth(context);
    return { sub: user.userSub, email: user.username };
  },

  async subscribeTodos() {
    const user = await auth.requireAuth(context);
    return rt.getChannel('todos', user.username);
  },

  async createTodo(title: string, priority: number = 2) {
    const user = await auth.requireAuth(context);
    const todoId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const todo = {
      userId: user.username,
      todoId,
      title,
      completed: false,
      priority,
      version: 1,
      createdAt: Date.now(),
    };
    await todos.put(todo);
    await rt.publish('todos', user.username, { action: 'created' as const, todoId });
    return todo;
  },

  /** Todoの一覧を取得する。任意でセカンダリインデックスによりソートできる。 */
  async listTodos(sortBy?: 'priority' | 'title') {
    const user = await auth.requireAuth(context);
    if (sortBy) {
      const index = sortBy === 'priority' ? 'byPriority' : 'byTitle';
      return await Array.fromAsync(
        todos.query({ index, where: { userId: { equals: user.username } } })
      );
    }
    // デフォルト: todoId順(作成順)でソート
    return await Array.fromAsync(
      todos.query({ where: { userId: { equals: user.username } } })
    );
  },

  /**
   * 楽観的ロックを用いてTodoの完了状態を切り替える。
   * `ifFieldEquals` を使って同時書き込みを検出する。競合した場合は
   * ConditionalCheckFailedException をスローする — 呼び出し側は再読み込みしてリトライすること。
   */
  async toggleTodo(todoId: string) {
    const user = await auth.requireAuth(context);
    const todo = await todos.get({ userId: user.username, todoId });
    if (!todo) throw new Error('Todo not found');
    await todos.put(
      { ...todo, completed: !todo.completed, version: todo.version + 1 },
      { ifFieldEquals: { version: todo.version } },
    );
    await rt.publish('todos', user.username, { action: 'updated' as const, todoId });
    return { success: true };
  },

  /** 楽観的ロックを用いてTodoのpriorityを更新する。 */
  async updatePriority(todoId: string, priority: number) {
    const user = await auth.requireAuth(context);
    const todo = await todos.get({ userId: user.username, todoId });
    if (!todo) throw new Error('Todo not found');
    await todos.put(
      { ...todo, priority, version: todo.version + 1 },
      { ifFieldEquals: { version: todo.version } },
    );
    await rt.publish('todos', user.username, { action: 'updated' as const, todoId });
    return { success: true };
  },

  /** Todoを削除する。接続中の全クライアントに 'deleted' をブロードキャストする。 */
  async deleteTodo(todoId: string) {
    const user = await auth.requireAuth(context);
    await todos.delete({ userId: user.username, todoId });
    await rt.publish('todos', user.username, { action: 'deleted' as const, todoId });
    return { success: true };
  },

  async greet() {
    const user = await auth.requireAuth(context);
    return `Hello, ${user.username}! I'm Daichi.`;
  },

  async createTicket(title: string, body: string, priority: TicketPriority = 'normal', attachmentKey?: string) {
    const user = await auth.requireAuth(context);
    // key を直接信用せず、自分の名前空間（sub プレフィックス）のキーのみ紐付けを許可する
    if (attachmentKey && !attachmentKey.startsWith(`${user.userSub}/`)) {
      throw new Error('Invalid attachment key');
    }
    const id = newId();
    await db.execute(sql`
      INSERT INTO tickets (id, owner_sub, title, body, priority, attachment_key)
      VALUES (${id}, ${user.userSub}, ${title}, ${body}, ${priority}, ${attachmentKey ?? null})
    `);
    metrics.emit('RequestCreated', 1, { unit: 'Count' });  // カスタムメトリクス
    const { jobId } = await ticketCreatedJob.submit({ ticketId: id, title }); // 非同期ジョブの発行
    log.info('ticket created', { id, priority, jobId });          // 構造化ログ
    return await db.queryOne<Ticket>(sql`SELECT * FROM tickets WHERE id = ${id}`);
  },

  async listTickets() {
    const user = await auth.requireAuth(context);
    return await db.query<Ticket>(
      sql`SELECT * FROM tickets WHERE owner_sub = ${user.userSub} ORDER BY created_at DESC`
    );
  },

  async getTicket(id: string) {
    const user = await auth.requireAuth(context);
    return await db.queryOne<Ticket>(
      sql`SELECT * FROM tickets WHERE id = ${id} AND owner_sub = ${user.userSub}`
    );
  },

  async closeTicket(id: string) {
    const user = await auth.requireAuth(context);
    await db.execute(
      sql`UPDATE tickets SET status = 'closed', updated_at = now()
          WHERE id = ${id} AND owner_sub = ${user.userSub}`
    );
    return { ok: true };
  },

  async getAttachmentUploadUrl(filename: string) {
    const user = await auth.requireAuth(context);
    // キーにユーザーごとのプレフィックスを付け、特殊文字は encode する
    const key = `${user.userSub}/${Date.now()}-${encodeURIComponent(filename)}`;
    const url = await attachments.putUrl(key, { expiresIn: 600 });
    return { key, url };
  },

  async getAttachmentDownloadUrl(key: string) {
    await auth.requireAuth(context);
    return { url: await attachments.getUrl(key, { expiresIn: 600 }) };
  },

  // 責務境界を意識した安全な発行例（key を直接信用しない）
  async getTicketAttachmentUrl(ticketId: string) {
    const user = await auth.requireAuth(context);
    const ticket = await db.queryOne<Ticket>(
      sql`SELECT * FROM tickets WHERE id = ${ticketId} AND owner_sub = ${user.userSub}`
    );
    if (!ticket?.attachment_key) return { url: null };
    return { url: await attachments.getUrl(ticket.attachment_key, { expiresIn: 600 }) };
  },

}));
