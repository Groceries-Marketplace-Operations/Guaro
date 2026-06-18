import { useT } from '../../i18n';

export default function StatusBadge({ status }: { status: string }) {
  const t = useT();
  const key = `status.${status}`;
  const label = t(key) !== key ? t(key) : status;
  return (
    <span className={`status s-${status}`}>
      {label}
    </span>
  );
}
