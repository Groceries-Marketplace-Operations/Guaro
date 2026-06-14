const LABEL: Record<string, string> = {
  pending: 'Pending',
  scheduled: 'Scheduled',
  assigned: 'Assigned',
  in_progress: 'In Progress',
  done: 'Done',
  failed: 'Failed',
  blocked: 'Blocked',
  lead: 'Lead',
  application: 'Application',
  integrated: 'Integrated',
  online: 'Online',
};

export default function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`status s-${status}`}>
      {LABEL[status] ?? status}
    </span>
  );
}
