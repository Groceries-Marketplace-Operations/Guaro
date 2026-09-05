import {
  isLocalProductionMode,
  localProductionSessionExpiresAt,
} from '../../auth/local-production';

type Props = {
  email?: string;
};

export default function LocalProductionBanner({ email }: Props) {
  if (!isLocalProductionMode) return null;

  const expiration = new Date(localProductionSessionExpiresAt);
  const expirationLabel = Number.isNaN(expiration.getTime())
    ? 'expiración próxima'
    : `expira ${expiration.toLocaleString()}`;

  return (
    <aside className="local-production-banner" role="status" aria-live="polite">
      <strong>PRODUCCIÓN</strong>
      <span>Sesión temporal por SSH</span>
      {email && <code>{email}</code>}
      <time dateTime={localProductionSessionExpiresAt}>{expirationLabel}</time>
      <span>Al cerrar sesión se detiene el proxy y se solicita la revocación.</span>
    </aside>
  );
}
