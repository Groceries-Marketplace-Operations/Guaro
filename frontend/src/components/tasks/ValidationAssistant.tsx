import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { tasksApi } from '../../api';
import { useLang } from '../../i18n';
import type { AssistantContext, FileValidationResult } from '../../types';

interface Readiness {
  missingRequired: string[];
  hasUrlErrors: boolean;
  fileFields: number;
  validFiles: number;
}

interface ChatMessage {
  id: string;
  role: 'assistant' | 'user';
  text: string;
  validation?: FileValidationResult;
}

interface Props {
  taskTypeId: string;
  readiness: Readiness;
  latestValidation: FileValidationResult | null;
}

function uid() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function CheckIcon({ status }: { status: 'passed' | 'warning' | 'failed' }) {
  if (status === 'passed') return <span className="assistant-check-icon is-passed">✓</span>;
  if (status === 'warning') return <span className="assistant-check-icon is-warning">!</span>;
  return <span className="assistant-check-icon is-failed">×</span>;
}

function ValidationDetails({ validation }: { validation: FileValidationResult }) {
  return (
    <div className="assistant-validation-results">
      {validation.checks.map(check => (
        <details key={check.id} open={check.status === 'failed'}>
          <summary><CheckIcon status={check.status} /><span>{check.label}</span></summary>
          <p>{check.message}</p>
          {(check.details?.length ?? 0) > 0 && (
            <ul>{check.details!.map((detail, index) => <li key={`${check.id}-${index}`}>{detail}</li>)}</ul>
          )}
        </details>
      ))}
    </div>
  );
}

