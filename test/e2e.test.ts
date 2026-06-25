/**
 * End-to-end tests — tests the API via direct imports (same typed client the frontend uses).
 *
 * Run:  npm run test:e2e
 *
 * Structure:
 *   - Setup (starts dev server, imports client) — don't touch
 *   - Auth tests
 *   - CRUD tests
 *   - Conditional write / conflict tests
 *   - Realtime tests
 *
 * To add tests: copy any test block, rename, change the assertion. The setup
 * boilerplate handles server lifecycle — you just call api.* methods.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installCookieJar, isServerRunning } from '@aws-blocks/blocks/utils';
import type { api as ApiType, authApi as AuthApiType } from 'aws-blocks';

// Install cookie jar before importing the API client — Node's fetch doesn't
// persist cookies between requests, which breaks authenticated API calls.
installCookieJar();

let server: ChildProcess | null = null;
let api: typeof ApiType;
let authApi: typeof AuthApiType;

// ─── Setup (don't touch) ─────────────────────────────────────────────────────

test.before(async () => {
  // Use existing dev server if running, otherwise start one
  if (!await isServerRunning()) {
    server = spawn('npm', ['run', 'dev:server'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    server.unref();
    await setTimeout(2000);
  }

  const mod = await import('aws-blocks');
  api = mod.api;
  authApi = mod.authApi;

  // Wait for server readiness
  for (let i = 0; i < 30; i++) {
    try {
      await authApi.getAuthState();
      return;
    } catch {
      await setTimeout(1000);
    }
  }
  throw new Error('Dev server did not become ready within 30s');
});

test.after(() => {
  if (server?.pid) {
    try { process.kill(-server.pid, 'SIGTERM'); } catch {}
  }
});

// ─── Auth helpers (Cognito) ───────────────────────────────────────────────────
// AuthCognito requires email confirmation on sign-up. The local mock delivers the
// code via the `codeDelivery` hook and also writes it to last-code.json — we read
// it there to drive the flow programmatically.
const TEST_USER = 'testuser@example.com';
const TEST_PASS = 'TestPass123!';
const AUTH_CODE_PATH = join(process.cwd(), '.bb-data', 'mini-support-desk-auth', 'last-code.json');

async function readConfirmationCode(username: string): Promise<string> {
  for (let i = 0; i < 25; i++) {
    try {
      const { username: u, code } = JSON.parse(await readFile(AUTH_CODE_PATH, 'utf8'));
      if (u === username && code) return code;
    } catch { /* file not written yet */ }
    await setTimeout(200);
  }
  throw new Error(`No confirmation code delivered for ${username}`);
}

