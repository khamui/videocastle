import { useEffect, useState } from 'react';
import { AlertTriangle, Lock } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { useFeedback } from '@/components/feedback/use-feedback';
import { getServerConfig, type HostConfigSection, type ValueSource } from '../../api';

/**
 * The Host Configuration, read-only (GLOSSARY: Host Configuration).
 *
 * Read-only by construction, not by omission: these values are decided by
 * whoever runs the server and are fixed at process start, so there is nothing
 * here to save. What the view adds is **provenance** — "why is concurrency 2?"
 * should be answerable here rather than by reading the source or guessing at
 * the container's environment. A value that was set but couldn't be read is
 * called out rather than silently replaced by its default (ADR-0007).
 */

const SOURCE_LABEL: Record<ValueSource, string> = {
  default: 'default',
  environment: 'from environment',
  invalid: 'unreadable — using default',
};

const SOURCE_STYLE: Record<ValueSource, string> = {
  default: 'border-border text-muted-foreground',
  environment: 'border-primary/40 text-primary',
  invalid: 'border-destructive/50 text-destructive',
};

export function ServerSection() {
  const { reportError } = useFeedback();
  const [sections, setSections] = useState<HostConfigSection[] | null>(null);

  useEffect(() => {
    getServerConfig()
      .then(setSections)
      .catch((err: unknown) =>
        reportError(err, { title: 'Could not load the server configuration' }),
      );
  }, []);

  const invalid = (sections ?? []).flatMap((section) =>
    section.settings.filter((setting) => setting.source === 'invalid'),
  );

  return (
    <div className="mx-auto flex max-w-[960px] flex-col gap-6 px-6 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">
          How this server is configured, and where each value came from. These
          are set by whoever runs the server — in its environment, before it
          starts — so they can’t be changed from here.
        </p>
      </header>

      {invalid.length > 0 && (
        <div className="banner">
          <strong>
            {invalid.length === 1
              ? 'One setting could not be read.'
              : `${invalid.length} settings could not be read.`}
          </strong>{' '}
          The built-in default is in force for{' '}
          {invalid.map((setting) => setting.key).join(', ')} — check for a typo
          in the environment.
        </div>
      )}

      {sections === null ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : (
        sections.map((section) => (
          <Card key={section.title} className="flex flex-col gap-3 p-5">
            <h2 className="text-sm font-semibold">{section.title}</h2>
            <ul className="flex list-none flex-col gap-3 p-0">
              {section.settings.map((setting) => (
                <li
                  key={setting.key}
                  className="flex flex-col gap-1 border-b border-border/60 pb-3 last:border-0 last:pb-0"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="font-mono text-xs text-muted-foreground">
                      {setting.key}
                    </code>
                    <span
                      className={cn(
                        'rounded-full border px-2 py-0.5 text-[10px]',
                        SOURCE_STYLE[setting.source],
                      )}
                    >
                      {SOURCE_LABEL[setting.source]}
                    </span>
                  </div>
                  <span className="break-all font-mono text-sm">
                    {setting.key === 'SESSION_SECRET' ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Lock className="size-3.5 text-muted-foreground" />
                        {setting.value}
                      </span>
                    ) : (
                      setting.value
                    )}
                    {/* Both figures: the exact one is what gets pasted back
                        into an environment, the readable one is what says
                        whether it is the number they meant. */}
                    {setting.humanValue && (
                      <span className="ml-2 text-muted-foreground">
                        ({setting.humanValue})
                      </span>
                    )}
                  </span>
                  {setting.rejected !== undefined && (
                    <span className="inline-flex items-center gap-1.5 text-xs text-destructive">
                      <AlertTriangle className="size-3.5 shrink-0" />
                      Ignored the environment’s value{' '}
                      <code className="font-mono">“{setting.rejected}”</code>
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {setting.description}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        ))
      )}
    </div>
  );
}
