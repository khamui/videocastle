import { useEffect, useRef, useState } from 'react';
import {
  getMe,
  getNeedsSetup,
  listVideos,
  setup,
  signIn,
  signOut,
  uploadVideo,
  type OperatorSummary,
  type VideoSummary,
} from './api';

type Screen =
  | { kind: 'loading' }
  | { kind: 'setup' }
  | { kind: 'sign-in' }
  | { kind: 'dashboard'; operator: OperatorSummary };

export function App() {
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' });

  useEffect(() => {
    void (async () => {
      if (await getNeedsSetup()) {
        setScreen({ kind: 'setup' });
        return;
      }
      const me = await getMe();
      setScreen(me ? { kind: 'dashboard', operator: me } : { kind: 'sign-in' });
    })();
  }, []);

  switch (screen.kind) {
    case 'loading':
      return <Centered>Loading…</Centered>;
    case 'setup':
      return (
        <CredentialForm
          title="Set up your instance"
          subtitle="Choose the single Operator credential for this server."
          submitLabel="Create Operator"
          onSubmit={async (u, p) => {
            const operator = await setup(u, p);
            setScreen({ kind: 'dashboard', operator });
          }}
        />
      );
    case 'sign-in':
      return (
        <CredentialForm
          title="Sign in"
          subtitle="Enter your Operator credentials."
          submitLabel="Sign in"
          onSubmit={async (u, p) => {
            const operator = await signIn(u, p);
            setScreen({ kind: 'dashboard', operator });
          }}
        />
      );
    case 'dashboard':
      return (
        <Dashboard
          operator={screen.operator}
          onSignOut={async () => {
            await signOut();
            setScreen({ kind: 'sign-in' });
          }}
        />
      );
  }
}

function Dashboard(props: {
  operator: OperatorSummary;
  onSignOut: () => Promise<void>;
}) {
  const [videos, setVideos] = useState<VideoSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    try {
      setVideos(await listVideos());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the Library');
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  // While anything is still transcoding, poll so state and progress stay live.
  const anyProcessing = (videos ?? []).some((v) => v.state === 'processing');
  useEffect(() => {
    if (!anyProcessing) return;
    const id = setInterval(() => void refresh(), 3000);
    return () => clearInterval(id);
  }, [anyProcessing]);

  return (
    <main className="library">
      <header className="library-head">
        <h1>Library</h1>
        <div className="library-head-right">
          <span className="muted">{props.operator.username}</span>
          <button className="ghost" onClick={() => void props.onSignOut()}>
            Sign out
          </button>
        </div>
      </header>

      <UploadForm onUploaded={() => void refresh()} />

      {error && <p className="error">{error}</p>}

      {videos === null ? (
        <p className="muted">Loading…</p>
      ) : videos.length === 0 ? (
        <p className="placeholder">
          No Videos yet. Upload one above to get a Share Link.
        </p>
      ) : (
        <ul className="video-grid">
          {videos.map((video) => (
            <VideoCard key={video.slug} video={video} />
          ))}
        </ul>
      )}
    </main>
  );
}

function UploadForm(props: { onUploaded: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  return (
    <form
      className="upload"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!file) return;
        setError(null);
        setBusy(true);
        try {
          await uploadVideo({ title, description, file });
          setTitle('');
          setDescription('');
          setFile(null);
          if (fileInput.current) fileInput.current.value = '';
          props.onUploaded();
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Upload failed');
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="upload-row">
        <input
          className="upload-title"
          placeholder="Video title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
        <input
          ref={fileInput}
          type="file"
          accept="video/*,.mov,.mp4,.m4v"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          required
        />
        <button type="submit" disabled={busy || !file || title.trim().length === 0}>
          {busy ? 'Uploading…' : 'Upload'}
        </button>
      </div>
      <input
        className="upload-desc"
        placeholder="Description (optional)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function VideoCard(props: { video: VideoSummary }) {
  const { video } = props;
  const [copied, setCopied] = useState(false);

  async function copyLink(): Promise<void> {
    const url = `${window.location.origin}${video.shareUrl}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <li className="card video-card">
      <div className={`thumb ${video.state === 'processing' ? 'thumb-processing' : `thumb-${hashIndex(video.slug)}`}`}>
        {video.durationSeconds != null && (
          <span className="duration">{formatDuration(video.durationSeconds)}</span>
        )}
      </div>
      <div className="video-body">
        <div className="video-title-row">
          <strong className="video-title">{video.title}</strong>
          <span className={`pill ${video.state}`}>{video.state}</span>
        </div>
        {video.description && <p className="muted video-desc">{video.description}</p>}
        {video.state === 'processing' && (
          <div className="prog">
            <span style={{ width: `${video.progress}%` }} />
          </div>
        )}
        <button className="ghost copy" onClick={() => void copyLink()}>
          {copied ? 'Copied!' : 'Copy link'}
        </button>
      </div>
    </li>
  );
}

function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Stable 0–4 index from a slug, so each placeholder thumbnail gets a steady tint. */
function hashIndex(slug: string): number {
  let hash = 0;
  for (let i = 0; i < slug.length; i++) hash = (hash * 31 + slug.charCodeAt(i)) | 0;
  return Math.abs(hash) % 5;
}

function CredentialForm(props: {
  title: string;
  subtitle: string;
  submitLabel: string;
  onSubmit: (username: string, password: string) => Promise<void>;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <Centered>
      <form
        className="card"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          setBusy(true);
          try {
            await props.onSubmit(username, password);
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Something went wrong');
          } finally {
            setBusy(false);
          }
        }}
      >
        <h1>{props.title}</h1>
        <p className="muted">{props.subtitle}</p>
        <label>
          Username
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? 'Working…' : props.submitLabel}
        </button>
      </form>
    </Centered>
  );
}

function Centered(props: { children: React.ReactNode }) {
  return <main className="centered">{props.children}</main>;
}