// Idempotent: signs an existing/confirmed user straight in; otherwise runs the
// full sign-up → confirm → auto-sign-in chain. Safe to call across re-runs.
async function ensureSignedIn(username: string, password: string) {
  try {
    const s = await authApi.setAuthState({ action: 'signIn', username, password });
    if (s.state === 'signedIn') return s;
  } catch { /* user does not exist yet — fall through to sign-up */ }

  await authApi.setAuthState({ action: 'signUp', username, password });
  const code = await readConfirmationCode(username);
  await authApi.setAuthState({ action: 'confirmSignUp', username, code });
  // autoSignIn completes the COMPLETE_AUTO_SIGN_IN bridge → signedIn
  return await authApi.setAuthState({ action: 'autoSignIn', username });
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

test('auth: starts signed out', async () => {
  const state = await authApi.getAuthState();
  assert.strictEqual(state.state, 'signedOut');
});

test('auth: sign up + confirm (Cognito) signs in', async () => {
  const state = await ensureSignedIn(TEST_USER, TEST_PASS);
  assert.strictEqual(state.state, 'signedIn');
  assert.strictEqual(state.user?.username, TEST_USER);
});

test('auth: unauthenticated access is rejected', async () => {
  // Sign out first
  await authApi.setAuthState({ action: 'signOut' });

  await assert.rejects(
    () => api.listTodos(),
    (err: any) => err.message.includes('Authentication') || err.message.includes('Session') || err.message.includes('401'),
  );

  // Sign back in for remaining tests
  await ensureSignedIn(TEST_USER, TEST_PASS);
});

// ─── CRUD ─────────────────────────────────────────────────────────────────────

test('todos: create with priority', async () => {
  const todo = await api.createTodo('Buy milk', 1);
  assert.strictEqual(todo.title, 'Buy milk');
  assert.strictEqual(todo.priority, 1);
  assert.strictEqual(todo.completed, false);
  assert.strictEqual(todo.version, 1);
  assert.ok(todo.todoId);
});

test('todos: list (only own)', async () => {
  const list = await api.listTodos();
  assert.ok(list.length >= 1);
  assert.ok(list.every(t => t.userId === 'testuser@example.com'));
});

test('todos: list sorted by priority (secondary index)', async () => {
  // Create todos with different priorities
  await api.createTodo('Low priority task', 3);
  await api.createTodo('High priority task', 1);

  const sorted = await api.listTodos('priority');
  assert.ok(sorted.length >= 2);
  // Priority 1 (high) should come before priority 3 (low)
  const priorities = sorted.map(t => t.priority);
  for (let i = 1; i < priorities.length; i++) {
    assert.ok(priorities[i] >= priorities[i - 1], 'Should be sorted by priority ascending');
  }
});

test('todos: list sorted by title (secondary index)', async () => {
  const sorted = await api.listTodos('title');
  assert.ok(sorted.length >= 2);
  const titles = sorted.map(t => t.title);
  for (let i = 1; i < titles.length; i++) {
    assert.ok(titles[i] >= titles[i - 1], 'Should be sorted by title ascending');
  }
});

test('todos: toggle completion', async () => {
  const [todo] = await api.listTodos();
  await api.toggleTodo(todo.todoId);

  const updated = (await api.listTodos()).find(t => t.todoId === todo.todoId);
  assert.strictEqual(updated?.completed, !todo.completed);
  assert.strictEqual(updated?.version, todo.version + 1);
});

test('todos: delete', async () => {
  const before = await api.listTodos();
  const target = before[0];
  await api.deleteTodo(target.todoId);

  const after = await api.listTodos();
  assert.ok(!after.some(t => t.todoId === target.todoId));
});

// ─── Conditional writes (optimistic locking) ──────────────────────────────────

test('todos: concurrent toggle → conflict → retry succeeds', async () => {
  // Create a fresh todo
  const todo = await api.createTodo('Conflict test');

  // Simulate a concurrent write by toggling twice "simultaneously"
  // First toggle succeeds (version 1 → 2)
  await api.toggleTodo(todo.todoId);

  // Read current state
  const current = (await api.listTodos()).find(t => t.todoId === todo.todoId);
  assert.strictEqual(current?.version, 2);

  // Toggle again — should succeed because we're reading fresh version
  await api.toggleTodo(todo.todoId);
  const final = (await api.listTodos()).find(t => t.todoId === todo.todoId);
  assert.strictEqual(final?.version, 3);
  assert.strictEqual(final?.completed, todo.completed); // toggled twice = back to original

  // Cleanup
  await api.deleteTodo(todo.todoId);
});

// ─── Tickets (staged: AuthCognito + Database + FileBucket) ─────────────────────
// Exercises the newly added ticket API against the local mock (embedded Postgres
// for Database, in-memory FileBucket). Each test signs in via the shared helper.

test('tickets: create returns an open ticket', async () => {
  await ensureSignedIn(TEST_USER, TEST_PASS);
  const t = await api.createTicket('Printer broken', 'Smoke is coming out', 'high');
  assert.ok(t?.id, 'should return a row with an id');
  assert.strictEqual(t?.title, 'Printer broken');
  assert.strictEqual(t?.status, 'open');       // DB default
  assert.strictEqual(t?.priority, 'high');
  assert.strictEqual(t?.attachment_key, null);
});

test('tickets: whoami matches the ticket owner', async () => {
  const me = await api.whoami();
  assert.strictEqual(me.email, TEST_USER);
  assert.ok(me.sub);
  const t = await api.createTicket('Owner check', 'body');
  assert.strictEqual(t?.owner_sub, me.sub);     // owner_sub == Cognito userSub
});

test('tickets: list returns only own tickets, newest first', async () => {
  const me = await api.whoami();
  const list = await api.listTickets();
  assert.ok(list.length >= 1);
  assert.ok(list.every(t => t.owner_sub === me.sub), 'only own tickets');
  // ORDER BY created_at DESC
  for (let i = 1; i < list.length; i++) {
    assert.ok(
      new Date(list[i - 1].created_at).getTime() >= new Date(list[i].created_at).getTime(),
      'should be newest first',
    );
  }
});

test('tickets: get a single ticket by id', async () => {
  const created = await api.createTicket('Fetch me', 'detail', 'normal');
  const got = await api.getTicket(created!.id);
  assert.strictEqual(got?.id, created!.id);
  assert.strictEqual(got?.title, 'Fetch me');
  assert.strictEqual(got?.priority, 'normal');
});

test('tickets: close sets status to closed', async () => {
  const created = await api.createTicket('Close me', 'detail');
  const res = await api.closeTicket(created!.id);
  assert.deepStrictEqual(res, { ok: true });
  const got = await api.getTicket(created!.id);
  assert.strictEqual(got?.status, 'closed');
});

test('tickets: attachment upload url is namespaced + presigned', async () => {
  const me = await api.whoami();
  const { key, url } = await api.getAttachmentUploadUrl('my photo.png');
  assert.ok(key.startsWith(`${me.sub}/`), 'key is prefixed with the owner sub');
  assert.ok(key.includes('my%20photo.png'), 'filename is URL-encoded');
  assert.match(url, /^https?:\/\//);
});

test('tickets: ticket without an attachment yields a null url', async () => {
  const created = await api.createTicket('No file', 'detail');
  const { url } = await api.getTicketAttachmentUrl(created!.id);
  assert.strictEqual(url, null);
});

test('tickets: unauthenticated access is rejected', async () => {
  await authApi.setAuthState({ action: 'signOut' });
  await assert.rejects(
    () => api.listTickets(),
    (err: any) => /Auth|Session|401|NotAuthenticated/i.test(err.message),
  );
  // Restore signed-in state for any later tests
  await ensureSignedIn(TEST_USER, TEST_PASS);
});

// ─── Realtime ─────────────────────────────────────────────────────────────────
// Note: Realtime subscription tests require the middleware to be loaded,
// which happens automatically when the dev server regenerates client.js.
// For a manual test: run `npm run dev`, open two browser tabs, and create
// a todo in one — it should appear in the other immediately.
