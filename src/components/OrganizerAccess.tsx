import React, { useState } from 'react';
import { Download, KeyRound, Link2 } from 'lucide-react';
import { downloadTextFile, fileSafeName } from '../utils/download';

// ─── Organizer access ───
// The organizer code is kept in this browser automatically; these controls let
// the organizer keep their own copy and unlock the poll on another device.

/** URL fragment key: fragments never reach the server or the Referer header. */
export const ORGANIZER_FRAGMENT_KEY = 'organizer';

export function organizerLink(pollId: string, code: string): string {
  return `${window.location.origin}${window.location.pathname}?poll=${encodeURIComponent(pollId)}#${ORGANIZER_FRAGMENT_KEY}=${encodeURIComponent(code)}`;
}

/** Reads and removes an organizer code from the current URL fragment. */
export function takeOrganizerCodeFromUrl(): string | undefined {
  if (!window.location.hash) return undefined;
  const code = new URLSearchParams(window.location.hash.slice(1)).get(ORGANIZER_FRAGMENT_KEY)?.trim();
  if (code) {
    const url = new URL(window.location.href);
    url.hash = '';
    window.history.replaceState(window.history.state, '', url.toString());
  }
  return code || undefined;
}

interface OrganizerCodePanelProps {
  pollId: string;
  pollTitle: string;
  code: string;
  onNotify: (message: string) => void;
  /** Heading level context: the share-ready screen shows a stronger prompt. */
  emphasis?: 'prompt' | 'quiet';
}

export const OrganizerCodePanel: React.FC<OrganizerCodePanelProps> = ({
  pollId,
  pollTitle,
  code,
  onNotify,
  emphasis = 'quiet',
}) => {
  const link = organizerLink(pollId, code);
  const inputId = `organizer-code-${pollId}`;

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      onNotify(`${label} copied`);
    } catch {
      (document.getElementById(inputId) as HTMLInputElement | null)?.select();
      onNotify('Copy unavailable - the code is selected');
    }
  };

  const saveFile = () => {
    downloadTextFile(
      `${fileSafeName(pollTitle)}_organizer_code.txt`,
      [
        `Organizer code for "${pollTitle}"`,
        '',
        `Code: ${code}`,
        `Organizer link: ${link}`,
        '',
        'Keep this private. Anyone with it can lock a meeting time, add dates,',
        'remove responses and delete the poll. Without it, those tools stay locked.',
        '',
      ].join('\n'),
      'text/plain;charset=utf-8'
    );
    onNotify('Organizer code saved as a file');
  };

  return (
    <div className="d-shell-share-box d-organizer-code" data-organizer-code-panel={emphasis}>
      <label htmlFor={inputId}>
        <KeyRound aria-hidden="true" /> Organizer code
      </label>
      <p className="d-organizer-code-hint">
        {emphasis === 'prompt'
          ? 'Save this code now. It is stored in this browser, but you need it to manage the poll from another device or after clearing browser data. It cannot be recovered.'
          : 'Stored in this browser. Keep a copy to manage the poll elsewhere.'}
      </p>
      <div>
        <input id={inputId} type="text" readOnly value={code} className="d-organizer-code-value" />
        <button type="button" className="edu-btn-primary" onClick={() => void copy(code, 'Organizer code')}>
          Copy code
        </button>
      </div>
      <div className="d-organizer-code-actions">
        <button type="button" className="edu-btn-secondary" onClick={() => void copy(link, 'Organizer link')}>
          <Link2 aria-hidden="true" /> Copy organizer link
        </button>
        <button type="button" className="edu-btn-secondary" onClick={saveFile}>
          <Download aria-hidden="true" /> Save as file
        </button>
      </div>
    </div>
  );
};

interface UnlockOrganizerFormProps {
  /** Resolves true when the code unlocks the poll. */
  onUnlock: (code: string) => Promise<boolean>;
}

export const UnlockOrganizerForm: React.FC<UnlockOrganizerFormProps> = ({ onUnlock }) => {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isChecking, setIsChecking] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) {
      setError('Enter the organizer code.');
      return;
    }
    setIsChecking(true);
    setError(null);
    try {
      if (await onUnlock(trimmed)) setCode('');
      else setError('That code does not match this poll.');
    } catch {
      setError('Could not check the code. Please try again.');
    } finally {
      setIsChecking(false);
    }
  };

  return (
    <form className="d-shell-share-box d-organizer-unlock" data-organizer-unlock onSubmit={handleSubmit}>
      <label htmlFor="organizer-unlock-code">
        <KeyRound aria-hidden="true" /> Are you the organizer?
      </label>
      <p className="d-organizer-code-hint">
        Enter the organizer code to lock a time, add dates, remove responses or delete this poll.
      </p>
      <div>
        <input
          id="organizer-unlock-code"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={code}
          disabled={isChecking}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'organizer-unlock-error' : undefined}
          onChange={(event) => {
            setCode(event.target.value);
            if (error) setError(null);
          }}
          className="d-organizer-code-value"
        />
        <button type="submit" className="edu-btn-primary" disabled={isChecking}>
          {isChecking ? 'Checking...' : 'Unlock'}
        </button>
      </div>
      {error && (
        <p id="organizer-unlock-error" role="alert" className="d-organizer-unlock-error">
          {error}
        </p>
      )}
    </form>
  );
};
