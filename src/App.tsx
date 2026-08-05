import { useEffect, useState, useCallback, useRef, type ChangeEvent } from 'react';
import { api, authApi } from 'aws-blocks';
import { AccountMenuBar, onAuthChange } from '@aws-blocks/blocks/ui';

// Backend APIs are fully typed — hover over api.* for signatures.
// Full docs: node_modules/@aws-blocks/blocks/README.md

type Todo = { todoId: string; title: string; completed: boolean; priority: number; version: number };
type User = { username: string; userId: string };
type SortBy = 'priority' | 'title' | undefined;

// Ticket row type, kept in sync with the backend automatically.
type Ticket = Awaited<ReturnType<typeof api.listTickets>>[number];

// ─── Support desk (tickets) ───────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  open: '#2563eb',
  triage_required: '#d97706',
  in_progress: '#7c3aed',
  closed: '#6b7280',
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span style={{
      fontSize: '0.7em', fontWeight: 600, color: '#fff', padding: '2px 8px',
      borderRadius: 10, background: STATUS_COLORS[status] ?? '#6b7280',
      textTransform: 'uppercase', letterSpacing: 0.3, whiteSpace: 'nowrap',
    }}>
      {status.replace('_', ' ')}
    </span>
  );
}

function SupportDesk() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [me, setMe] = useState<{ sub: string; email: string } | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState<'normal' | 'high'>('normal');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [upload, setUpload] = useState('');
  const [attachment, setAttachment] = useState<{ key: string; name: string } | null>(null);

  const load = useCallback(async () => {
    try { setTickets(await api.listTickets()); }
    catch (e: any) { setError(e.message); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.whoami().then(setMe).catch(() => {}); }, []);

  const create = async () => {
    if (!title.trim()) return;
    setBusy(true); setError('');
    try {
      await api.createTicket(title.trim(), body.trim(), priority, attachment?.key);
      setTitle(''); setBody(''); setPriority('normal');
      setAttachment(null); setUpload('');
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  const close = async (id: string) => {
    setError('');
    try { await api.closeTicket(id); await load(); }
    catch (e: any) { setError(e.message); }
  };

  // Presigned PUT でアップロードし、キーは createTicket でチケットに紐付ける。
  const onPickFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setAttachment(null);
    setUpload(`Uploading ${file.name}…`);
    try {
      const { key, url } = await api.getAttachmentUploadUrl(file.name);
      const res = await fetch(url, { method: 'PUT', body: file });
      if (!res.ok) throw new Error(`PUT ${res.status}`);
      setAttachment({ key, name: file.name });
      setUpload('Uploaded ✓ — will be attached on create');
    } catch (err: any) {
      setUpload(`Upload failed: ${err.message}`);
    }
  };

  // key ではなく ticketId を渡し、所有者チェックを通った場合のみ期限付き URL が返る。
  const download = async (ticketId: string) => {
    setError('');
    try {
      const { url } = await api.getTicketAttachmentUrl(ticketId);
      if (!url) { setError('No attachment on this ticket.'); return; }
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (e: any) { setError(e.message); }
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <h2 style={{ marginBottom: 4 }}>🎫 Support tickets</h2>
        <button onClick={load} style={{ fontSize: '0.8em' }}>Refresh</button>
      </div>
      {me && (
        <p style={{ color: '#888', fontSize: '0.82em', marginTop: 0 }}>
          Signed in as <strong>{me.email}</strong> · <code>{me.sub.slice(0, 8)}…</code>
        </p>
      )}

      {/* Create form */}
      <div style={{ border: '1px solid #eee', borderRadius: 8, padding: 12, marginBottom: 16 }}>
        <input
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="Ticket title"
          style={{ width: '100%', boxSizing: 'border-box', margin: 0 }}
        />
        <textarea
          value={body}
          onChange={e => setBody(e.target.value)}
          placeholder="Describe the issue…"
          rows={3}
          style={{ width: '100%', boxSizing: 'border-box', marginTop: 6, fontFamily: 'inherit' }}
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
          <select value={priority} onChange={e => setPriority(e.target.value as 'normal' | 'high')}>
            <option value="normal">🟢 Normal</option>
            <option value="high">🔴 High</option>
          </select>
          <button onClick={create} disabled={busy || !title.trim()}>
            {busy ? 'Creating…' : 'Create ticket'}
          </button>
          <label style={{ fontSize: '0.85em', color: '#666' }}>
            📎 Attachment: <input type="file" onChange={onPickFile} style={{ fontSize: '0.85em' }} />
          </label>
        </div>
        {upload && (
          <p style={{ fontSize: '0.8em', color: '#555', margin: '8px 0 0' }}>
            {upload}
            {attachment && <> — 📎 <code style={{ color: '#aaa' }}>{attachment.name}</code></>}
          </p>
        )}
        {error && <p style={{ color: '#c00', fontSize: '0.85em', margin: '8px 0 0' }}>⚠ {error}</p>}
      </div>

      {/* List */}
      {tickets.length === 0 && <p style={{ color: '#999' }}>No tickets yet — create one above.</p>}
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {tickets.map(t => (
          <li key={t.id} style={{
            border: '1px solid #eee', borderRadius: 8, padding: '10px 12px',
            margin: '8px 0', opacity: t.status === 'closed' ? 0.6 : 1,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <StatusBadge status={t.status} />
              <span style={{ fontWeight: 600, flex: 1 }}>{t.title}</span>
              {t.priority === 'high' && <span title="high priority">🔴</span>}
              {t.attachment_key && (
                <button onClick={() => download(t.id)} title="Download attachment">📎 Download</button>
              )}
              {t.status !== 'closed' && <button onClick={() => close(t.id)}>Close</button>}
            </div>
            {t.body && (
              <p style={{ margin: '6px 0 0', color: '#555', fontSize: '0.9em', whiteSpace: 'pre-wrap' }}>{t.body}</p>
            )}
            <p style={{ margin: '6px 0 0', color: '#aaa', fontSize: '0.75em' }}>
              #{t.id} · {new Date(t.created_at).toLocaleString()}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Todos (original starter demo) ────────────────────────────────────────────

function TodoApp() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [newTitle, setNewTitle] = useState('');
  const [newPriority, setNewPriority] = useState(2);
  const [sortBy, setSortBy] = useState<SortBy>(undefined);

  const load = useCallback(async () => {
    setTodos(await api.listTodos(sortBy));
  }, [sortBy]);

  const greet = useCallback(async () => {
    const greeting = await api.greet();
    console.log(greeting);
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    let sub: any;
    (async () => {
      try {
        const channel = await api.subscribeTodos();
        sub = channel.subscribe(() => load());
        await sub.established;
      } catch { /* realtime not available in local dev */ }
    })();
    return () => sub?.unsubscribe();
  }, [load]);

  const addTodo = async () => {
    if (!newTitle.trim()) return;
    await api.createTodo(newTitle.trim(), newPriority);
    setNewTitle('');
    await load();
  };

  const toggle = async (todoId: string) => {
    try { await api.toggleTodo(todoId); } catch {}
    await load();
  };

  const changePriority = async (todoId: string, priority: number) => {
    try { await api.updatePriority(todoId, priority); } catch {}
    await load();
  };

  const remove = async (todoId: string) => {
    await api.deleteTodo(todoId);
    await load();
  };

  return (
    <div>
      <h2>Todos</h2>
      <button onClick={greet}>Greet</button>
      <div style={{ marginBottom: 12, display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          value={newTitle}
          onChange={e => setNewTitle(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && addTodo()}
          placeholder="What needs to be done?"
          style={{ flex: 1, minWidth: 200, padding: 8 }}
        />
        <select value={newPriority} onChange={e => setNewPriority(Number(e.target.value))}>
          <option value={1}>🔴 High</option>
          <option value={2}>🟡 Medium</option>
          <option value={3}>🟢 Low</option>
        </select>
        <button onClick={addTodo}>Add</button>
      </div>
      <div style={{ marginBottom: 12, fontSize: '0.85em', color: '#666' }}>
        Sort:{' '}
        <button onClick={() => setSortBy(undefined)} style={{ fontWeight: !sortBy ? 'bold' : 'normal' }}>Default</button>{' '}
        <button onClick={() => setSortBy('priority')} style={{ fontWeight: sortBy === 'priority' ? 'bold' : 'normal' }}>Priority</button>{' '}
        <button onClick={() => setSortBy('title')} style={{ fontWeight: sortBy === 'title' ? 'bold' : 'normal' }}>Title</button>
      </div>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {todos.map(t => (
          <li key={t.todoId} style={{ margin: '10px 0', display: 'flex', alignItems: 'center', gap: 8, textDecoration: t.completed ? 'line-through' : 'none', opacity: t.completed ? 0.5 : 1 }}>
            <input type="checkbox" checked={t.completed} onChange={() => toggle(t.todoId)} />
            <span style={{ flex: 1 }}>{t.title}</span>
            <select value={t.priority} onChange={e => changePriority(t.todoId, Number(e.target.value))}>
              <option value={1}>🔴 High</option>
              <option value={2}>🟡 Medium</option>
              <option value={3}>🟢 Low</option>
            </select>
            <button onClick={() => remove(t.todoId)}>×</button>
          </li>
        ))}
      </ul>
      <p style={{ color: '#888', fontSize: '0.85em' }}>{todos.filter(t => !t.completed).length} remaining</p>
    </div>
  );
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (menuRef.current && !menuRef.current.hasChildNodes()) {
      menuRef.current.appendChild(AccountMenuBar(authApi));
    }
  }, []);

  useEffect(() => {
    return onAuthChange(authApi, (u) => setUser(u));
  }, []);

  return (
    <div>
      <div ref={menuRef} />
      <h1>Mini Support Desk</h1>
      <p style={{ color: '#666', fontSize: '0.9em', lineHeight: 1.5, marginBottom: 24 }}>
        Sign up (a confirmation code is printed to the dev-server terminal), then create
        support tickets backed by <strong>Cognito auth</strong>, a <strong>SQL database</strong>,
        and <strong>file attachments</strong>. The original todo demo is kept below.
      </p>
      {!user && <p>Sign in to get started.</p>}
      {user && (
        <>
          <SupportDesk />
          <hr style={{ margin: '32px 0', border: 0, borderTop: '1px solid #eee' }} />
          <details>
            <summary style={{ cursor: 'pointer', color: '#666' }}>Todos (original starter demo)</summary>
            <div style={{ marginTop: 12 }}><TodoApp /></div>
          </details>
        </>
      )}
    </div>
  );
}