export default function ValidationAssistant({ taskTypeId, readiness, latestValidation }: Props) {
  const { lang } = useLang();
  const es = lang === 'es';
  const [collapsed, setCollapsed] = useState(false);
  const [question, setQuestion] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [asking, setAsking] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: context, isLoading, error } = useQuery<AssistantContext>({
    queryKey: ['validation-assistant', taskTypeId],
    queryFn: () => tasksApi.assistantContext(taskTypeId).then(response => response.data),
  });

  useEffect(() => {
    const container = scrollRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [messages, asking, latestValidation]);

  const readinessItems = useMemo(() => {
    const requiredReady = readiness.missingRequired.length === 0;
    const fileReady = readiness.fileFields === 0 || readiness.validFiles === readiness.fileFields;
    return [
      {
        status: context ? 'passed' as const : 'warning' as const,
        label: es ? 'Permiso de acceso' : 'Access permission',
        detail: context?.accessMessage ?? (es ? 'Comprobando acceso…' : 'Checking access…'),
      },
      {
        status: requiredReady ? 'passed' as const : 'warning' as const,
        label: es ? 'Campos requeridos' : 'Required fields',
        detail: requiredReady
          ? (es ? 'Completos' : 'Complete')
          : (es ? `Faltan: ${readiness.missingRequired.join(', ')}` : `Missing: ${readiness.missingRequired.join(', ')}`),
      },
      {
        status: readiness.hasUrlErrors ? 'failed' as const : 'passed' as const,
        label: es ? 'Enlaces' : 'Links',
        detail: readiness.hasUrlErrors ? (es ? 'Hay una URL inválida' : 'An invalid URL needs attention') : (es ? 'Formato correcto' : 'Format is valid'),
      },
      ...(readiness.fileFields > 0 ? [{
        status: fileReady ? 'passed' as const : 'warning' as const,
        label: es ? 'Archivo Excel' : 'Excel file',
        detail: fileReady ? (es ? 'Validado por el servidor' : 'Validated by the server') : (es ? 'Pendiente de validar' : 'Waiting for validation'),
      }] : []),
    ];
  }, [context, readiness, es]);

  const sendQuestion = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = question.trim();
    if (!value || asking) return;
    setQuestion('');
    setMessages(current => [...current, { id: uid(), role: 'user', text: value }]);
    setAsking(true);
    try {
      const response = await tasksApi.assistantMessage(taskTypeId, value, lang);
      setMessages(current => [...current, { id: uid(), role: 'assistant', text: response.data.answer }]);
    } catch (requestError) {
      const message = (requestError as { response?: { data?: { message?: string } } }).response?.data?.message;
      setMessages(current => [...current, {
        id: uid(),
        role: 'assistant',
        text: message ?? (es ? 'No pude responder ahora. Las validaciones del formulario siguen activas.' : 'I could not answer just now. Form validation is still active.'),
      }]);
    } finally {
      setAsking(false);
    }
  };

  return (
    <aside className={`validation-assistant ${collapsed ? 'is-collapsed' : ''}`} aria-label={es ? 'Asistente de validación Naranja' : 'Naranja validation assistant'}>
      <header className="validation-assistant-header">
        <div className="validation-assistant-avatar" aria-hidden="true">
          <span className="validation-assistant-ring" />
          <span className="validation-assistant-face"><i /><i /></span>
        </div>
        <div className="validation-assistant-heading">
          <strong>Naranja</strong>
          <span>{es ? 'Asistente de validación' : 'Validation assistant'}</span>
        </div>
        <button type="button" className="assistant-collapse" onClick={() => setCollapsed(value => !value)} aria-expanded={!collapsed}>
          {collapsed ? '+' : '−'}
        </button>
      </header>

      {!collapsed && (
        <>
          <section className="assistant-readiness" aria-label={es ? 'Validaciones del sistema' : 'System validations'}>
            <div className="assistant-section-label">{es ? 'Validaciones del sistema' : 'System checks'}</div>
            {readinessItems.map(item => (
              <div className="assistant-readiness-item" key={item.label}>
                <CheckIcon status={item.status} />
                <div><strong>{item.label}</strong><span>{item.detail}</span></div>
              </div>
            ))}
          </section>

          <div className="assistant-conversation" ref={scrollRef} aria-live="polite">
            {isLoading && (
              <div className="assistant-message assistant-message-bot">
                <span className="assistant-typing"><i /><i /><i /></span>
              </div>
            )}
            {error && (
              <div className="assistant-message assistant-message-bot is-error">
                {es ? 'No pude confirmar tu acceso a esta tarea.' : 'I could not confirm access to this task.'}
              </div>
            )}
            {context && (
              <>
                <div className="assistant-message assistant-message-bot">
                  <p>{es
                    ? `Hola, soy Naranja. Validaré “${context.taskTypeName}” contigo antes de crearla. Puedes preguntarme por la plantilla, columnas, permisos o errores.`
                    : `Hi, I’m Naranja. I’ll validate “${context.taskTypeName}” with you before it is created. Ask me about the template, columns, permissions, or errors.`}
                  </p>
                </div>
                {context.formatExamples.map(example => (
                  <div className="assistant-message assistant-message-bot assistant-format-example" key={example.title}>
                    <strong>{es ? 'Ejemplo real del formato' : 'Real format example'}</strong>
                    <div className="assistant-example-table-wrap">
                      <table>
                        <thead><tr>{example.headers.map(header => <th key={header}>{header}</th>)}</tr></thead>
                        <tbody>{example.rows.map((row, rowIndex) => <tr key={example.rowLabels[rowIndex] ?? rowIndex}>
                          {row.map((value, columnIndex) => <td key={`${rowIndex}-${columnIndex}`}>{value}</td>)}
                        </tr>)}</tbody>
                      </table>
                    </div>
                    <ul>{example.notes.map(note => <li key={note.en}>{es ? note.es : note.en}</li>)}</ul>
                  </div>
                ))}
              </>
            )}
            {messages.map(message => (
              <div key={message.id} className={`assistant-message ${message.role === 'user' ? 'assistant-message-user' : 'assistant-message-bot'}`}>
                <p>{message.text}</p>
                {message.validation && <ValidationDetails validation={message.validation} />}
              </div>
            ))}
            {latestValidation && (
              <div className="assistant-message assistant-message-bot">
                <p>{latestValidation.canProceed
                  ? (es ? `Listo. ${latestValidation.stats.validRows} fila(s) pasaron la validación y el archivo quedó preparado.` : `Ready. ${latestValidation.stats.validRows} row(s) passed validation and the file is prepared.`)
                  : (es ? 'Encontré problemas en el archivo. Te muestro exactamente qué debes corregir.' : 'I found issues in the file. Here is exactly what needs to be corrected.')}
                </p>
                <ValidationDetails validation={latestValidation} />
              </div>
            )}
            {asking && (
              <div className="assistant-message assistant-message-bot">
                <span className="assistant-typing"><i /><i /><i /></span>
              </div>
            )}
          </div>

          <form className="assistant-input-row" onSubmit={sendQuestion}>
            <input
              value={question}
              onChange={event => setQuestion(event.target.value)}
              placeholder={es ? 'Pregunta sobre el formato…' : 'Ask about the format…'}
              aria-label={es ? 'Hablar con Naranja' : 'Talk to Naranja'}
              maxLength={500}
            />
            <button type="submit" disabled={!question.trim() || asking} aria-label={es ? 'Enviar pregunta' : 'Send question'}>↑</button>
          </form>
        </>
      )}
    </aside>
  );
}
