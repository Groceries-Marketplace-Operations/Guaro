import { useT } from '../../i18n';
import { useTheme } from '../../theme/theme';

const IconTheme = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
  </svg>
);

export default function ThemeSelector({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const { preference, setPreference } = useTheme();

  return (
    <label className={`theme-selector${compact ? ' is-compact' : ''}`}>
      <IconTheme />
      <span className="sr-only">{t('theme.label')}</span>
      <select
        value={preference}
        onChange={event => setPreference(event.target.value as 'system' | 'light' | 'dark')}
        aria-label={t('theme.label')}
        title={t('theme.label')}
      >
        <option value="system">{t('theme.system')}</option>
        <option value="light">{t('theme.light')}</option>
        <option value="dark">{t('theme.dark')}</option>
      </select>
    </label>
  );
}
