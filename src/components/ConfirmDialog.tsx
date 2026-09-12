import React, { useRef } from 'react';
import { Modal } from './Modal';

// ─── Types ───
export interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Yes/no dialog built on Modal. Focus lands on cancel, the safe choice. */
export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
}) => {
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title={title}
      panelClassName="max-w-sm"
      initialFocusRef={cancelRef}
    >
      <p className="text-sm text-stone-600">{message}</p>
      <div className="mt-5 flex items-center justify-end gap-2">
        <button ref={cancelRef} type="button" onClick={onCancel} className="edu-btn-secondary">
          {cancelLabel}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className={
            danger
              ? 'inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-red-500 hover:bg-red-600 text-white font-bold text-xs transition-colors'
              : 'edu-btn-primary'
          }
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
};
