import * as React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { Toaster, toast } from 'sonner';

import { ApiError } from '@/api';
import { Button } from '@/components/ui/button';
import {
  FeedbackContext,
  type FeedbackApi,
  type OperatorError,
} from '@/components/feedback/use-feedback';

let seq = 0;

function toOperatorError(error: unknown, title: string): OperatorError {
  const id = `err-${(seq += 1)}`;
  if (error instanceof ApiError) {
    return { id, title, message: error.message, reason: error.reason, detail: error.detail };
  }
  if (error instanceof Error) {
    return { id, title, message: error.message };
  }
  return { id, title, message: String(error) };
}

/**
 * Mounts the two ADR-0009 feedback channels for everything it wraps: transient
 * success toasts (sonner, bottom-centre) and a persistent, copy-pasteable error
 * stack. Expose them to descendants via {@link useFeedback}.
 */
export function FeedbackProvider({ children }: { children: React.ReactNode }) {
  const [errors, setErrors] = useState<OperatorError[]>([]);

  const notify = useCallback<FeedbackApi['notify']>((message, opts) => {
    toast.success(message, { description: opts?.description });
  }, []);

  const reportError = useCallback<FeedbackApi['reportError']>((error, opts) => {
    setErrors((prev) => [
      ...prev,
      toOperatorError(error, opts?.title ?? 'Something went wrong'),
    ]);
  }, []);

  const dismiss = useCallback((id: string) => {
    setErrors((prev) => prev.filter((e) => e.id !== id));
  }, []);

  const api = useMemo<FeedbackApi>(() => ({ notify, reportError }), [notify, reportError]);

  return (
    <FeedbackContext.Provider value={api}>
      {children}
      <ErrorStack errors={errors} onDismiss={dismiss} />
      <Toaster
        position="bottom-center"
        theme="dark"
        toastOptions={{
          // The `--sd-*` backing tokens, not `--card`/`--border`: `@theme
          // inline` (index.css) inlines its values into Tailwind's utilities
          // and emits no `--color-*` custom properties, and nothing defines a
          // bare `--card` at all. An inline style naming a variable that
          // doesn't resolve is invalid at computed-value time, which for
          // `background` means transparent — a toast you can read the page
          // through. These are the only names that resolve at runtime.
          style: {
            background: 'var(--sd-card)',
            color: 'var(--sd-card-foreground)',
            border: '1px solid var(--sd-border)',
          },
        }}
      />
    </FeedbackContext.Provider>
  );
}

function ErrorStack({
  errors,
  onDismiss,
}: {
  errors: OperatorError[];
  onDismiss: (id: string) => void;
}) {
  if (errors.length === 0) return null;
  return (
    <div className="fixed right-4 top-4 z-50 flex w-[min(28rem,calc(100vw-2rem))] flex-col gap-2">
      {errors.map((err) => (
        <ErrorCard key={err.id} error={err} onDismiss={() => onDismiss(err.id)} />
      ))}
    </div>
  );
}

function ErrorCard({
  error,
  onDismiss,
}: {
  error: OperatorError;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copyText = [
    error.title,
    error.message,
    error.reason ? `reason: ${error.reason}` : null,
    error.detail ? `detail: ${error.detail}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  async function copy() {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="select-text rounded-lg border border-destructive/50 bg-card text-card-foreground shadow-lg">
      <div className="flex items-start justify-between gap-2 border-b border-border/60 px-3 py-2">
        <span className="text-sm font-semibold text-destructive">{error.title}</span>
        <button
          onClick={onDismiss}
          aria-label="Dismiss error"
          className="-mr-1 shrink-0 cursor-pointer rounded px-1 text-muted-foreground hover:text-foreground"
        >
          ✕
        </button>
      </div>
      <div className="flex flex-col gap-2 px-3 py-2">
        <p className="text-sm leading-snug break-words">{error.message}</p>
        {error.reason ? (
          <code className="w-fit rounded border border-border bg-background px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
            reason: {error.reason}
          </code>
        ) : null}
        {error.detail ? (
          <pre className="max-h-48 overflow-auto rounded border border-border bg-background p-2 font-mono text-xs whitespace-pre-wrap break-words text-muted-foreground">
            {error.detail}
          </pre>
        ) : null}
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={() => void copy()}>
            {copied ? 'Copied!' : 'Copy'}
          </Button>
        </div>
      </div>
    </div>
  );
}
