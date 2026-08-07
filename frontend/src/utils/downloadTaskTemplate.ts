import { tasksApi } from '../api';
import type { TaskTypeTemplate } from '../types';

export async function downloadTaskTemplate(template: TaskTypeTemplate) {
  if (/^https?:\/\//i.test(template.url) && !template.url.includes('/api/')) {
    window.open(template.url, '_blank', 'noopener,noreferrer');
    return;
  }

  const response = await tasksApi.downloadTemplate(template.url);
  const disposition = String(response.headers['content-disposition'] ?? '');
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const plain = /filename="?([^";]+)"?/i.exec(disposition)?.[1];
  const extension = template.tipo === 'excel' ? '.xlsx' : '';
  const fallback = `${template.name.trim().replace(/[^a-z0-9_-]+/gi, '-') || 'template'}${extension}`;
  const filename = encoded ? decodeURIComponent(encoded) : (plain || fallback);
  const objectUrl = URL.createObjectURL(response.data);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}
