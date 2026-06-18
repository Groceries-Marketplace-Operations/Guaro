import { useSearchParams } from 'react-router-dom';

export default function AuthError() {
  const [params] = useSearchParams();
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
        <div style={{
          width: 48, height: 48, borderRadius: '50%',
          background: 'var(--red-bg)', display: 'flex', alignItems: 'center',
          justifyContent: 'center', margin: '0 auto 20px',
          fontSize: '1.4rem',
        }}>
          🔒
        </div>

        <h2 style={{ marginBottom: 10 }}>
          {notInvited ? 'Access not granted' : 'Authentication failed'}
        </h2>

        <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', lineHeight: 1.6, marginBottom: 28 }}>
          {notInvited
            ? <>
                Your <strong>@didi-labs.com</strong> account doesn't have access to this panel yet.
                Ask an admin to send you an invitation link.
              </>
            : 'Something went wrong during sign-in. Please try again.'}
        </p>

        <a
          href={`${import.meta.env.BASE_URL}login`}
          className="btn btn-primary"
          style={{ display: 'inline-block', textDecoration: 'none' }}
        >
          Back to sign in
        </a>
      </div>
    </div>
  );
}
