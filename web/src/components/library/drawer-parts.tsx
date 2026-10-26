import { useState } from 'react';
import { ExternalLink } from 'lucide-react';

import { useFeedback } from '@/components/feedback/use-feedback';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

export const DAY = 24 * 60 * 60 * 1000;

// `value` is a day count; the control computes `now + value·DAY`. Months/years
// are fixed day counts (90/180/365), not calendar-accurate — the drawer works
// in days and the approximation is fine for a Share Link horizon.
const EXPIRY_PRESETS = [
  { value: '1', label: '24 hours' },
  { value: '3', label: '3 days' },
  { value: '7', label: '7 days' },
  { value: '14', label: '2 weeks' },
  { value: '28', label: '4 weeks' },
  { value: '90', label: '3 months' },
  { value: '180', label: '6 months' },
  { value: '365', label: '1 year' },
];

/** A labelled control group, the drawers' one layout unit. */
export function Field(props: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-muted-foreground">
        {props.label}
      </span>
      {props.children}
    </div>
  );
}

/**
 * The drawers' one channel for mutating API calls: a shared busy flag, a toast
 * on success and the persistent copyable error surface on failure (ADR-0007 /
 * ADR-0009), so no drawer re-invents operator feedback.
 */
export interface DrawerActions {
  /** True while any call started through `run` is in flight. */
  busy: boolean;
  /** Runs `fn`, reporting either outcome. Resolves true when it succeeded. */
  run: (
    fn: () => Promise<unknown>,
    successMsg: string,
    errorTitle: string,
  ) => Promise<boolean>;
  /** Copies an absolute URL to the clipboard, toasting the outcome. */
  copyLink: (url: string) => Promise<void>;
}

export function useDrawerActions(onChanged: () => void): DrawerActions {
  const { notify, reportError } = useFeedback();
  const [busy, setBusy] = useState(false);

  async function run(
    fn: () => Promise<unknown>,
    successMsg: string,
    errorTitle: string,
  ): Promise<boolean> {
    setBusy(true);
    try {
      await fn();
      notify(successMsg);
      onChanged();
      return true;
    } catch (err) {
      // Operator error → persistent, copy-pasteable surface with the reason
      // code and raw diagnostic (ADR-0007/0009), never a transient toast.
      reportError(err, { title: errorTitle });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function copyLink(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      notify('Link copied to clipboard');
    } catch {
      reportError(new Error('The browser blocked clipboard access.'), {
        title: 'Copy failed',
      });
    }
  }

  return { busy, run, copyLink };
}

/** Opens a Share Link in a new tab — the Viewer's own page, as they'd see it. */
export function openShareLink(shareUrl: string): void {
  window.open(shareUrl, '_blank', 'noopener,noreferrer');
}

/**
 * What a drawer needs of its subject to render the Share Link controls. A Video
 * and a Folder are both shareable units (ADR-0006) with exactly these knobs.
 */
export interface ShareLink {
  /** Root-relative Viewer path (`/v/<slug>` or `/f/<slug>`). */
  shareUrl: string;
  protected: boolean;
  expiresAt: number | null;
  expired: boolean;
}

/**
 * Copy link, password protect and link expiry: identical for a Video and a
 * Folder Share Link, so both drawers mount this one panel. The caller supplies
 * the API calls and the password explainer; feedback and the busy flag come
 * from the shared `actions`.
 */
export function ShareLinkFields(props: {
  link: ShareLink;
  actions: DrawerActions;
  /** Explainer beside the password switch, for the on and off states. */
  passwordHint: { on: string; off: string };
  setPassword: (password: string) => Promise<unknown>;
  clearPassword: () => Promise<unknown>;
  setExpiry: (expiresAt: number | null) => Promise<unknown>;
}) {
  const { link, actions } = props;
  const [showPwdInput, setShowPwdInput] = useState(false);
  const [pwd, setPwd] = useState('');

  const shareUrl = `${window.location.origin}${link.shareUrl}`;

  async function onPwdToggle(checked: boolean): Promise<void> {
    if (checked) {
      if (!link.protected) setShowPwdInput(true);
    } else if (link.protected) {
      await actions.run(
        props.clearPassword,
        'Password removed',
        'Could not remove password',
      );
    } else {
      setShowPwdInput(false);
      setPwd('');
    }
  }

  async function savePwd(): Promise<void> {
    if (pwd.trim().length === 0) return;
    const ok = await actions.run(
      () => props.setPassword(pwd.trim()),
      'Password set',
      'Could not set password',
    );
    if (ok) {
      setPwd('');
      setShowPwdInput(false);
    }
  }

  async function onExpiryChange(value: string): Promise<void> {
    const expiresAt = value === 'never' ? null : Date.now() + Number(value) * DAY;
    await actions.run(
      () => props.setExpiry(expiresAt),
      expiresAt == null ? 'Expiry cleared' : 'Link expiry updated',
      'Could not update expiry',
    );
  }

  const expiryStatus = link.expired
    ? 'This link has expired.'
    : link.expiresAt != null
      ? `Expires ${new Date(link.expiresAt).toLocaleString()}`
      : 'Never expires';

  return (
    <>
      <Field label="Share link">
        <div className="flex gap-2">
          <input
            readOnly
            value={shareUrl}
            onFocus={(e) => e.currentTarget.select()}
            className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-3 font-mono text-xs"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => void actions.copyLink(shareUrl)}
          >
            Copy
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => openShareLink(link.shareUrl)}
          >
            <ExternalLink className="size-4" />
          </Button>
        </div>
      </Field>

      <Field label="Password protect">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            {link.protected ? props.passwordHint.on : props.passwordHint.off}
          </span>
          <Switch
            checked={link.protected || showPwdInput}
            onCheckedChange={(c) => void onPwdToggle(c)}
            disabled={actions.busy}
          />
        </div>
        {showPwdInput && !link.protected && (
          <div className="flex gap-2">
            <input
              type="password"
              autoFocus
              value={pwd}
              onChange={(e) => setPwd(e.target.value)}
              placeholder="New password"
              // 16px on small screens: iOS Safari force-zooms the viewport when
              // a focused input is under 16px, which yanks the drawer about.
              className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-base sm:text-sm"
            />
            <Button
              size="sm"
              onClick={() => void savePwd()}
              disabled={actions.busy || pwd.trim().length === 0}
            >
              Save
            </Button>
          </div>
        )}
      </Field>

      <Field label="Link expiry">
        <p className="text-xs text-muted-foreground">{expiryStatus}</p>
        <Select
          onValueChange={(v) => void onExpiryChange(v)}
          disabled={actions.busy}
        >
          <SelectTrigger>
            <SelectValue placeholder="Change link expiry…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="never">Never</SelectItem>
            {EXPIRY_PRESETS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {link.expired ? `Re-enable · ${o.label}` : o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </>
  );
}
