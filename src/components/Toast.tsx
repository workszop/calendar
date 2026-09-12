import type React from 'react';
import { createPortal } from 'react-dom';

// ─── Types ───
export interface ToastProps {
  /** Current message, or null when nothing is showing. */
  message: string | null;
}

/**
 * Non-blocking status line. The live region is always mounted so screen
 * readers announce changes instead of a newly inserted node.
 */
export const Toast: React.FC<ToastProps> = ({ message }) => {
  // Rendered on <body>: inside #root it would be swallowed by the `inert`
  // attribute a modal sets, and screen readers would never announce it.
  return createPortal(
    <div
      aria-live="polite"
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] flex justify-center pointer-events-none"
    >
      {message && (
        <div className="bg-stone-900 text-white rounded-full px-4 py-2 text-xs font-medium shadow-md">
          {message}
        </div>
      )}
    </div>,
    document.body
  );
};
