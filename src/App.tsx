import { useEffect, useState } from "react";
import { api, getSession } from "./api";
import CreatePublication from "./CreatePublication";
import MetaConnection from "./MetaConnection";
import type { ApiSession, Publication, PublicationType } from "./types";

type Page = "dashboard" | "create" | "submissions" | "admin";
type LoadState = "loading" | "ready" | "error";

function pageFromPath(): Page {
  const path = window.location.pathname.replace(/\/$/, "");
  if (path === "/new") return "create";
  if (path === "/submissions") return "submissions";
  if (path === "/admin") return "admin";
  return "dashboard";
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "BH";
}

function App() {
  const [page, setPage] = useState<Page>(pageFromPath);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [session, setSession] = useState<ApiSession | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [publications, setPublications] = useState<Publication[]>([]);
  const [publicationsLoading, setPublicationsLoading] = useState(true);
  const [pendingBootstrap, setPendingBootstrap] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);

  const refreshSession = async () => {
    try {
      const nextSession = await getSession();
      setSession(nextSession);
      setPendingBootstrap(nextSession.user?.role === "pending_bootstrap");
      setLoadState("ready");
      setError("");
    } catch (caught) {
      setLoadState("error");
      setError(caught instanceof Error ? caught.message : "Could not connect to the app.");
    }
  };

  useEffect(() => {
    void refreshSession();
    const onPopState = () => setPage(pageFromPath());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (!session?.user || pendingBootstrap) return;
    setPublicationsLoading(true);
    void api<{ items: Publication[] }>("/api/publications?limit=20")
      .then((data) => setPublications(data.items ?? []))
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Could not load your submissions."))
      .finally(() => setPublicationsLoading(false));
  }, [session, pendingBootstrap]);

  useEffect(() => {
    if (session?.user?.role === "member" && page === "admin") {
      setPage("dashboard");
      window.history.replaceState({}, "", "/");
    }
  }, [session, page]);

  useEffect(() => {
    if (!session?.user || pendingBootstrap || !publications.some((item) => ["uploading", "queued", "publishing"].includes(item.status))) return;
    const timer = window.setInterval(() => {
      void api<{ items: Publication[] }>("/api/publications?limit=20")
        .then((data) => setPublications(data.items ?? []))
        .catch(() => undefined);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [session, pendingBootstrap, publications]);

  const navigate = (nextPage: Page, completed = false) => {
    if (uploadBusy && !completed) { setError("Your upload is still running. Wait until it is received before leaving."); return; }
    const nextPath = nextPage === "dashboard" ? "/" : nextPage === "create" ? "/new" : nextPage === "submissions" ? "/submissions" : "/admin";
    window.history.pushState({}, "", nextPath);
    setPage(nextPage);
    setError("");
    setNotice("");
    window.scrollTo({ top: 0 });
  };

  const logout = async () => {
    try {
      await api("/api/auth/logout", { method: "POST", body: "{}" });
    } finally {
      setSession({ user: null, csrfToken: null, bootstrapAvailable: false });
      setPendingBootstrap(false);
      navigate("dashboard");
    }
  };

  if (loadState === "loading") return <main className="loading-screen"><Brand /><span className="spinner" aria-label="Loading" /></main>;
  if (loadState === "error") return <SetupError message={error} onRetry={() => void refreshSession()} />;
  if (!session?.user) return <LoginPage />;
  if (pendingBootstrap) return <BootstrapPage onComplete={() => void refreshSession()} />;

  const user = session.user;

  return (
    <div className="app-shell">
      <header className="app-header">
        <button className="brand-button" onClick={() => navigate("dashboard")} aria-label="Bagh Haru Studio home"><Brand /></button>
        <nav className="main-nav" aria-label="Main navigation">
          <NavButton current={page === "dashboard"} onClick={() => navigate("dashboard")} icon="home">Home</NavButton>
          <NavButton current={page === "create"} onClick={() => navigate("create")} icon="plus">Create</NavButton>
          <NavButton current={page === "submissions"} onClick={() => navigate("submissions")} icon="grid">My posts</NavButton>
          {user.role === "admin" && <NavButton current={page === "admin"} onClick={() => navigate("admin")} icon="settings">Admin</NavButton>}
        </nav>
        <div className="header-user"><span className="avatar" title={user.email}>{initials(user.name)}</span><button className="icon-button" aria-label="Sign out" title="Sign out" disabled={uploadBusy} onClick={() => void logout()}><Icon name="logout" /></button></div>
      </header>
      <main className="main-area">
        <div className="content-wrap">
          {error && <div className="notice notice-error" role="alert">{error}<button onClick={() => setError("")} aria-label="Dismiss">×</button></div>}
          {notice && <div className="notice notice-success" role="status">{notice}<button onClick={() => setNotice("")} aria-label="Dismiss">×</button></div>}
          {page === "dashboard" && <Dashboard publications={publications} loading={publicationsLoading} onNavigate={navigate} />}
          {page === "create" && <CreatePublication owner={user.id} onBusyChange={setUploadBusy} onComplete={(message) => { setUploadBusy(false); navigate("submissions", true); setNotice(message); void api<{ items: Publication[] }>("/api/publications?limit=20").then((data) => setPublications(data.items ?? [])).catch((caught) => setError(caught instanceof Error ? caught.message : "Could not refresh your posts.")); }} />}
          {page === "submissions" && <Submissions publications={publications} loading={publicationsLoading} onCreate={() => navigate("create")} onRefresh={() => void api<{ items: Publication[] }>("/api/publications?limit=20").then((data) => setPublications(data.items ?? [])).catch((caught) => setError(caught instanceof Error ? caught.message : "Could not refresh your posts."))} />}
          {page === "admin" && user.role === "admin" && <AdminPage />}
        </div>
      </main>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        <NavButton current={page === "dashboard"} onClick={() => navigate("dashboard")} icon="home">Home</NavButton>
        <NavButton current={page === "create"} onClick={() => navigate("create")} icon="plus">Create</NavButton>
        <NavButton current={page === "submissions"} onClick={() => navigate("submissions")} icon="grid">My posts</NavButton>
        {user.role === "admin" && <NavButton current={page === "admin"} onClick={() => navigate("admin")} icon="settings">Admin</NavButton>}
      </nav>
    </div>
  );
}

function Icon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    home: <><path d="m3 10 9-7 9 7" /><path d="M5 9v12h14V9M9 21v-8h6v8" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    grid: <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M4 10h16M10 10v10" /></>,
    settings: <><circle cx="12" cy="12" r="4" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2" /></>,
    logout: <><path d="M9 4H4v16h5M10 12h11m-4-4 4 4-4 4" /></>,
    image: <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8" cy="8" r="1" /><path d="m3 17 5-5 4 4 4-6 5 7" /></>,
    reel: <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="m10 8 6 4-6 4Z" /></>,
    story: <><circle cx="12" cy="12" r="9" strokeDasharray="4 3" /><circle cx="12" cy="12" r="5" /></>,
    carousel: <><rect x="7" y="7" width="14" height="14" rx="2" /><path d="M17 3H5a2 2 0 0 0-2 2v12" /></>,
    upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5" /></>,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  };
  return <svg className="icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.image}</svg>;
}

function Brand() {
  return <div className="brand-lockup"><img className="brand-logo" src="/bagh.png" alt="" width="42" height="42" /><span className="brand-copy"><strong>Bagh Haru</strong><small>Studio</small></span></div>;
}

function NavButton({ current, onClick, icon, children }: { current: boolean; onClick: () => void; icon: string; children: React.ReactNode }) {
  return <button className={`nav-button${current ? " active" : ""}`} onClick={onClick} aria-current={current ? "page" : undefined}><Icon name={icon} />{children}</button>;
}

function LoginPage() {
  const loginMessage = new URLSearchParams(window.location.search).get("login");
  return (
    <main className="login-page">
      <section className="login-copy" aria-labelledby="login-title">
        <img className="login-logo" src="/bagh.png" alt="Bagh Haru logo" width="112" height="112" />
        <h1 id="login-title">Bagh Haru Studio</h1>
        <p className="login-intro">Sign in</p>
        {loginMessage && <div className="notice notice-error" role="alert">{loginMessage === "denied" ? "Account not approved. Contact an admin." : "Sign-in failed. Try again."}</div>}
        <a className="google-button" href="/api/auth/google"><GoogleMark /><span>Continue with Google</span></a>
      </section>
    </main>
  );
}

function GoogleMark() {
  return <svg className="google-mark" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z" transform="translate(4 4) scale(.83)"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.39-4.55H24v9.02h12.9c-.58 2.96-2.25 5.48-4.73 7.18l7.25 5.63c4.23-3.9 6.67-9.64 6.67-16.28Z"/><path fill="#FBBC05" d="M9.79 28.33a14.4 14.4 0 0 1 0-8.66l-7.98-6.2a23.96 23.96 0 0 0 0 21.06l7.98-6.2Z" transform="translate(4 4) scale(.83)"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.91-5.8l-7.25-5.63c-2.01 1.35-4.58 2.15-8.66 2.15-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.2C6.51 42.62 14.62 48 24 48Z" transform="translate(4 4) scale(.83)"/></svg>;
}

function SetupError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <main className="setup-error"><Brand /><div className="setup-error-card"><div className="setup-error-icon">!</div><h1>We couldn’t connect</h1><p>{message || "The workspace is not ready yet."}</p><button className="secondary-button" onClick={onRetry}>Try again</button></div></main>;
}

