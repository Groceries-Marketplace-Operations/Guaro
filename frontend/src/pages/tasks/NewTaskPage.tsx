import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import Topbar from '../../components/layout/Topbar';
import ValidationAssistant from '../../components/tasks/ValidationAssistant';
import { taskTypesApi, brandsApi, shopsApi, tasksApi, appConfigApi } from '../../api';
import { useT } from '../../i18n';
import type { TaskType, FormField, Brand, Shop, FileValidationResult } from '../../types';
import { downloadTaskTemplate } from '../../utils/downloadTaskTemplate';

type ApiError = { response?: { data?: { message?: string | string[] } } };
function errMsg(ex: unknown) {
  const e = ex as ApiError;
  const msg = e.response?.data?.message;
  return Array.isArray(msg) ? msg.join(', ') : (msg ?? 'Unexpected error');
}

function isValidUrl(url: string): boolean {
  if (!url) return true;
  try { new URL(url); return true; } catch { return false; }
}

async function prepareStoreCover(file: File) {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    canvas.height = 900;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('El navegador no pudo preparar la portada.');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height);
    const width = bitmap.width * scale;
    const height = bitmap.height * scale;
    context.drawImage(bitmap, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    if (!blob) throw new Error('No se pudo generar la portada 1200 × 900.');
    const base = file.name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '-');
    return {
      file: new File([blob], `${base || 'store-cover'}-1200x900.jpg`, { type: 'image/jpeg' }),
      previewUrl: URL.createObjectURL(blob),
    };
  } finally {
    bitmap.close();
  }
}

function toLocalDatetimeInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const WINDOW_HOURS = 4;

function getSchedulingBounds() {
  const now = new Date();
  now.setSeconds(0, 0);
  const maxDate = new Date(now);
  maxDate.setMonth(maxDate.getMonth() + 1);
  return { min: toLocalDatetimeInput(now), max: toLocalDatetimeInput(maxDate) };
}

function addHours(datetimeLocal: string, hours: number): string {
  const d = new Date(datetimeLocal);
  d.setHours(d.getHours() + hours);
  return d.toISOString();
}

const ChevronDown = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" width="14" height="14">
    <polyline points="6 9 12 15 18 9"/>
  </svg>
);
const ChevronRight = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" width="14" height="14">
    <polyline points="9 6 15 12 9 18"/>
  </svg>
);
const XSmall = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="12" height="12">
    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
  </svg>
);

interface BrandComboboxProps {
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
}

