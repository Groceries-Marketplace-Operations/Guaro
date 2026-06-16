import { useState, useMemo, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import Topbar from '../../components/layout/Topbar';
import { taskTypesApi, brandsApi, shopsApi, tasksApi, appConfigApi } from '../../api';
import type { TaskType, FormField, Brand, Shop } from '../../types';

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// Tomorrow at 00:00, local time, formatted as datetime-local value "YYYY-MM-DDThh:mm"
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

  return {
    min: toLocalDatetimeInput(now),
    max: toLocalDatetimeInput(maxDate),
  };
}

function addHours(datetimeLocal: string, hours: number): string {
  const d = new Date(datetimeLocal);
  d.setHours(d.getHours() + hours);
  return d.toISOString();
}

// ── Icons ─────────────────────────────────────────────────────────────────────

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

// ── Brand Combobox ─────────────────────────────────────────────────────────────

interface BrandComboboxProps {
  brands: Brand[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
}

function BrandCombobox({ brands, value, onChange, placeholder = 'Search brand…' }: BrandComboboxProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selected = brands.find(b => b.id === value);
  const displayValue = open ? query : (selected ? `${selected.brandName} · ${selected.country}` : '');

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    if (!q) return brands.slice(0, 50);
    return brands.filter(b =>
      b.brandName.toLowerCase().includes(q) || b.brandId.toLowerCase().includes(q)
    ).slice(0, 50);
  }, [brands, query]);

  const select = (b: Brand) => {
    onChange(b.id);
    setQuery('');
    setOpen(false);
  };

  const clear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange('');
    setQuery('');
    setOpen(false);
  };

  // Close on outside click
  const handleBlur = useCallback((e: React.FocusEvent) => {
    if (!containerRef.current?.contains(e.relatedTarget as Node)) {
      setOpen(false);
      setQuery('');
    }
  }, []);

  return (
    <div ref={containerRef} style={{ position: 'relative' }} onBlur={handleBlur}>
      <div style={{ position: 'relative' }}>
        <input
          className="form-input"
          value={displayValue}
          placeholder={placeholder}
          onChange={e => { setQuery(e.target.value); setOpen(true); if (!e.target.value) onChange(''); }}
          onFocus={() => { setOpen(true); if (selected) setQuery(''); }}
          style={{ paddingRight: value ? 32 : 12 }}
        />
        {value && (
          <button
            type="button"
            onMouseDown={clear}
            tabIndex={-1}
            style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 2 }}
          >
            <XSmall />
          </button>
        )}
      </div>

      {open && (
        <div style={{
          position: 'absolute', zIndex: 200, top: 'calc(100% + 4px)', left: 0, right: 0,
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8,
          boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
          maxHeight: 240, overflowY: 'auto',
        }}>
          {filtered.length === 0 ? (
            <div style={{ padding: '10px 14px', fontSize: '0.82rem', color: 'var(--text-muted)' }}>No brands found</div>
          ) : (
            filtered.map(b => (
              <div
                key={b.id}
                onMouseDown={() => select(b)}
                style={{
                  padding: '9px 14px', cursor: 'pointer', fontSize: '0.84rem',
                  background: value === b.id ? 'rgba(255,105,0,0.08)' : 'transparent',
                  color: value === b.id ? 'var(--orange)' : 'var(--text-primary)',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = value === b.id ? 'rgba(255,105,0,0.12)' : 'var(--surface-2)')}
                onMouseLeave={e => (e.currentTarget.style.background = value === b.id ? 'rgba(255,105,0,0.08)' : 'transparent')}
              >
                <span style={{ fontWeight: value === b.id ? 600 : 400 }}>{b.brandName}</span>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{b.brandId} · {b.country}</span>
              </div>
            ))
          )}
          {brands.length > 50 && filtered.length === 50 && (
            <div style={{ padding: '6px 14px', fontSize: '0.72rem', color: 'var(--text-muted)', borderTop: '1px solid var(--border)' }}>
              Showing first 50 — type to filter
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

type FieldValue = string | string[];

export default function NewTaskPage() {
  const nav = useNavigate();
  const { min: schedMin, max: schedMax } = useMemo(() => getSchedulingBounds(), []);

  const [selectedTTId, setSelectedTTId]         = useState<string | null>(null);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());

  const [scheduledStart, setScheduledStart] = useState('');
  const [formValues, setFormValues]         = useState<Record<string, FieldValue>>({});
  const [urlErrors, setUrlErrors]           = useState<Record<string, string>>({});

  const [saving, setSaving] = useState(false);
  const [err,    setErr]    = useState('');

  // ── Data ───────────────────────────────────────────────────────────────────

  const { data: taskTypesResult } = useQuery<{ data: TaskType[] }>({
    queryKey: ['task-types', { page: 1, limit: 200 }],
    queryFn: () => taskTypesApi.list({ page: 1, limit: 200 }).then(r => r.data as { data: TaskType[] }),
  });
  const taskTypes: TaskType[] = taskTypesResult?.data ?? [];

  // Fetch full detail (with formFields + stepDefinitions) when a TT is selected
  const { data: selectedTT = null } = useQuery<TaskType>({
    queryKey: ['task-type', selectedTTId],
    queryFn: () => taskTypesApi.get(selectedTTId!).then(r => r.data as TaskType),
    enabled: !!selectedTTId,
  });

  const fields: FormField[] = useMemo(
    () => [...(selectedTT?.formFields ?? [])].sort((a, b) => a.order - b.order),
    [selectedTT],
  );

  const hasBrandField   = fields.some(f => f.tipo === 'select_brand');
  const hasStoreField   = fields.some(f => f.tipo === 'select_store');
  const hasKaTypeField  = fields.some(f => f.tipo === 'select_ka_type');
  const hasCountryField = fields.some(f => f.tipo === 'select_country');

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

  const { data: brands = [] } = useQuery<Brand[]>({
    queryKey: ['brands', 'all'],
    queryFn: () => brandsApi.list({ limit: 500 }).then(r => (r.data as { data: Brand[] }).data),
    enabled: hasBrandField,
  });

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
    enabled: hasKaTypeField || hasCountryField,
  });

  // ── Section grouping ───────────────────────────────────────────────────────

  const bySection = useMemo(() => {
    const map = new Map<string, { sectionId: string; sectionName: string; types: TaskType[] }>();
    for (const tt of taskTypes) {
      if (tt.active === false) continue; // skip hidden task types
      const key = tt.sectionId;
      if (!map.has(key)) map.set(key, { sectionId: key, sectionName: tt.section?.name ?? 'No section', types: [] });
      map.get(key)!.types.push(tt);
    }
    return [...map.values()];
  }, [taskTypes]);

  // ── Handlers ───────────────────────────────────────────────────────────────

  const pickTaskType = (tt: TaskType) => {
    setSelectedTTId(tt.id);
    setFormValues({});
    setUrlErrors({});
    setScheduledStart('');
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
      setUrlErrors(prev => ({ ...prev, [fieldId]: 'Must be a valid URL (e.g. https://example.com)' }));
    } else {
      setUrlErrors(prev => { const next = { ...prev }; delete next[fieldId]; return next; });
    }
  };

  const toggleSection = (sectionId: string) => {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      next.has(sectionId) ? next.delete(sectionId) : next.add(sectionId);
      return next;
    });
  };

  const submit = async () => {
    if (!selectedTT) return;
    // Final URL validation
    let hasUrlError = false;
    for (const f of fields) {
      if (f.tipo === 'link' || f.tipo === 'link_spreadsheet') {
        const val = (formValues[f.id] as string) ?? '';
        if (!isValidUrl(val)) {
          setUrlErrors(prev => ({ ...prev, [f.id]: 'Must be a valid URL' }));
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
        } else if (f.tipo === 'select_store') {
          if (val) fvPayload.push({ formFieldId: f.id, shopId: val as string });
        } else if (f.multiple && Array.isArray(val)) {
          for (const v of val) {
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

  // ── Field renderers ────────────────────────────────────────────────────────

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
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleMultiOption(f.id, o)}
                      style={{ accentColor: 'var(--orange)', width: 15, height: 15, flexShrink: 0 }}
                    />
                    <span style={{ fontSize: '0.84rem' }}>{o}</span>
                  </label>
                );
              })}
            </div>
            {selected.length > 0 && (
              <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 4 }}>
                {selected.length} selected: {selected.join(', ')}
              </p>
            )}
          </div>
        );
      }
      return (
        <div className="form-group" key={f.id}>
          {label}
          <select className="form-select" value={strVal} onChange={e => setField(f.id, e.target.value)}>
            <option value="">Select…</option>
            {f.options.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
      );
    }

    if (f.tipo === 'select_brand') return (
      <div className="form-group" key={f.id}>
        {label}
        <BrandCombobox
          brands={brands}
          value={strVal}
          onChange={id => setField(f.id, id)}
        />
      </div>
    );

    if (f.tipo === 'select_ka_type') {
      const options = appConfig['ka_type'] ?? [];
      return (
        <div className="form-group" key={f.id}>
          {label}
          <select className="form-select" value={strVal} onChange={e => setField(f.id, e.target.value)}>
            <option value="">Select KA Type…</option>
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
            <option value="">Select Country…</option>
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
            <p className="form-hint" style={{ marginBottom: 6 }}>Select a brand first to load stores.</p>
          )}
          <select className="form-select" value={strVal} onChange={e => setField(f.id, e.target.value)} disabled={!filterBrandId}>
            <option value="">Select store…</option>
            {filteredShops.map(s => (
              <option key={s.id} value={s.id}>{s.shopId}{s.city ? ` · ${s.city}` : ''}</option>
            ))}
          </select>
        </div>
      );
    }

    return null;
  };

  // ── Validation ─────────────────────────────────────────────────────────────

  const missingRequired = fields.filter(f => f.required).some(f => {
    const val = formValues[f.id];
    if (f.multiple) return !Array.isArray(val) || val.length === 0;
    return !val;
  });

  const hasUrlErrors = Object.keys(urlErrors).length > 0;
  const canSubmit = !saving && !missingRequired && !hasUrlErrors;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      <Topbar breadcrumb={[{ label: 'Tasks', href: '/tasks' }, { label: 'New Task' }]} />

      <div style={{
        display: 'grid',
        gridTemplateColumns: '260px 1fr',
        gridColumn: 2,
        minHeight: 'calc(100vh - var(--topbar-h))',
      }}>

        {/* Left panel — Task type picker */}
        <div style={{
          borderRight: '1px solid var(--border)',
          overflowY: 'auto',
          padding: '20px 0',
          background: 'var(--surface-2)',
        }}>
          <div style={{ padding: '0 16px 12px', fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Task Types
          </div>

          {taskTypes.length === 0 && (
            <p style={{ padding: '0 16px', fontSize: '0.82rem', color: 'var(--text-muted)' }}>No task types available.</p>
          )}

          {bySection.map(({ sectionId, sectionName, types }) => {
            const collapsed = collapsedSections.has(sectionId);
            return (
              <div key={sectionId} style={{ marginBottom: 4 }}>
                <button
                  onClick={() => toggleSection(sectionId)}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '6px 16px', background: 'none', border: 'none', cursor: 'pointer',
                    fontSize: '0.72rem', fontWeight: 700, color: '#666',
                    textTransform: 'uppercase', letterSpacing: '0.06em',
                  }}
                >
                  {sectionName}
                  {collapsed ? <ChevronRight /> : <ChevronDown />}
                </button>

                {!collapsed && types.map(tt => {
                  const isActive = selectedTTId === tt.id;
                  return (
                    <button
                      key={tt.id}
                      onClick={() => pickTaskType(tt)}
                      style={{
                        width: '100%', display: 'block', textAlign: 'left',
                        padding: '9px 16px 9px 24px',
                        background: isActive ? 'rgba(255,105,0,0.08)' : 'none',
                        border: 'none',
                        borderLeft: isActive ? '3px solid var(--orange)' : '3px solid transparent',
                        cursor: 'pointer',
                        color: isActive ? 'var(--orange)' : 'var(--text-primary)',
                        fontWeight: isActive ? 600 : 400,
                        fontSize: '0.84rem',
                        transition: 'background 0.1s',
                      }}
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

        {/* Right panel — Form */}
        <div style={{ overflowY: 'auto', padding: '32px 40px' }}>
          {!selectedTT ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 12, color: 'var(--text-muted)' }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="48" height="48" style={{ opacity: 0.3 }}>
                <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/>
                <rect x="9" y="3" width="6" height="4" rx="1"/>
                <line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="12" y2="16"/>
              </svg>
              <p style={{ fontSize: '0.9rem' }}>Select a task type on the left to get started</p>
            </div>
          ) : (
            <div style={{ maxWidth: 640 }}>
              {/* Header */}
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
                      Schedulable
                    </span>
                  )}
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                    {(selectedTT.stepDefinitions?.length ?? 0)} step{(selectedTT.stepDefinitions?.length ?? 0) !== 1 ? 's' : ''}
                  </span>
                </div>
              </div>

              {err && <div className="error-banner" style={{ marginBottom: 20 }}>{err}</div>}

              {/* Scheduling */}
              {selectedTT.schedulable && (
                <div className="card" style={{ marginBottom: 20, padding: '16px 20px' }}>
                  <div style={{ fontSize: '0.8rem', fontWeight: 700, marginBottom: 4, color: 'var(--text-secondary)' }}>Schedule (optional)</div>
                  <p className="form-hint" style={{ marginBottom: 12 }}>
                    The task will activate at this date and time. If left empty, it starts immediately.
                  </p>
                  <div className="form-group" style={{ marginBottom: 8 }}>
                    <label className="form-label">Start date &amp; time</label>
                    <input
                      className="form-input"
                      type="datetime-local"
                      value={scheduledStart}
                      min={schedMin}
                      max={schedMax}
                      onChange={e => setScheduledStart(e.target.value)}
                      style={{ maxWidth: 280 }}
                    />
                  </div>
                  {scheduledStart && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', color: 'var(--text-muted)', background: 'var(--surface-2)', borderRadius: 6, padding: '6px 10px' }}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="13" height="13" style={{ flexShrink: 0 }}>
                        <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                      </svg>
                      Execution window: {WINDOW_HOURS} hours from start. Steps not completed by then will be marked as timed out.
                    </div>
                  )}
                </div>
              )}

              {/* Dynamic form fields */}
              {fields.length > 0 && (
                <div className="card" style={{ marginBottom: 20, padding: '16px 20px' }}>
                  <div style={{ fontSize: '0.8rem', fontWeight: 700, marginBottom: 16, color: 'var(--text-secondary)' }}>Task Details</div>
                  {fields.map(f => renderField(f))}
                </div>
              )}

              {fields.length === 0 && !selectedTT.schedulable && (
                <div className="card" style={{ marginBottom: 20, padding: '20px', textAlign: 'center' }}>
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                    This task type has no form fields. Click <strong>Create Task</strong> to start it immediately.
                  </p>
                </div>
              )}

              {/* Step preview */}
              {(selectedTT.stepDefinitions?.length ?? 0) > 0 && (
                <div style={{ marginBottom: 24 }}>
                  <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
                    Steps that will run
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

              {/* Submit */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button className="btn btn-ghost" onClick={() => nav('/tasks')}>Cancel</button>
                <button
                  className="btn btn-primary"
                  style={{ minWidth: 140 }}
                  onClick={submit}
                  disabled={!canSubmit}
                  title={
                    missingRequired ? 'Fill in all required fields' :
                    hasUrlErrors ? 'Fix URL errors before submitting' :
                    ''
                  }
                >
                  {saving ? 'Creating…' : 'Create Task'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