function BootstrapPage({ onComplete }: { onComplete: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try { await api("/api/bootstrap", { method: "POST", body: JSON.stringify({ token }) }); onComplete(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Setup could not be completed."); }
    finally { setBusy(false); }
  };
  return <main className="login-page bootstrap-page"><div className="login-top"><Brand /></div><form className="bootstrap-card" onSubmit={(event) => void submit(event)}><h1>Admin setup</h1>{error && <div className="notice notice-error" role="alert">{error}</div>}<label className="field-label" htmlFor="bootstrap-token">One-time setup code</label><input id="bootstrap-token" className="text-input" type="password" autoComplete="off" required value={token} onChange={(event) => setToken(event.target.value)} /><button className="primary-button full-button" disabled={busy}>{busy ? "Setting up…" : "Finish setup"}</button></form></main>;
}

function Dashboard({ publications, loading, onNavigate }: { publications: Publication[]; loading: boolean; onNavigate: (page: Page) => void }) {
  const recent = publications.slice(0, 5);
  const activeCount = publications.filter((item) => ["uploading", "queued", "publishing"].includes(item.status)).length;
  return <>
    <section className="welcome-row"><h1>Posts</h1><button className="primary-button" onClick={() => onNavigate("create")}><Icon name="plus" />New post</button></section>
    <section className="section-block">{recent.length > 0 && <div className="section-heading"><span className="activity-count">{activeCount > 0 ? `${activeCount} in progress` : ""}</span><button className="text-button" onClick={() => onNavigate("submissions")}>View all <Icon name="arrow" /></button></div>}
      {loading ? <p className="muted-copy" role="status">Loading posts…</p> : recent.length ? <PublicationList publications={recent} /> : <div className="empty-state"><Icon name="image" /><h3>No posts yet</h3></div>}
    </section>
  </>;
}

const typeNames: Record<PublicationType, string> = { post: "Post", reel: "Reel", story: "Story", carousel: "Carousel" };
const statusNames = { uploading: "Uploading", queued: "Processing", publishing: "Publishing", published: "Published", failed: "Failed" } as const;

function PublicationList({ publications }: { publications: Publication[] }) {
  return <div className="publication-list">{publications.map((publication) => <article className="publication-row" key={publication.id}><div className="publication-thumb"><Icon name={publication.type === "post" ? "image" : publication.type} /></div><div className="publication-description"><strong>{publication.caption.trim() || `${typeNames[publication.type]} submission`}</strong><small>{typeNames[publication.type]} · {new Date(publication.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}{publication.media.length ? ` · ${publication.media.length} item${publication.media.length === 1 ? "" : "s"}` : ""}</small>{publication.status === "failed" && publication.errorMessage && <small className="publication-error">{publication.errorMessage}</small>}{publication.status === "published" && publication.permalink && <a className="publication-link" href={publication.permalink} target="_blank" rel="noreferrer">View on Instagram</a>}</div><span className={`status-pill status-${publication.status}`}><span />{statusNames[publication.status]}</span></article>)}</div>;
}

function Submissions({ publications, loading, onRefresh, onCreate }: { publications: Publication[]; loading: boolean; onRefresh: () => void; onCreate: () => void }) {
  return <section className="page-section"><div className="page-intro heading-with-action"><h1>My posts<span className="heading-count">{publications.length}</span></h1><button className="secondary-button" onClick={onRefresh}>Refresh</button></div>{loading ? <p role="status" className="muted-copy">Loading posts…</p> : publications.length ? <PublicationList publications={publications} /> : <div className="empty-state"><Icon name="grid" /><h3>No posts yet</h3><button className="text-button" onClick={onCreate}>Create a post <Icon name="arrow" /></button></div>}</section>;
}

type AdminUser = { id: string; email: string; name: string; role: "member" | "admin"; enabled: boolean; lastLoginAt: string | null };
type AuditEvent = { id: number; actorEmail: string; action: string; targetType: string; createdAt: string };
type IntegrationStatus = { instagramConfigured: boolean; googleConfigured: boolean; uploadsConfigured: boolean };

function AdminPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationStatus | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const load = async () => {
    const [userData, eventData, integrationData] = await Promise.all([
      api<{ items: AdminUser[] }>("/api/admin/users"),
      api<{ items: AuditEvent[] }>("/api/admin/activity?limit=20"),
      api<IntegrationStatus>("/api/admin/integrations"),
    ]);
    setUsers(userData.items); setEvents(eventData.items); setIntegrations(integrationData);
  };
  useEffect(() => { void load().catch((caught) => setError(caught instanceof Error ? caught.message : "Could not load admin data.")); }, []);
  const addUser = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try { await api("/api/admin/users", { method: "POST", body: JSON.stringify({ email }) }); setEmail(""); setMessage("Classmate added."); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not add this classmate."); }
    finally { setBusy(false); }
  };
  const toggleUser = async (user: AdminUser) => {
    setError("");
    try { await api(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: "PATCH", body: JSON.stringify({ enabled: !user.enabled }) }); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not update this account."); }
  };
  return <section className="page-section"><div className="page-intro"><h1>Admin</h1></div>{error && <div className="notice notice-error" role="alert">{error}</div>}{message && <div className="notice notice-success" role="status">{message}</div>}
    <div className="admin-grid"><MetaConnection /><div className="form-card admin-users-card"><div className="form-card-heading"><div><h2>Access</h2></div><span className="member-count">{users.length} accounts</span></div><form className="add-user-form" onSubmit={(event) => void addUser(event)}><input className="text-input" aria-label="Classmate’s Google email" type="email" required placeholder="Google email" value={email} onChange={(event) => setEmail(event.target.value)} /><button className="primary-button" disabled={busy}>{busy ? "Adding…" : "Add"}</button></form><div className="admin-user-list">{users.map((user) => <div className="admin-user-row" key={user.id}><div className="avatar small-avatar">{initials(user.name || user.email)}</div><div className="user-details"><strong>{user.name || user.email}</strong><small>{user.email}</small></div><span className={`role-label ${user.role}`}>{user.role}</span><button className={`toggle-button${user.enabled ? " enabled" : ""}`} onClick={() => void toggleUser(user)} aria-label={`${user.enabled ? "Disable" : "Enable"} ${user.email}`} title={user.enabled ? "Disable access" : "Enable access"}><span /></button></div>)}{!users.length && <p className="muted-copy">No accounts</p>}</div></div>
      <details className="admin-detail audit-card"><summary>Activity</summary>{events.length ? <div className="audit-list">{events.map((item) => <div className="audit-row" key={item.id}><span className="audit-dot" /><div><strong>{item.action.replaceAll("_", " ")}</strong><small>{item.actorEmail || "System"} · {new Date(item.createdAt).toLocaleString()}</small></div></div>)}</div> : <p className="muted-copy">No activity</p>}</details>
      <details className="admin-detail integration-card"><summary>Connections</summary><div className="integration-list">{(["Google sign-in", "Private media uploads", "Instagram publishing"] as const).map((label, index) => { const ready = integrations ? [integrations.googleConfigured, integrations.uploadsConfigured, integrations.instagramConfigured][index] : false; return <div className="integration-row" key={label}><span className={`integration-dot${ready ? " ready" : ""}`} /><strong>{label}</strong><small>{integrations ? ready ? "Configured" : "Needs setup" : "Checking…"}</small></div>; })}</div><p className="muted-copy">Configuration status. Live connections may require verification.</p></details></div>
  </section>;
}

export default App;
