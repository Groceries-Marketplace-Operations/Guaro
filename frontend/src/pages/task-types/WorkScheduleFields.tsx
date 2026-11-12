import type { TaskType } from '../../types';
import { useT } from '../../i18n';

export type WorkScheduleForm = Pick<TaskType,
  'deliveryMinutes' | 'workDays' | 'workStartMinute' | 'workEndMinute' | 'workTimeZone'> & {
  deliveryMinutes: number | null;
  workDays: number[];
  workStartMinute: number;
  workEndMinute: number;
  workTimeZone: string;
};

export const DEFAULT_WORK_SCHEDULE: WorkScheduleForm = {
  deliveryMinutes: null,
  workDays: [1, 2, 3, 4, 5],
  workStartMinute: 540,
  workEndMinute: 1080,
  workTimeZone: 'America/Mexico_City',
};

const DAYS = [1, 2, 3, 4, 5, 6, 7] as const;

export const timeValue = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

export const timeMinutes = (value: string) => {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
};

export function workScheduleSummary(schedule: Pick<TaskType,
  'deliveryMinutes' | 'workDays' | 'workStartMinute' | 'workEndMinute' | 'workTimeZone'>,
  t: (key: string, vars?: Record<string, string>) => string) {
  if (!schedule.deliveryMinutes) return t('taskTiming.noDeadline');
  const hours = schedule.deliveryMinutes / 60;
  const days = schedule.workDays ?? DEFAULT_WORK_SCHEDULE.workDays;
  const dayLabel = days.length === 5 && days.every((day, index) => day === index + 1)
    ? t('taskTiming.weekdays') : DAYS.filter(day => days.includes(day)).map(day => t(`taskTiming.day.${day}`)).join(', ');
  return t('taskTiming.summary', {
    hours: String(hours), days: dayLabel,
    start: timeValue(schedule.workStartMinute ?? 540), end: timeValue(schedule.workEndMinute ?? 1080),
  });
}

export default function WorkScheduleFields({ value, onChange }: {
  value: WorkScheduleForm;
  onChange: (patch: Partial<WorkScheduleForm>) => void;
}) {
  const t = useT();
  return (
    <section className="tt-work-settings">
      <div className="tt-work-settings__heading">
        <div>
          <strong>{t('taskTiming.title')}</strong>
          <p>{t('taskTiming.description')}</p>
        </div>
        <label className="tt-work-toggle">
          <input type="checkbox" checked={value.deliveryMinutes !== null}
            onChange={event => onChange({ deliveryMinutes: event.target.checked ? 480 : null })} />
          <span>{value.deliveryMinutes !== null ? t('taskTiming.enabled') : t('taskTiming.disabled')}</span>
        </label>
      </div>
      {value.deliveryMinutes !== null && (
        <>
          <div className="tt-work-settings__grid">
            <label className="form-group">
              <span className="form-label">{t('taskTiming.hours')}</span>
              <input className="form-input" type="number" min="0.25" max="720" step="0.25"
                value={value.deliveryMinutes / 60}
                onChange={event => onChange({ deliveryMinutes: Math.round(Number(event.target.value) * 60) })} required />
            </label>
            <label className="form-group">
              <span className="form-label">{t('taskTiming.zone')}</span>
              <input className="form-input" list="tt-time-zones" value={value.workTimeZone}
                onChange={event => onChange({ workTimeZone: event.target.value })} required />
              <datalist id="tt-time-zones">
                <option value="America/Mexico_City" /><option value="America/Bogota" />
                <option value="America/Lima" /><option value="America/Santiago" /><option value="UTC" />
              </datalist>
            </label>
          </div>
          <div className="form-group">
            <span className="form-label">{t('taskTiming.days')}</span>
            <div className="tt-weekdays">
              {DAYS.map(day => (
                <label key={day} className={`tt-weekday ${value.workDays.includes(day) ? 'is-selected' : ''}`}>
                  <input type="checkbox" checked={value.workDays.includes(day)}
                    onChange={() => onChange({ workDays: value.workDays.includes(day)
                      ? value.workDays.filter(item => item !== day)
                      : [...value.workDays, day].sort((a, b) => a - b) })} />
                  {t(`taskTiming.day.${day}`)}
                </label>
              ))}
            </div>
          </div>
          <div className="tt-work-settings__grid">
            <label className="form-group"><span className="form-label">{t('taskTiming.start')}</span>
              <input className="form-input" type="time" value={timeValue(value.workStartMinute)}
                onChange={event => onChange({ workStartMinute: timeMinutes(event.target.value) })} required />
            </label>
            <label className="form-group"><span className="form-label">{t('taskTiming.end')}</span>
              <input className="form-input" type="time" value={timeValue(value.workEndMinute)}
                onChange={event => onChange({ workEndMinute: timeMinutes(event.target.value) })} required />
            </label>
          </div>
          <p className="form-hint">{t('taskTiming.hint')}</p>
        </>
      )}
    </section>
  );
}
