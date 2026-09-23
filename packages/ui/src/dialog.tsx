'use client';
import { useEffect, useRef, type ReactNode } from 'react';
import { Button } from './primitives';

export function Dialog({ open, title, children, onClose }: { open: boolean; title: string; children: ReactNode; onClose: () => void }) {
  const reference = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = reference.current; if (!dialog) return; if (open && !dialog.open) dialog.showModal(); if (!open && dialog.open) dialog.close(); }, [open]);
  return <dialog ref={reference} className="ui-dialog" onCancel={onClose} onClose={onClose} aria-labelledby="dialog-title"><div className="ui-dialog__header"><h2 id="dialog-title">{title}</h2><Button variant="secondary" size="sm" onClick={onClose} aria-label="Close dialog">Close</Button></div>{children}</dialog>;
}
