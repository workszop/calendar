import React, { useCallback, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

// ─── Types ───
export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  panelClassName?: string;
  titleIcon?: React.ReactNode;
  /** Focus this element when the dialog opens, instead of the first focusable one. */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  /** Clicking the scrim closes the dialog. Turn off for destructive or long forms. */
  dismissOnBackdrop?: boolean;
}

// ─── Constants ───
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const CLOSE_BUTTON_ATTR = 'data-modal-close';

/**
 * Accessible dialog: focus trap, Escape to close, focus restore, scroll lock.
 * Rendered in a portal on <body> so the rest of the app can be marked inert.
 * Every hook runs before the closed-state early return.
 */
export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  subtitle,
  children,
  panelClassName = 'max-w-md',
  titleIcon,
  initialFocusRef,
  dismissOnBackdrop = true,
}) => {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  const focusableIn = useCallback((panel: HTMLElement): HTMLElement[] => {
    return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null || el === document.activeElement
    );
  }, []);

  // Remember the trigger, hide the rest of the app, move focus in - and undo
  // all three in one cleanup. Focus restore has to happen after `inert` is off
  // the root, or the browser refuses to focus the trigger again.
  useEffect(() => {
    if (!isOpen) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const root = document.getElementById('root');
    const hadInert = root?.hasAttribute('inert') ?? true;
    if (root && !hadInert) root.setAttribute('inert', '');

    const panel = panelRef.current;
    if (panel) {
      const explicit = initialFocusRef?.current;
      // Prefer real content over the close button, which is a dead end.
      const first = focusableIn(panel).find((el) => !el.hasAttribute(CLOSE_BUTTON_ATTR));
      const target = explicit ?? first ?? panel;
      target.focus();
    }

    return () => {
      if (root && !hadInert) root.removeAttribute('inert');
      previouslyFocused.current?.focus?.();
    };
  }, [isOpen, focusableIn, initialFocusRef]);

  // Lock body scroll while open.
  useEffect(() => {
    if (!isOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [isOpen]);

  // Escape closes; Tab / Shift+Tab stay inside the panel.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented) return;
    // A nested dialog is portaled elsewhere in the DOM, but its key events
    // still bubble here through React; leave those to the nested dialog.
    if (!panelRef.current?.contains(e.target as Node)) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const items = focusableIn(panel);
    if (!items.length) {
      e.preventDefault();
      panel.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && (active === first || !panel.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };

  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 edu-scrim"
      onMouseDown={(e) => {
        if (dismissOnBackdrop && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        className={`bg-white border border-stone-200 rounded-2xl w-full max-h-[90vh] overflow-y-auto shadow-xl ${panelClassName}`}
      >
        <div className="flex items-start justify-between gap-4 px-6 pt-5">
          <div className="flex items-start gap-2 min-w-0">
            {titleIcon}
            <div className="min-w-0">
              <h2 id={titleId} className="text-lg font-bold text-stone-900">
                {title}
              </h2>
              {subtitle && <p className="text-xs text-stone-500">{subtitle}</p>}
            </div>
          </div>
          <button
            type="button"
            aria-label="Close"
            {...{ [CLOSE_BUTTON_ATTR]: '' }}
            onClick={onClose}
            className="p-1.5 rounded-full text-stone-400 hover:text-stone-900 hover:bg-stone-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>,
    document.body
  );
};
