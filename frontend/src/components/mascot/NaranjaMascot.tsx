import { useEffect, useMemo, useRef, useState } from 'react';
import { useLang } from '../../i18n';
import { MASCOT_EVENT } from './mascot-events';
import type { MascotEventDetail, MascotSubject } from './mascot-events';

const initialEvent: MascotEventDetail = { state: 'idle', operation: 'save', subject: 'change' };

function message(detail: MascotEventDetail, spanish: boolean) {
  const { state, operation, subject } = detail;
  const nouns: Record<MascotSubject, [string, string]> = {
    change: ['el cambio', 'the change'],
    task: ['la tarea', 'the task'],
    brand: ['la marca', 'the brand'],
    shop: ['la tienda', 'the store'],
    application: ['la aplicación', 'the application'],
    integration: ['la integración', 'the integration'],
    section: ['la sección', 'the section'],
    user: ['el usuario', 'the user'],
    configuration: ['la configuración', 'the configuration'],
  };
  const target = nouns[subject][spanish ? 0 : 1];
  const verb = {
    create: spanish ? ['Creando', 'Creé'] : ['Creating', 'Created'],
    save: spanish ? ['Guardando', 'Guardé'] : ['Saving', 'Saved'],
    delete: spanish ? ['Eliminando', 'Eliminé'] : ['Deleting', 'Deleted'],
    upload: spanish ? ['Validando y subiendo', 'Validé y subí'] : ['Validating and uploading', 'Validated and uploaded'],
    run: spanish ? ['Iniciando', 'Inicié'] : ['Starting', 'Started'],
    stop: spanish ? ['Deteniendo', 'Detuve'] : ['Stopping', 'Stopped'],
    restore: spanish ? ['Restaurando', 'Restauré'] : ['Restoring', 'Restored'],
    answer: spanish ? ['Pensando', 'Preparé'] : ['Thinking', 'Prepared'],
  }[operation];
  if (state === 'idle') return spanish ? 'Lista para ayudarte.' : 'Ready to help.';
  if (state === 'working') return `${verb[0]} ${target}…`;
  if (state === 'success') return spanish ? `¡Listo! ${verb[1]} ${target}.` : `Done! ${verb[1]} ${target}.`;
  return spanish ? `No pude completar ${target}. Revisa el detalle mostrado.` : `I could not complete ${target}. Check the displayed details.`;
}

export default function NaranjaMascot() {
  const { lang } = useLang();
  const [event, setEvent] = useState(initialEvent);
  const [expanded, setExpanded] = useState(false);
  const sequence = useRef(0);
  const spanish = lang === 'es';

  useEffect(() => {
    const onAction = (rawEvent: Event) => {
      const detail = (rawEvent as CustomEvent<MascotEventDetail>).detail;
      if (!detail) return;
      sequence.current += 1;
      const current = sequence.current;
      setEvent(detail);
      setExpanded(true);
      if (detail.state !== 'working') {
        window.setTimeout(() => {
          if (sequence.current !== current) return;
          setExpanded(false);
          setEvent(initialEvent);
        }, detail.state === 'error' ? 6500 : 4200);
      }
    };
    window.addEventListener(MASCOT_EVENT, onAction);
    return () => window.removeEventListener(MASCOT_EVENT, onAction);
  }, []);

  const copy = useMemo(() => message(event, spanish), [event, spanish]);

  return (
    <aside className={`naranja-mascot is-${event.state} ${expanded ? 'is-expanded' : ''}`} aria-live="polite" aria-label="Naranja, asistente del sistema">
      {expanded && (
        <div className="naranja-speech">
          <strong>Naranja</strong>
          <span>{copy}</span>
          {event.state === 'working' && <i className="naranja-dots"><b /><b /><b /></i>}
        </div>
      )}
      <button type="button" className="naranja-character" onClick={() => setExpanded(value => !value)} aria-expanded={expanded} title={spanish ? 'Abrir Naranja' : 'Open Naranja'}>
        <span className="naranja-aura" aria-hidden="true" />
        <img src={`${import.meta.env.BASE_URL}mascot/naranja-robot-v2.png`} alt="Naranja, mascota asistente" />
        <span className="naranja-thruster" aria-hidden="true"><i /><i /><i /></span>
        <span className="naranja-status" />
        {event.state === 'success' && <span className="naranja-confetti" aria-hidden="true"><i /><i /><i /><i /><i /></span>}
      </button>
    </aside>
  );
}
