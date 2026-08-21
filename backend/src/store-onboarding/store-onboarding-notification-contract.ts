export const STORE_ONBOARDING_NOTIFICATION_EVENT_TYPES = [
  'process.changed',
  'request.enrolled',
  'request.blocked',
  'request.completed',
  'brand.ready',
  'brand.blocked',
  'stores.created',
  'configuration.brief_published',
  'configuration.started',
  'configuration.completed',
  'audit.submitted',
  'audit.needs_information',
  'audit.rejected',
  'audit.approved',
  'rtbo.completed',
  'go_live.started',
  'store.online',
  'store.online_failed',
] as const;

export type StoreOnboardingNotificationEventType =
  typeof STORE_ONBOARDING_NOTIFICATION_EVENT_TYPES[number];

export const STORE_ONBOARDING_DEFAULT_TEMPLATE_EVENT = '*';

// The renderer only resolves this allow-list. Profiles remain inert until the
// master switch, notifications switch and the profile revision are all
// explicitly enabled.
export const STORE_ONBOARDING_NOTIFICATION_TEMPLATE_VARIABLES = [
  'event.type',
  'event.occurredAt',
  'event.actorName',
  'event.note',
  'request.id',
  'request.status',
  'request.stage',
  'request.url',
  'task.id',
  'task.name',
  'task.url',
  'brand.id',
  'brand.name',
  'brand.country',
  'brand.kaType',
  'stores.total',
  'stores.completed',
  'stores.failed',
  'store.shopId',
  'store.appShopId',
  'store.status',
  'audit.status',
  'rtbo.status',
  'rollout.country',
  'rollout.kaType',
  'rollout.workflowVersion',
] as const;

const eventTypeSet = new Set<string>([
  STORE_ONBOARDING_DEFAULT_TEMPLATE_EVENT,
  ...STORE_ONBOARDING_NOTIFICATION_EVENT_TYPES,
]);
const variableSet = new Set<string>(STORE_ONBOARDING_NOTIFICATION_TEMPLATE_VARIABLES);
const placeholderPattern = /{{\s*([^{}]+?)\s*}}/g;

export interface NotificationTemplateInput {
  eventType: string;
  content: string;
}

export function notificationTemplateValidationErrors(
  templates: NotificationTemplateInput[],
): string[] {
  const errors: string[] = [];
  const seenEvents = new Set<string>();

  for (const [index, template] of templates.entries()) {
    const prefix = `templates[${index}]`;
    if (!eventTypeSet.has(template.eventType)) {
      errors.push(`${prefix}.eventType is not supported`);
    }
    if (seenEvents.has(template.eventType)) {
      errors.push(`${prefix}.eventType is duplicated`);
    }
    seenEvents.add(template.eventType);

    if (!template.content.trim()) {
      errors.push(`${prefix}.content cannot be empty`);
      continue;
    }

    const placeholders = [...template.content.matchAll(placeholderPattern)];
    const withoutPlaceholders = template.content.replace(placeholderPattern, '');
    if (withoutPlaceholders.includes('{{') || withoutPlaceholders.includes('}}')) {
      errors.push(`${prefix}.content contains a malformed placeholder`);
    }

    for (const match of placeholders) {
      const variable = match[1].trim();
      if (!/^[a-z][a-z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/.test(variable)) {
        errors.push(`${prefix}.content contains an invalid placeholder: ${variable}`);
      } else if (!variableSet.has(variable)) {
        errors.push(`${prefix}.content contains an unknown placeholder: ${variable}`);
      }
    }
  }

  return errors;
}
