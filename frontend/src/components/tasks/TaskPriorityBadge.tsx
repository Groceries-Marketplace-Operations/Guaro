import type { Task } from '../../types';
import { useT } from '../../i18n';

const colors: Record<Task['priority'], { background: string; color: string }> = {
  low: { background: 'var(--surface-2)', color: 'var(--text-muted)' },
  normal: { background: 'var(--blue-bg)', color: 'var(--blue)' },
  high: { background: 'var(--amber-bg)', color: 'var(--amber-text)' },
  urgent: { background: 'var(--red-bg)', color: 'var(--red)' },
};

export default function TaskPriorityBadge({ priority }: { priority?: Task['priority'] }) {
  const t = useT();
  const level = priority ?? 'normal';
  return <span style={{ ...colors[level], display: 'inline-block', borderRadius: 999,
    padding: '3px 9px', fontSize: '.72rem', fontWeight: 750, whiteSpace: 'nowrap' }}>
    {t(`taskTiming.priority.${level}`)}
  </span>;
}
