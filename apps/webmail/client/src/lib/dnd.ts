import type { ThreadSummary } from '../mail/threads';

/** Conversations being dragged from the list (dataTransfer can't carry objects). */
let payload: ThreadSummary[] | null = null;

export const DND_TYPE = 'application/x-5050-threads';

export function startThreadDrag(e: DragEvent | React.DragEvent, threads: ThreadSummary[]) {
  payload = threads;
  e.dataTransfer?.setData(DND_TYPE, threads.map((t) => t.threadId).join(','));
  e.dataTransfer?.setData('text/plain', threads.map((t) => t.subject).join('\n'));
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  // Gmail-style ghost pill.
  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost';
  ghost.textContent = `Move ${threads.length} conversation${threads.length === 1 ? '' : 's'}`;
  document.body.appendChild(ghost);
  e.dataTransfer?.setDragImage(ghost, -12, -12);
  setTimeout(() => ghost.remove(), 0);
}

export function endThreadDrag() {
  payload = null;
}

export function draggedThreads(e: React.DragEvent): ThreadSummary[] | null {
  if (!e.dataTransfer.types.includes(DND_TYPE)) return null;
  return payload;
}

export function isThreadDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes(DND_TYPE);
}
