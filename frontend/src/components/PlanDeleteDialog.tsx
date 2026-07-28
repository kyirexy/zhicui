'use client';

import { useEffect, useRef } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import type { PlanData } from '@/lib/types';

interface PlanDeleteDialogProps {
  plan: PlanData | null;
  pending: boolean;
  error: string;
  onClose: () => void;
  onConfirm: () => void;
}

export default function PlanDeleteDialog({
  plan,
  pending,
  error,
  onClose,
  onConfirm,
}: PlanDeleteDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (plan && !dialog.open) dialog.showModal();
    if (!plan && dialog.open) dialog.close();
  }, [plan]);

  return (
    <dialog
      ref={dialogRef}
      className="library-session-dialog plan-delete-dialog"
      aria-labelledby="plan-delete-dialog-title"
      aria-describedby="plan-delete-dialog-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <div className="library-session-dialog-card">
        <div className="library-session-dialog-icon" aria-hidden="true">
          <Trash2 size={20} />
        </div>
        <div>
          <h2 id="plan-delete-dialog-title">删除这份计划？</h2>
          <p id="plan-delete-dialog-description">
            计划和其中的打卡记录会一起删除，此操作无法撤销。
          </p>
          {plan && <p className="library-removal-target">{plan.title}</p>}
        </div>
        {error && <p className="library-session-error" role="alert">{error}</p>}
        <div className="library-session-dialog-actions">
          <button type="button" onClick={onClose} disabled={pending}>取消</button>
          <button
            type="button"
            className="is-danger"
            onClick={onConfirm}
            disabled={pending}
          >
            {pending && <Loader2 size={15} className="animate-spin" />}
            {pending ? '正在删除' : '确认删除'}
          </button>
        </div>
      </div>
    </dialog>
  );
}
