export type MascotState = 'idle' | 'working' | 'success' | 'error';
export type MascotOperation = 'create' | 'save' | 'delete' | 'upload' | 'run' | 'stop' | 'restore' | 'answer';
export type MascotSubject = 'change' | 'task' | 'brand' | 'shop' | 'application' | 'integration' | 'section' | 'user' | 'configuration';

export interface MascotEventDetail {
  state: MascotState;
  operation: MascotOperation;
  subject: MascotSubject;
}

export const MASCOT_EVENT = 'tequila:naranja-action';

export function emitMascotEvent(detail: MascotEventDetail) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<MascotEventDetail>(MASCOT_EVENT, { detail }));
}

export function mutationDescription(method = '', rawUrl = ''): Pick<MascotEventDetail, 'operation' | 'subject'> {
  const url = rawUrl.toLowerCase();
  let subject: MascotSubject = 'change';
  if (url.includes('/tasks')) subject = 'task';
  else if (url.includes('/brands')) subject = 'brand';
  else if (url.includes('/shops')) subject = 'shop';
  else if (url.includes('/applications')) subject = 'application';
  else if (url.includes('/integrations')) subject = 'integration';
  else if (url.includes('/sections')) subject = 'section';
  else if (url.includes('/accounts') || url.includes('/bpo')) subject = 'user';
  else if (url.includes('/settings') || url.includes('/config')) subject = 'configuration';

  if (url.includes('/message')) return { operation: 'answer', subject };
  if (url.includes('upload')) return { operation: 'upload', subject };
  if (/\/(?:run|execute|trigger|retry|sync|fetch)(?:\/|\?|$)/.test(url)) return { operation: 'run', subject };
  if (/\/(?:stop|cancel|pause)(?:\/|\?|$)/.test(url)) return { operation: 'stop', subject };
  if (/\/restore(?:\?|$)/.test(url)) return { operation: 'restore', subject };
  if (method.toUpperCase() === 'DELETE') return { operation: 'delete', subject };
  if (method.toUpperCase() === 'POST') return { operation: 'create', subject };
  return { operation: 'save', subject };
}
