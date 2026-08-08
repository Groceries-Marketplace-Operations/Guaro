interface ExecutionTimingProps {
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
}

function timestamp(value?: string) {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString();
}

export function formatExecutionDuration(milliseconds?: number) {
  if (milliseconds === undefined || milliseconds === null || milliseconds < 0) return '—';
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [days ? `${days}d` : '', hours ? `${hours}h` : '', minutes ? `${minutes}m` : '', `${seconds}s`]
    .filter(Boolean)
    .join(' ');
}

export default function ExecutionTiming({ startedAt, finishedAt, durationMs }: ExecutionTimingProps) {
  const started = startedAt ? new Date(startedAt).getTime() : Number.NaN;
  const finished = finishedAt ? new Date(finishedAt).getTime() : Number.NaN;
  const calculatedDuration = durationMs ?? (Number.isFinite(started)
    ? Math.max(0, (Number.isFinite(finished) ? finished : Date.now()) - started)
    : undefined);
  const entries = [
    { label: 'Inició', value: startedAt ? timestamp(startedAt) : 'Pendiente' },
    { label: 'Terminó', value: finishedAt ? timestamp(finishedAt) : startedAt ? 'En curso' : '—' },
    { label: 'Duración', value: formatExecutionDuration(calculatedDuration) },
  ];

  return <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
    {entries.map(entry => <div key={entry.label} style={{
      minWidth: 150,
      padding: '8px 10px',
      border: '1px solid var(--border)',
      borderRadius: 8,
      background: 'var(--surface-2)',
      fontSize: 12,
    }}>
      <span className="text-muted" style={{ display: 'block', fontSize: 10, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 3 }}>{entry.label}</span>
      <strong style={{ fontWeight: 600 }}>{entry.value}</strong>
    </div>)}
  </div>;
}
