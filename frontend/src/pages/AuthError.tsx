import { useSearchParams } from 'react-router-dom';
import { useT } from '../i18n';

export default function AuthError() {
  const [params] = useSearchParams();
  const t = useT();
  const reason = params.get('reason');

  const notInvited = reason === 'not_invited';

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg)', padding: 24,
    }}>
      <div style={{
        width: '100%', maxWidth: 420,
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)', padding: 40,
        textAlign: 'center',
      }}>
        <img src={`${import.meta.env.BASE_URL}didi-logo.png`} alt="DiDi" style={{ width: 48, height: 48, objectFit: 'contain', borderRadius: 10, margin: '0 auto 20px', display: 'block' }} />

        <h2 style={{ marginBottom: 10 }}>
          {notInvited ? t('pages.authError.notGrantedTitle') : t('pages.authError.failedTitle')}
        </h2>

        <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', lineHeight: 1.6, marginBottom: 28 }}>
          {notInvited
            ? <>{t('pages.authError.notGrantedBody').replace('@didi-labs.com account', '')}<strong>@didi-labs.com</strong>{' account doesn\'t have access to this panel yet. Ask an admin to send you an invitation link.'}</>
            : t('pages.authError.failedBody')}
        </p>

        <a
          href={`${import.meta.env.BASE_URL}login`}
          className="btn btn-primary"
          style={{ display: 'inline-block', textDecoration: 'none' }}
        >
          {t('pages.authError.backToSignIn')}
        </a>
      </div>
    </div>
  );
}