function BrandCombobox({ value, onChange, placeholder = 'Search brand…' }: BrandComboboxProps) {
  const [query, setQuery]       = useState('');
  const [dQuery, setDQuery]     = useState('');
  const [open, setOpen]         = useState(false);
  const [label, setLabel]       = useState('');
  const containerRef            = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDQuery(query), 250);
    return () => clearTimeout(t);
  }, [query]);

  const { data: results = [] } = useQuery<Brand[]>({
    queryKey: ['brands-search', dQuery],
    queryFn: () => brandsApi.list({ q: dQuery, limit: 20 }).then(r => (r.data as { data: Brand[] }).data),
    enabled: open && dQuery.length >= 1,
  });

  const select = (b: Brand) => {
    onChange(b.id);
    setLabel(`${b.brandName} · ${b.country}`);
    setQuery('');
    setOpen(false);
  };

  const clear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange('');
    setLabel('');
    setQuery('');
  };

  const handleBlur = useCallback((e: React.FocusEvent) => {
    if (!containerRef.current?.contains(e.relatedTarget as Node)) { setOpen(false); setQuery(''); }
  }, []);

  const displayValue = open ? query : (label || '');

  return (
    <div ref={containerRef} style={{ position: 'relative' }} onBlur={handleBlur}>
      <div style={{ position: 'relative' }}>
        <input
          className="form-input"
          value={displayValue}
          placeholder={placeholder}
          onChange={e => { setQuery(e.target.value); setOpen(true); if (!e.target.value) onChange(''); }}
          onFocus={() => { setOpen(true); if (label) setQuery(''); }}
          style={{ paddingRight: value ? 32 : 12 }}
        />
        {value && (
          <button type="button" onMouseDown={clear} tabIndex={-1}
            style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 2 }}>
            <XSmall />
          </button>
        )}
      </div>
      {open && dQuery.length >= 1 && (
        <div style={{ position: 'absolute', zIndex: 200, top: 'calc(100% + 4px)', left: 0, right: 0, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.12)', maxHeight: 240, overflowY: 'auto' }}>
          {results.length === 0 ? (
            <div style={{ padding: '10px 14px', fontSize: '0.82rem', color: 'var(--text-muted)' }}>No results for "{dQuery}"</div>
          ) : (
            results.map(b => (
              <div key={b.id} onMouseDown={() => select(b)}
                style={{ padding: '9px 14px', cursor: 'pointer', fontSize: '0.84rem', background: value === b.id ? 'rgba(255,105,0,0.08)' : 'transparent', color: value === b.id ? 'var(--orange)' : 'var(--text-primary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                onMouseEnter={e => (e.currentTarget.style.background = value === b.id ? 'rgba(255,105,0,0.12)' : 'var(--surface-2)')}
                onMouseLeave={e => (e.currentTarget.style.background = value === b.id ? 'rgba(255,105,0,0.08)' : 'transparent')}>
                <span style={{ fontWeight: value === b.id ? 600 : 400 }}>{b.brandName}</span>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{b.brandId} · {b.country}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

type FileFieldValue = { name: string; tempPath: string; previewUrl?: string };
type FieldValue = string | string[] | FileFieldValue | Brand[];

interface MultiBrandComboboxProps {
  value: Brand[];
  onChange: (brands: Brand[]) => void;
}

function MultiBrandCombobox({ value, onChange }: MultiBrandComboboxProps) {
  const [query, setQuery]   = useState('');
  const [dQuery, setDQuery] = useState('');
  const [open, setOpen]     = useState(false);
  const containerRef        = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDQuery(query), 250);
    return () => clearTimeout(t);
  }, [query]);

  const { data: results = [] } = useQuery<Brand[]>({
    queryKey: ['brands-search-multi', dQuery],
    queryFn: () => brandsApi.list({ q: dQuery, limit: 20 }).then(r => (r.data as { data: Brand[] }).data),
    enabled: open && dQuery.length >= 1,
  });

  const selectedIds = new Set(value.map(b => b.id));

  const toggle = (b: Brand) => {
    if (selectedIds.has(b.id)) onChange(value.filter(x => x.id !== b.id));
    else onChange([...value, b]);
    setQuery('');
  };

  const remove = (id: string) => onChange(value.filter(b => b.id !== id));

  const handleBlur = useCallback((e: React.FocusEvent) => {
    if (!containerRef.current?.contains(e.relatedTarget as Node)) { setOpen(false); setQuery(''); }
  }, []);

  return (
    <div ref={containerRef} onBlur={handleBlur}>
      {value.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {value.map(b => (
            <span key={b.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'rgba(255,105,0,0.1)', color: 'var(--orange)', borderRadius: 6, padding: '3px 8px', fontSize: '0.8rem', fontWeight: 500 }}>
              {b.brandName} <span style={{ fontSize: '0.7rem', opacity: 0.7 }}>· {(b as Brand & { country?: string }).country}</span>
              <button type="button" onClick={() => remove(b.id)}
                style={{ marginLeft: 2, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--orange)', display: 'flex', padding: 0, lineHeight: 1 }}>
                <XSmall />
              </button>
            </span>
          ))}
        </div>
      )}
      <div style={{ position: 'relative' }}>
        <input
          className="form-input"
          value={query}
          placeholder="Search and add brands…"
          onChange={e => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
        />
        {open && dQuery.length >= 1 && (
          <div style={{ position: 'absolute', zIndex: 200, top: 'calc(100% + 4px)', left: 0, right: 0, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.12)', maxHeight: 240, overflowY: 'auto' }}>
            {results.length === 0 ? (
              <div style={{ padding: '10px 14px', fontSize: '0.82rem', color: 'var(--text-muted)' }}>No results for "{dQuery}"</div>
            ) : results.map(b => {
              const selected = selectedIds.has(b.id);
              return (
                <div key={b.id} onMouseDown={() => toggle(b)}
                  style={{ padding: '9px 14px', cursor: 'pointer', fontSize: '0.84rem', background: selected ? 'rgba(255,105,0,0.08)' : 'transparent', color: selected ? 'var(--orange)' : 'var(--text-primary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                  onMouseEnter={e => (e.currentTarget.style.background = selected ? 'rgba(255,105,0,0.12)' : 'var(--surface-2)')}
                  onMouseLeave={e => (e.currentTarget.style.background = selected ? 'rgba(255,105,0,0.08)' : 'transparent')}>
                  <span style={{ fontWeight: selected ? 600 : 400 }}>{b.brandName}</span>
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{b.brandId} · {(b as Brand & { country?: string }).country}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default function NewTaskPage() {
  const nav = useNavigate();
  const [searchParams] = useSearchParams();
  const t = useT();
  const { min: schedMin, max: schedMax } = useMemo(() => getSchedulingBounds(), []);

  const [selectedTTId, setSelectedTTId] = useState<string | null>(null);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const [scheduledStart, setScheduledStart] = useState('');
  const [formValues, setFormValues] = useState<Record<string, FieldValue>>({});
  const [urlErrors, setUrlErrors] = useState<Record<string, string>>({});
  const [fileUploading, setFileUploading] = useState<Record<string, boolean>>({});
  const [fileUploadErrors, setFileUploadErrors] = useState<Record<string, string>>({});
  const [latestFileValidation, setLatestFileValidation] = useState<FileValidationResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const { data: taskTypesResult } = useQuery<{ data: TaskType[] }>({
    queryKey: ['task-types', { page: 1, limit: 200 }],
    queryFn: () => taskTypesApi.list({ page: 1, limit: 200 }).then(r => r.data as { data: TaskType[] }),
  });
  const taskTypes: TaskType[] = useMemo(() => taskTypesResult?.data ?? [], [taskTypesResult?.data]);

  useEffect(() => {
    if (selectedTTId || taskTypes.length === 0) return;
    const requested = searchParams.get('taskType');
    if (!requested) return;
    const match = taskTypes.find(type => type.id === requested || type.name === requested);
    if (match) setSelectedTTId(match.id);
  }, [searchParams, selectedTTId, taskTypes]);

  const { data: selectedTT = null } = useQuery<TaskType>({
    queryKey: ['task-type', selectedTTId],
    queryFn: () => taskTypesApi.get(selectedTTId!).then(r => r.data as TaskType),
    enabled: !!selectedTTId,
  });

  const fields: FormField[] = useMemo(
    () => [...(selectedTT?.formFields ?? [])].sort((a, b) => a.order - b.order),
    [selectedTT],
  );

  const hasStoreField   = fields.some(f => f.tipo === 'select_store');
  const hasKaTypeField      = fields.some(f => f.tipo === 'select_ka_type');
  const hasCountryField     = fields.some(f => f.tipo === 'select_country');
  const hasBizCatField      = fields.some(f => f.tipo === 'select_biz_category');

  const selectedBrandIds: Record<string, string> = useMemo(() => {
    const result: Record<string, string> = {};
    for (const f of fields) {
      if (f.tipo === 'select_brand') {
        const v = formValues[f.id];
        if (typeof v === 'string' && v) result[f.id] = v;
      }
    }
    return result;
  }, [fields, formValues]);

  const anySelectedBrand = Object.values(selectedBrandIds)[0] ?? '';


  const { data: shops = [] } = useQuery<Shop[]>({
    queryKey: ['shops', 'for-task', anySelectedBrand],
    queryFn: () => shopsApi.list({ brandId: anySelectedBrand, limit: 500 }).then(r => (r.data as { data: Shop[] }).data),
    enabled: hasStoreField && !!anySelectedBrand,
  });

  const { data: appConfig = {} } = useQuery<Record<string, { value: string; label: string }[]>>({
    queryKey: ['app-config'],
    queryFn: () => appConfigApi.all().then(r => {
      const raw = r.data as Record<string, { value: string; label: string; active: boolean }[]>;
      return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v.filter(o => o.active)]));
    }),
    enabled: hasKaTypeField || hasCountryField || hasBizCatField,
  });

  const bySection = useMemo(() => {
    const map = new Map<string, { sectionId: string; sectionName: string; types: TaskType[] }>();
    for (const tt of taskTypes) {
      if (tt.active === false) continue;
      const key = tt.sectionId;
      if (!map.has(key)) map.set(key, { sectionId: key, sectionName: tt.section?.name ?? 'No section', types: [] });
      map.get(key)!.types.push(tt);
    }
    return [...map.values()];
  }, [taskTypes]);

  const pickTaskType = (tt: TaskType) => {
    setSelectedTTId(tt.id);
    setFormValues({});
    setUrlErrors({});
    setScheduledStart('');
    setLatestFileValidation(null);
    setErr('');
  };

  const setField = (fieldId: string, value: FieldValue) => {
    setFormValues(prev => ({ ...prev, [fieldId]: value }));
  };

  const toggleMultiOption = (fieldId: string, option: string) => {
    const current = (formValues[fieldId] as string[]) ?? [];
    const next = current.includes(option) ? current.filter(v => v !== option) : [...current, option];
    setField(fieldId, next);
  };

  const validateUrl = (fieldId: string, value: string) => {
    if (value && !isValidUrl(value)) {
      setUrlErrors(prev => ({ ...prev, [fieldId]: t('pages.newTask.urlError') }));
    } else {
      setUrlErrors(prev => { const next = { ...prev }; delete next[fieldId]; return next; });
    }
  };

  const toggleSection = (sectionId: string) => {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(sectionId)) next.delete(sectionId);
      else next.add(sectionId);
      return next;
    });
  };

  const submit = async () => {
    if (!selectedTT) return;
    let hasUrlError = false;
    for (const f of fields) {
      if (f.tipo === 'link' || f.tipo === 'link_spreadsheet') {
        const val = (formValues[f.id] as string) ?? '';
        if (!isValidUrl(val)) {
          setUrlErrors(prev => ({ ...prev, [f.id]: t('pages.newTask.urlError') }));
          hasUrlError = true;
        }
      }
    }
    if (hasUrlError) return;

    setErr(''); setSaving(true);
    try {
      const fvPayload: Array<Record<string, string>> = [];
      for (const f of fields) {
        const val = formValues[f.id];
        if (f.tipo === 'select_brand') {
          if (val) fvPayload.push({ formFieldId: f.id, brandId: val as string });
        } else if (f.tipo === 'multiple_brands') {
          for (const b of (val as Brand[]) ?? []) {
            fvPayload.push({ formFieldId: f.id, brandId: b.id });
          }
        } else if (f.tipo === 'select_store') {
          if (val) fvPayload.push({ formFieldId: f.id, shopId: val as string });
        } else if (f.tipo === 'file' || f.tipo === 'image') {
          const fv = val as FileFieldValue | undefined;
          if (fv?.tempPath) fvPayload.push({ formFieldId: f.id, value: fv.tempPath });
        } else if (f.multiple && Array.isArray(val)) {
          for (const v of val as string[]) {
            if (v) fvPayload.push({ formFieldId: f.id, value: v });
          }
        } else {
          if (val) fvPayload.push({ formFieldId: f.id, value: val as string });
        }
      }
      const payload: Record<string, unknown> = {
        taskTypeId: selectedTT.id,
        ...(fvPayload.length && { formValues: fvPayload }),
        ...(scheduledStart && {
          scheduledStart: new Date(scheduledStart).toISOString(),
          scheduledEnd:   addHours(scheduledStart, WINDOW_HOURS),
        }),
      };
      const res = await tasksApi.create(payload);
      const created = res.data as { id: string };
      nav(`/tasks/${created.id}`);
    } catch (ex) {
      setErr(errMsg(ex));
    } finally {
      setSaving(false);
    }
  };

  const handleFileUpload = async (fieldId: string, file: File, kind: 'file' | 'image' = 'file') => {
    setFileUploading(p => ({ ...p, [fieldId]: true }));
    setFileUploadErrors(p => { const n = { ...p }; delete n[fieldId]; return n; });
    try {
      const prepared = kind === 'image' ? await prepareStoreCover(file) : { file, previewUrl: undefined };
      const fd = new FormData();
      fd.append('file', prepared.file);
      fd.append('taskTypeId', selectedTTId ?? '');
      fd.append('formFieldId', fieldId);
      const res = kind === 'image' ? await tasksApi.uploadImage(fd) : await tasksApi.uploadExcel(fd);
      setLatestFileValidation(res.data);
      if (res.data.canProceed && res.data.tempPath) {
        setField(fieldId, { name: res.data.originalName, tempPath: res.data.tempPath, previewUrl: prepared.previewUrl } as FileFieldValue);
      } else {
        setField(fieldId, { name: '', tempPath: '' } as FileFieldValue);
        setFileUploadErrors(p => ({ ...p, [fieldId]: res.data.summary }));
      }
    } catch (ex) {
      const message = errMsg(ex);
      setLatestFileValidation({
        originalName: file.name,
        canProceed: false,
        summary: message,
        checks: [{ id: 'upload', label: 'Upload', status: 'failed', message }],
        stats: { validRows: 0, totalRows: 0 },
      });
      setFileUploadErrors(p => ({ ...p, [fieldId]: message || t('pages.newTask.fileUploadError') }));
    } finally {
      setFileUploading(p => ({ ...p, [fieldId]: false }));
    }
  };

  const renderField = (f: FormField) => {
    const val = formValues[f.id];
    const strVal = typeof val === 'string' ? val : '';

    const label = (
      <label className="form-label" style={{ marginBottom: 6 }}>
        {f.label}
        {f.required && <span style={{ color: 'var(--red)', marginLeft: 3 }}>*</span>}
      </label>
    );

    if (f.tipo === 'texto') return (
      <div className="form-group" key={f.id}>
        {label}
        <input className="form-input" value={strVal} onChange={e => setField(f.id, e.target.value)} />
      </div>
    );

    if (f.tipo === 'text_box') return (
      <div className="form-group" key={f.id}>
        {label}
        <textarea
          className="form-input"
          rows={5}
          style={{ resize: 'vertical', minHeight: 100 }}
          value={strVal}
          onChange={e => setField(f.id, e.target.value)}
        />
      </div>
    );

    if (f.tipo === 'numero') return (
      <div className="form-group" key={f.id}>
        {label}
        <input className="form-input" type="number" value={strVal} onChange={e => setField(f.id, e.target.value)} />
      </div>
    );

    if (f.tipo === 'link' || f.tipo === 'link_spreadsheet') return (
      <div className="form-group" key={f.id}>
        {label}
        <input
          className="form-input"
          type="text"
          placeholder="https://"
          value={strVal}
          onChange={e => { setField(f.id, e.target.value); if (urlErrors[f.id]) validateUrl(f.id, e.target.value); }}
          onBlur={e => validateUrl(f.id, e.target.value)}
          style={urlErrors[f.id] ? { borderColor: 'var(--red)' } : {}}
        />
        {urlErrors[f.id] && <p style={{ fontSize: '0.75rem', color: 'var(--red)', marginTop: 4 }}>{urlErrors[f.id]}</p>}
        {!urlErrors[f.id] && /^https?:\/\//i.test(strVal) && (
          <a href={strVal} target="_blank" rel="noopener noreferrer"
            style={{ display: 'inline-flex', marginTop: 6, color: 'var(--orange)', fontSize: '0.78rem', fontWeight: 600 }}>
            {strVal} ↗
          </a>
        )}
      </div>
    );

    if (f.tipo === 'select' && f.options) {
      if (f.multiple) {
        const selected = (val as string[]) ?? [];
        return (
          <div className="form-group" key={f.id}>
            {label}
            <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '6px 10px', display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 180, overflowY: 'auto' }}>
              {f.options.map(o => {
                const checked = selected.includes(o);
                return (
                  <label key={o} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '3px 0' }}>
                    <input type="checkbox" checked={checked} onChange={() => toggleMultiOption(f.id, o)}
                      style={{ accentColor: 'var(--orange)', width: 15, height: 15, flexShrink: 0 }} />
                    <span style={{ fontSize: '0.84rem' }}>{o}</span>
                  </label>
                );
              })}
            </div>
            {selected.length > 0 && (
              <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 4 }}>
                {t('pages.newTask.selectedCount').replace('{count}', String(selected.length)).replace('{list}', selected.join(', '))}
              </p>
            )}
          </div>
        );
      }
      return (
        <div className="form-group" key={f.id}>
          {label}
          <select className="form-select" value={strVal} onChange={e => setField(f.id, e.target.value)}>
            <option value="">{t('pages.newTask.selectOption')}</option>
            {f.options.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
      );
    }

    if (f.tipo === 'select_brand') return (
      <div className="form-group" key={f.id}>
        {label}
        <BrandCombobox
          value={strVal}
          onChange={id => setField(f.id, id)}
          placeholder={t('pages.newTask.noBrandsFound')}
        />
      </div>
    );

    if (f.tipo === 'multiple_brands') return (
      <div className="form-group" key={f.id}>
        {label}
        <MultiBrandCombobox
          value={(formValues[f.id] as Brand[]) ?? []}
          onChange={brands => setField(f.id, brands)}
        />
      </div>
    );

    if (f.tipo === 'select_ka_type') {
      const options = appConfig['ka_type'] ?? [];
      return (
        <div className="form-group" key={f.id}>
          {label}
          <select className="form-select" value={strVal} onChange={e => setField(f.id, e.target.value)}>
            <option value="">{t('pages.newTask.selectKaType')}</option>
            {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      );
    }

    if (f.tipo === 'select_country') {
      const options = appConfig['country'] ?? [];
      return (
        <div className="form-group" key={f.id}>
          {label}
          <select className="form-select" value={strVal} onChange={e => setField(f.id, e.target.value)}>
            <option value="">{t('pages.newTask.selectCountry')}</option>
            {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      );
    }

    if (f.tipo === 'select_biz_category') {
      const options = appConfig['biz_category'] ?? [];
      return (
        <div className="form-group" key={f.id}>
          {label}
          <select className="form-select" value={strVal} onChange={e => setField(f.id, e.target.value)}>
            <option value="">{t('pages.newTask.selectBizCategory')}</option>
            {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      );
    }

    if (f.tipo === 'select_store') {
      const filterBrandId = f.filteredById
        ? (selectedBrandIds[f.filteredById] ?? anySelectedBrand)
        : anySelectedBrand;
      const filteredShops = filterBrandId ? shops.filter(s => s.brandId === filterBrandId) : shops;
      return (
        <div className="form-group" key={f.id}>
          {label}
          {!filterBrandId && (
            <p className="form-hint" style={{ marginBottom: 6 }}>{t('pages.newTask.selectBrand')}</p>
          )}
          <select className="form-select" value={strVal} onChange={e => setField(f.id, e.target.value)} disabled={!filterBrandId}>
            <option value="">{t('pages.newTask.selectStore')}</option>
            {filteredShops.map(s => (
              <option key={s.id} value={s.id}>{s.shopId}{s.name ? ` · ${s.name}` : ''}</option>
            ))}
          </select>
        </div>
      );
    }

    if (f.tipo === 'file' || f.tipo === 'image') {
      const fileVal = val as FileFieldValue | undefined;
      const uploading = fileUploading[f.id] ?? false;
      const image = f.tipo === 'image';
      return (
        <div className="form-group" key={f.id}>
          {label}
          <p className="form-hint" style={{ marginBottom: 6 }}>
            {image ? 'JPG, JPEG o PNG. La imagen completa se ajusta a 1200 × 900 (4:3) sin recortarse; si la proporción es distinta, se agrega espacio blanco. Máximo 5 MB.' : t('pages.newTask.excelHint')}
          </p>
          <input
            type="file"
            accept={image ? '.jpg,.jpeg,.png,image/jpeg,image/png' : '.xlsx'}
            disabled={uploading}
            style={{ fontSize: '0.84rem' }}
            onChange={e => {
              const file = e.target.files?.[0];
              if (file) handleFileUpload(f.id, file, image ? 'image' : 'file');
              e.target.value = '';
            }}
          />
          {uploading && <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: 4 }}>{t('pages.newTask.uploading')}</p>}
          {fileVal?.name && !uploading && (
            <p style={{ fontSize: '0.78rem', color: 'var(--green)', marginTop: 4 }}>✓ {fileVal.name}</p>
          )}
          {image && fileVal?.previewUrl && !uploading && <div style={{ marginTop: 12, maxWidth: 520 }}>
            <div>
              <div style={{ position: 'relative', aspectRatio: '4 / 3', overflow: 'hidden', borderRadius: 10, background: '#eee' }}>
                <img src={fileVal.previewUrl} alt="Vista previa 1200 por 900" style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
              </div>
              <p className="form-hint" style={{ marginTop: 5 }}>Archivo final 1200 × 900 · imagen completa, sin recorte.</p>
            </div>
          </div>}
          {fileUploadErrors[f.id] && (
            <p style={{ fontSize: '0.78rem', color: 'var(--red)', marginTop: 4 }}>{fileUploadErrors[f.id]}</p>
          )}
        </div>
      );
    }

    return null;
  };

  const missingRequired = fields.filter(f => f.required).some(f => {
    const val = formValues[f.id];
    if (f.tipo === 'file' || f.tipo === 'image') return !(val as FileFieldValue | undefined)?.tempPath;
    if (f.multiple) return !Array.isArray(val) || val.length === 0;
    return !val;
  });

  const hasUrlErrors = Object.keys(urlErrors).length > 0;
  const canSubmit = !saving && !missingRequired && !hasUrlErrors;
  const missingRequiredLabels = fields.filter(f => {
    if (!f.required) return false;
    const val = formValues[f.id];
    if (f.tipo === 'file' || f.tipo === 'image') return !(val as FileFieldValue | undefined)?.tempPath;
    if (f.multiple) return !Array.isArray(val) || val.length === 0;
    return !val;
  }).map(f => f.label);
  const fileFields = fields.filter(f => f.tipo === 'file');
  const validFiles = fileFields.filter(f => !!(formValues[f.id] as FileFieldValue | undefined)?.tempPath).length;

  return (
    <>
      <Topbar breadcrumb={[{ label: t('nav.tasks'), href: '/tasks' }, { label: t('pages.newTask.breadcrumb') }]} />

      <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gridColumn: 2, minHeight: 'calc(100vh - var(--topbar-h))' }}>

        <div style={{ borderRight: '1px solid var(--border)', overflowY: 'auto', padding: '20px 0', background: 'var(--surface-2)' }}>
          <div style={{ padding: '0 16px 12px', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            {t('pages.newTask.taskTypesHeader')}
          </div>

          {taskTypes.length === 0 && (
            <p style={{ padding: '0 16px', fontSize: '0.82rem', color: 'var(--text-muted)' }}>{t('pages.newTask.noTaskTypes')}</p>
          )}

          {bySection.map(({ sectionId, sectionName, types }) => {
            const collapsed = collapsedSections.has(sectionId);
            return (
              <div key={sectionId} style={{ marginBottom: 4 }}>
                <button
                  onClick={() => toggleSection(sectionId)}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 16px', background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.72rem', fontWeight: 700, color: '#666', textTransform: 'uppercase', letterSpacing: '0.06em' }}
                >
                  {sectionName}
                  {collapsed ? <ChevronRight /> : <ChevronDown />}
                </button>

                {!collapsed && types.map(tt => {
                  const isActive = selectedTTId === tt.id;
                  return (
                    <button key={tt.id} onClick={() => pickTaskType(tt)}
                      style={{ width: '100%', display: 'block', textAlign: 'left', padding: '9px 16px 9px 24px', background: isActive ? 'rgba(255,105,0,0.08)' : 'none', border: 'none', borderLeft: isActive ? '3px solid var(--orange)' : '3px solid transparent', cursor: 'pointer', color: isActive ? 'var(--orange)' : 'var(--text-primary)', fontWeight: isActive ? 600 : 400, fontSize: '0.84rem', transition: 'background 0.1s' }}
                    >
                      <div style={{ lineHeight: 1.3 }}>{tt.name}</div>
                      {tt.description && (
                        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 2, fontWeight: 400 }}>
                          {tt.description}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>

        <div style={{ overflowY: 'auto', padding: '32px 40px' }}>
          {!selectedTT ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 12, color: 'var(--text-muted)' }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="48" height="48" style={{ opacity: 0.3 }}>
                <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/>
                <rect x="9" y="3" width="6" height="4" rx="1"/>
                <line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="12" y2="16"/>
              </svg>
              <p style={{ fontSize: '0.9rem' }}>{t('pages.newTask.selectPrompt')}</p>
            </div>
          ) : (
            <div className="new-task-workspace">
              <div className="new-task-form-column">
              <div style={{ marginBottom: 28 }}>
                <h1 style={{ fontSize: '1.35rem', fontWeight: 700, marginBottom: 4 }}>{selectedTT.name}</h1>
                {selectedTT.description && (
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{selectedTT.description}</p>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                  {selectedTT.section && (
                    <span style={{ fontSize: '0.72rem', fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                      {selectedTT.section.name}
                    </span>
                  )}
                  {selectedTT.schedulable && (
                    <span style={{ fontSize: '0.72rem', fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: 'var(--blue-bg)', color: 'var(--blue)' }}>
                      {t('pages.newTask.schedulable')}
                    </span>
                  )}
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                    {(selectedTT.stepDefinitions?.length ?? 0)} {t('common.steps')}
                  </span>
                </div>
              </div>

              {err && <div className="error-banner" style={{ marginBottom: 20 }}>{err}</div>}

              {selectedTT.schedulable && (
                <div className="card" style={{ marginBottom: 20, padding: '16px 20px' }}>
                  <div style={{ fontSize: '0.8rem', fontWeight: 700, marginBottom: 4, color: 'var(--text-secondary)' }}>{t('pages.newTask.scheduleSection')}</div>
                  <p className="form-hint" style={{ marginBottom: 12 }}>{t('pages.newTask.scheduleHint')}</p>
                  <div className="form-group" style={{ marginBottom: 8 }}>
                    <label className="form-label">{t('pages.newTask.startDateTime')}</label>
                    <input className="form-input" type="datetime-local" value={scheduledStart} min={schedMin} max={schedMax}
                      onChange={e => setScheduledStart(e.target.value)} style={{ maxWidth: 280 }} />
                  </div>
                  {scheduledStart && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', color: 'var(--text-muted)', background: 'var(--surface-2)', borderRadius: 6, padding: '6px 10px' }}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="13" height="13" style={{ flexShrink: 0 }}>
                        <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                      </svg>
                      {t('pages.newTask.windowNote').replace('{hours}', String(WINDOW_HOURS))}
                    </div>
                  )}
                </div>
              )}

              {(selectedTT?.templates?.length ?? 0) > 0 && (
                <div className="card" style={{ marginBottom: 20, padding: '16px 20px' }}>
                  <div style={{ fontSize: '0.8rem', fontWeight: 700, marginBottom: 12, color: 'var(--text-secondary)' }}>{t('pages.newTask.templatesSection')}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {selectedTT!.templates!.map(tp => (
                      <button key={tp.id} type="button" onClick={() => downloadTaskTemplate(tp).catch(() => setErr('No se pudo descargar la plantilla.'))}
                        style={{ display:'flex', width:'100%', alignItems:'center', gap:10, padding:'8px 12px', borderRadius:8, background:'var(--surface-2)', border:'1px solid var(--border)', color:'var(--text-primary)', cursor:'pointer', textAlign:'left' }}>
                        <span style={{ fontSize:'0.72rem', fontWeight:700, padding:'1px 6px', borderRadius:4, background:'var(--orange-muted)', color:'var(--orange)', textTransform:'uppercase', flexShrink:0 }}>{tp.tipo}</span>
                        <span style={{ fontWeight:500, fontSize:'0.84rem' }}>{tp.name}</span>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="13" height="13" style={{ marginLeft:'auto', flexShrink:0, opacity:0.4 }}>
                          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                        </svg>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {fields.length > 0 && (
                <div className="card" style={{ marginBottom: 20, padding: '16px 20px' }}>
                  <div style={{ fontSize: '0.8rem', fontWeight: 700, marginBottom: 16, color: 'var(--text-secondary)' }}>{t('pages.newTask.taskDetailsSection')}</div>
                  {fields.map(f => renderField(f))}
                </div>
              )}

              {fields.length === 0 && !selectedTT.schedulable && (
                <div className="card" style={{ marginBottom: 20, padding: '20px', textAlign: 'center' }}>
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{t('pages.newTask.noFormFields')}</p>
                </div>
              )}

              {(selectedTT.stepDefinitions?.length ?? 0) > 0 && (
                <div style={{ marginBottom: 24 }}>
                  <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
                    {t('pages.newTask.stepsPreviewHeader')}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {[...(selectedTT.stepDefinitions ?? [])].sort((a, b) => a.order - b.order).map((s, i) => (
                      <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 8, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
                        <div style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--orange-muted)', color: 'var(--orange)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.7rem', fontWeight: 700, flexShrink: 0 }}>
                          {i + 1}
                        </div>
                        <div style={{ flex: 1 }}>
                          <span style={{ fontWeight: 500, fontSize: '0.84rem' }}>{s.name}</span>
                          <span style={{ marginLeft: 8, fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                            {s.executionType.replace(/_/g, ' ')}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button className="btn btn-ghost" onClick={() => nav('/tasks')}>{t('pages.newTask.cancelBtn')}</button>
                <button
                  className="btn btn-primary"
                  style={{ minWidth: 140 }}
                  onClick={submit}
                  disabled={!canSubmit}
                  title={missingRequired ? t('pages.newTask.missingRequiredTitle') : hasUrlErrors ? t('pages.newTask.fixUrlErrors') : ''}
                >
                  {saving ? t('pages.newTask.creating') : t('pages.newTask.createTaskBtn')}
                </button>
              </div>
              </div>
              <ValidationAssistant
                key={selectedTT.id}
                taskTypeId={selectedTT.id}
                readiness={{
                  missingRequired: missingRequiredLabels,
                  hasUrlErrors,
                  fileFields: fileFields.length,
                  validFiles,
                }}
                latestValidation={latestFileValidation}
              />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
