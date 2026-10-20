import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  const zh = lang === 'zh-CN';
  const localized = useCallback(
    (english: string, spanish: string, chinese: string) => zh ? chinese : es ? spanish : english,
    [es, zh],
  );
  const [collapsed, setCollapsed] = useState(false);
  const [question, setQuestion] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [asking, setAsking] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: context, isLoading, error } = useQuery<AssistantContext>({
    queryKey: ['validation-assistant', taskTypeId],
    queryFn: () => tasksApi.assistantContext(taskTypeId).then(response => response.data),
  });
  const mascotState = isLoading || asking
    ? 'is-working'
    : latestValidation
      ? latestValidation.canProceed ? 'is-success' : 'is-error'
      : 'is-idle';

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
        label: localized('Access permission', 'Permiso de acceso', '访问权限'),
        detail: context?.accessMessage ?? localized('Checking access…', 'Comprobando acceso…', '正在检查访问权限…'),
      },
      {
        status: requiredReady ? 'passed' as const : 'warning' as const,
        label: localized('Required fields', 'Campos requeridos', '必填字段'),
        detail: requiredReady
          ? localized('Complete', 'Completos', '已完成')
          : localized(`Missing: ${readiness.missingRequired.join(', ')}`, `Faltan: ${readiness.missingRequired.join(', ')}`, `缺少：${readiness.missingRequired.join(', ')}`),
      },
      {
        status: readiness.hasUrlErrors ? 'failed' as const : 'passed' as const,
        label: localized('Links', 'Enlaces', '链接'),
        detail: readiness.hasUrlErrors
          ? localized('An invalid URL needs attention', 'Hay una URL inválida', '存在需要处理的无效网址')
          : localized('Format is valid', 'Formato correcto', '格式有效'),
      },
      ...(readiness.fileFields > 0 ? [{
        status: fileReady ? 'passed' as const : 'warning' as const,
        label: localized('Excel file', 'Archivo Excel', 'Excel 文件'),
        detail: fileReady
          ? localized('Validated by the server', 'Validado por el servidor', '服务器已验证')
          : localized('Waiting for validation', 'Pendiente de validar', '等待验证'),
      }] : []),
    ];
  }, [context, readiness, localized]);

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
        text: message ?? localized('I could not answer just now. Form validation is still active.', 'No pude responder ahora. Las validaciones del formulario siguen activas.', '暂时无法回答。表单验证仍然有效。'),
      }]);
    } finally {
      setAsking(false);
    }
  };

  return (
    <aside className={`validation-assistant ${collapsed ? 'is-collapsed' : ''}`} aria-label={localized('Naranja validation assistant', 'Asistente de validación Naranja', 'Naranja 验证助手')}>
      <header className="validation-assistant-header">
        <div className={`validation-assistant-avatar ${mascotState}`} aria-hidden="true">
          <span className="validation-assistant-ring" />
          <img src={`${import.meta.env.BASE_URL}mascot/naranja-robot-v2.png`} alt="" />
        </div>
        <div className="validation-assistant-heading">
          <strong>Naranja</strong>
          <span>{localized('Validation assistant', 'Asistente de validación', '验证助手')}</span>
        </div>
        <button type="button" className="assistant-collapse" onClick={() => setCollapsed(value => !value)} aria-expanded={!collapsed}>
          {collapsed ? '+' : '−'}
        </button>
      </header>

      {!collapsed && (
        <>
          <section className="assistant-readiness" aria-label={localized('System validations', 'Validaciones del sistema', '系统验证')}>
            <div className="assistant-section-label">{localized('System checks', 'Validaciones del sistema', '系统检查')}</div>
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
                {localized('I could not confirm access to this task.', 'No pude confirmar tu acceso a esta tarea.', '无法确认你对此任务的访问权限。')}
              </div>
            )}
            {context && (
              <>
                <div className="assistant-message assistant-message-bot">
                  <p>{localized(
                    `Hi, I’m Naranja. I’ll validate “${context.taskTypeName}” with you before it is created. Ask me about the template, columns, permissions, or errors.`,
                    `Hola, soy Naranja. Validaré “${context.taskTypeName}” contigo antes de crearla. Puedes preguntarme por la plantilla, columnas, permisos o errores.`,
                    `你好，我是 Naranja。在创建“${context.taskTypeName}”之前，我会与你一起完成验证。你可以询问模板、列、权限或错误。`,
                  )}
                  </p>
                </div>
                {context.formatExamples.map(example => (
                  <div className="assistant-message assistant-message-bot assistant-format-example" key={example.title}>
                    <strong>{localized('Example and valid configurations', 'Ejemplo y configuraciones válidas', '示例和有效配置')}</strong>
                    <span className="assistant-example-title">{zh ? example.titleZh ?? example.title : example.title}</span>
                    <div className="assistant-example-table-wrap">
                      <table>
                        <thead><tr>{example.headers.map(header => <th key={header}>{header}</th>)}</tr></thead>
                        <tbody>{example.rows.map((row, rowIndex) => <tr key={example.rowLabels[rowIndex] ?? rowIndex}>
                          {row.map((value, columnIndex) => <td key={`${rowIndex}-${columnIndex}`}>{value}</td>)}
                        </tr>)}</tbody>
                      </table>
                    </div>
                    <ul>{example.notes.map(note => <li key={note.en}>{zh ? note.zh ?? note.en : es ? note.es : note.en}</li>)}</ul>
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
                  ? localized(
                    `Ready. ${latestValidation.stats.validRows} row(s) passed validation and the file is prepared.`,
                    `Listo. ${latestValidation.stats.validRows} fila(s) pasaron la validación y el archivo quedó preparado.`,
                    `完成。${latestValidation.stats.validRows} 行已通过验证，文件已准备就绪。`,
                  )
                  : localized('I found issues in the file. Here is exactly what needs to be corrected.', 'Encontré problemas en el archivo. Te muestro exactamente qué debes corregir.', '文件中存在问题。以下是需要修正的具体内容。')}
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
              placeholder={localized('Ask about the format…', 'Pregunta sobre el formato…', '询问格式…')}
              aria-label={localized('Talk to Naranja', 'Hablar con Naranja', '与 Naranja 对话')}
              maxLength={500}
            />
            <button type="submit" disabled={!question.trim() || asking} aria-label={localized('Send question', 'Enviar pregunta', '发送问题')}>↑</button>
          </form>
        </>
      )}
    </aside>
  );
}
