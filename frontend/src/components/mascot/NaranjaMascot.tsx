import { useEffect, useMemo, useRef, useState } from 'react';
import { useLang } from '../../i18n';
import type { Lang } from '../../i18n';
import { MASCOT_EVENT } from './mascot-events';
import type { MascotEventDetail, MascotSubject } from './mascot-events';

const initialEvent: MascotEventDetail = { state: 'idle', operation: 'save', subject: 'change' };
const MASCOT_MINIMIZED_STORAGE_KEY = 'guaro.ui.naranja.minimized.v1';

function readMinimizedPreference() {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(MASCOT_MINIMIZED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function storeMinimizedPreference(minimized: boolean) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(MASCOT_MINIMIZED_STORAGE_KEY, String(minimized));
  } catch {
    // The control remains reversible for this session when storage is blocked.
  }
}

function message(detail: MascotEventDetail, lang: Lang) {
  const { state, operation, subject } = detail;
  const languageIndex = lang === 'es' ? 0 : lang === 'zh-CN' ? 2 : 1;
  const chinese = lang === 'zh-CN';
  const nouns: Record<MascotSubject, [string, string, string]> = {
    change: ['el cambio', 'the change', '更改'],
    task: ['la tarea', 'the task', '任务'],
    brand: ['la marca', 'the brand', '品牌'],
    shop: ['la tienda', 'the store', '门店'],
    application: ['la aplicación', 'the application', '应用'],
    integration: ['la integración', 'the integration', '集成'],
    section: ['la sección', 'the section', '版块'],
    user: ['el usuario', 'the user', '用户'],
    configuration: ['la configuración', 'the configuration', '配置'],
  };
  const target = nouns[subject][languageIndex];
  const spanish = lang === 'es';
  const verb = {
    create: chinese ? ['正在创建', '已创建'] : spanish ? ['Creando', 'Creé'] : ['Creating', 'Created'],
    save: chinese ? ['正在保存', '已保存'] : spanish ? ['Guardando', 'Guardé'] : ['Saving', 'Saved'],
    delete: chinese ? ['正在删除', '已删除'] : spanish ? ['Eliminando', 'Eliminé'] : ['Deleting', 'Deleted'],
    upload: chinese ? ['正在验证并上传', '已验证并上传'] : spanish ? ['Validando y subiendo', 'Validé y subí'] : ['Validating and uploading', 'Validated and uploaded'],
    run: chinese ? ['正在启动', '已启动'] : spanish ? ['Iniciando', 'Inicié'] : ['Starting', 'Started'],
    stop: chinese ? ['正在停止', '已停止'] : spanish ? ['Deteniendo', 'Detuve'] : ['Stopping', 'Stopped'],
    restore: chinese ? ['正在恢复', '已恢复'] : spanish ? ['Restaurando', 'Restauré'] : ['Restoring', 'Restored'],
    answer: chinese ? ['正在思考', '已准备'] : spanish ? ['Pensando', 'Preparé'] : ['Thinking', 'Prepared'],
  }[operation];
  const separator = chinese ? '' : ' ';
  if (state === 'idle') return chinese ? '随时可以帮助你。' : spanish ? 'Lista para ayudarte.' : 'Ready to help.';
  if (state === 'working') return `${verb[0]}${separator}${target}…`;
  if (state === 'success') return chinese ? `完成！${verb[1]}${target}。` : spanish ? `¡Listo! ${verb[1]} ${target}.` : `Done! ${verb[1]} ${target}.`;
  return chinese ? `无法完成${target}。请查看显示的详细信息。` : spanish ? `No pude completar ${target}. Revisa el detalle mostrado.` : `I could not complete ${target}. Check the displayed details.`;
}

export default function NaranjaMascot() {
  const { lang } = useLang();
  const [event, setEvent] = useState(initialEvent);
  const [expanded, setExpanded] = useState(false);
  const [minimized, setMinimized] = useState(readMinimizedPreference);
  const sequence = useRef(0);
  const minimizedRef = useRef(minimized);
  const spanish = lang === 'es';

  useEffect(() => {
    const onAction = (rawEvent: Event) => {
      const detail = (rawEvent as CustomEvent<MascotEventDetail>).detail;
      if (!detail) return;
      sequence.current += 1;
      const current = sequence.current;
      setEvent(detail);
      if (!minimizedRef.current) setExpanded(true);
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

  const chinese = lang === 'zh-CN';
  const copy = useMemo(() => message(event, lang), [event, lang]);
  const hideLabel = chinese ? '隐藏 Naranja' : spanish ? 'Ocultar Naranja' : 'Hide Naranja';
  const showLabel = chinese ? '显示 Naranja' : spanish ? 'Mostrar Naranja' : 'Show Naranja';

  const hideMascot = () => {
    minimizedRef.current = true;
    setMinimized(true);
    setExpanded(false);
    storeMinimizedPreference(true);
  };

  const showMascot = () => {
    minimizedRef.current = false;
    setMinimized(false);
    storeMinimizedPreference(false);
  };

  return (
    <aside
      className={`naranja-mascot is-${event.state} ${expanded ? 'is-expanded' : ''}${minimized ? ' is-minimized' : ''}`}
      aria-live="polite"
      aria-label={chinese ? 'Naranja，系统助手' : spanish ? 'Naranja, asistente del sistema' : 'Naranja, system assistant'}
    >
      {minimized ? (
        <button
          type="button"
          className="naranja-restore"
          onClick={showMascot}
          aria-label={`${showLabel}. ${copy}`}
          title={showLabel}
        >
          <img src={`${import.meta.env.BASE_URL}mascot/naranja-robot-v2.png`} alt="" aria-hidden="true" />
          <span className="naranja-status" aria-hidden="true" />
        </button>
      ) : (
        <>
          {expanded && (
            <div className="naranja-speech">
              <strong>Naranja</strong>
              <span>{copy}</span>
              {event.state === 'working' && <i className="naranja-dots"><b /><b /><b /></i>}
            </div>
          )}
          <button
            type="button"
            className="naranja-hide"
            onClick={hideMascot}
            aria-label={hideLabel}
            title={hideLabel}
          >
            <span aria-hidden="true">−</span>
          </button>
          <button type="button" className="naranja-character" onClick={() => setExpanded(value => !value)} aria-expanded={expanded} title={chinese ? '打开 Naranja' : spanish ? 'Abrir Naranja' : 'Open Naranja'}>
            <span className="naranja-aura" aria-hidden="true" />
            <img
              src={`${import.meta.env.BASE_URL}mascot/naranja-robot-v2.png`}
              alt={chinese ? 'Naranja 助手吉祥物' : spanish ? 'Naranja, mascota asistente' : 'Naranja, assistant mascot'}
            />
            <span className="naranja-thruster" aria-hidden="true"><i /><i /><i /></span>
            <span className="naranja-status" />
            {event.state === 'success' && <span className="naranja-confetti" aria-hidden="true"><i /><i /><i /><i /><i /></span>}
          </button>
        </>
      )}
    </aside>
  );
}
