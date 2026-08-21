import Modal from '../../components/ui/Modal';
import StoreOnboardingNotificationSettings from './StoreOnboardingNotificationSettings';
import StoreOnboardingRolloutSettings from './StoreOnboardingRolloutSettings';
import { StoreOnboardingMasterControlPanel } from './StoreOnboardingMasterControl';

type Props = { onClose: () => void };

export default function StoreOnboardingSettingsModal({ onClose }: Props) {
  return <Modal
    title="Configuración de Store Onboarding"
    onClose={onClose}
    footer={<button className="btn btn-ghost" onClick={onClose}>Cerrar</button>}
  >
    <div className="onboarding-settings-content">
      <div className="onboarding-settings-intro">
        <strong>Flujo operacional versionado</strong>
        <p>
          KA: la persona asignada a la ficha publica la configuración, OP Support configura y
          valida, Comercial gestiona Auditoría; un rechazo vuelve a configuración, la misma persona
          asignada confirma RTBO y Owner OP hace Go-Live.
          CKA/SME: Comercial prepara, envía y registra Auditoría; información faltante bloquea y
          Comercial corrige los rechazos, luego OP Support / Owner OP confirma RTBO y Owner OP
          ejecuta Go-Live.
        </p>
      </div>
      <div className="onboarding-safety-banner" role="status">
        <strong>Prepara y publica primero; el control maestro es el último paso.</strong>
        <span>
          Con Global OFF puedes publicar un perfil y un rollout compatibles para completar el
          preflight, sin inscribir Tasks ni enviar avisos. Sólo al final, si el backend confirma
          readiness, el administrador puede habilitar el control maestro con otra confirmación.
        </span>
      </div>
      <StoreOnboardingNotificationSettings />
      <StoreOnboardingRolloutSettings />
      <StoreOnboardingMasterControlPanel />
    </div>
  </Modal>;
}
