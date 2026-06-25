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
import { ApiNamespace, Scope, AuthBasic, DistributedTable, Realtime } from '@aws-blocks/blocks';
import { z } from 'zod';

const scope = new Scope('my-app');

// ─── 認証 ─────────────────────────────────────────────────────────────────────
const auth = new AuthBasic(scope, 'auth', {
  passwordPolicy: { minLength: 8 },
  crossDomain: process.env.BLOCKS_SANDBOX === 'true',
});
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

// ─── API ──────────────────────────────────────────────────────────────────────
export const api = new ApiNamespace(scope, 'api', (context) => ({

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
}));
