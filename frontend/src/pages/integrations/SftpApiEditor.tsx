import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import client from '../../api/client';
import SftpApiBrandField from './SftpApiBrandField';
import { BASE, defaults } from './sftp-api.types';
import type { ApplicationOptions, Config, Rule, Mode } from './sftp-api.types';
import { ErrorBox } from './SftpApiUi';
const fields = [
  ['app_item_id', 'ID del producto', 'Full y delta'], ['upc', 'Código UPC', 'Full'], ['item_name', 'Nombre del producto', 'Full'],
  ['price', 'Precio regular', 'Full · pesos → centavos'], ['activity_price', 'Precio de oferta', 'Full · opcional'], ['stock', 'Existencias', 'Full y delta · se redondea hacia abajo'], ['status', 'Estado', 'Full · vacío = según stock'],
];
export default function SftpApiEditor({ rule, close, saved }: { rule?: Rule; close: () => void; saved: (rule: Rule) => void }) {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<Config>(() => rule ? Object.fromEntries(Object.keys(defaults).map(key => [key, rule[key as keyof Config]])) as Config : structuredClone(defaults));
  const [brandName, setBrandName] = useState(rule?.brand.brandName ?? '');
  const [validation, setValidation] = useState('');
  const set = <K extends keyof Config>(key: K, value: Config[K]) => setForm(current => ({ ...current, [key]: value }));
  const options = useQuery({ queryKey: ['sftp-api', 'application-options', form.brandId], enabled: Boolean(form.brandId),
    queryFn: () => client.get<ApplicationOptions>(`${BASE}/applications/options`, { params: { brandId: form.brandId } }).then(r => r.data) });
  const apiApplication = options.data?.applications.find(app => app.id === form.applicationId);
  const sftpApplication = options.data?.sftpApplications.find(app => app.id === form.sftpApplicationId);
  const save = useMutation({ mutationFn: () => rule ? client.patch<Rule>(`${BASE}/${rule.id}`, form) : client.post<Rule>(BASE, form), onSuccess: result => saved(result.data) });
  return <section className="card sftp-editor">
    <div className="sftp-heading"><div><h2>{rule ? 'Editar configuración' : 'Configurar una marca'}</h2><p>Conecta el servidor, asigna columnas y define cuándo leer.</p></div><button type="button" className="btn btn-secondary" onClick={close} disabled={save.isPending}>Cancelar</button></div>
    <ol className="sftp-steps">{['Conexión', 'Archivos y columnas', 'Horarios'].map((label, index) => <li key={label} className={index === step ? 'current' : ''}><button type="button" onClick={() => index < step && setStep(index)} disabled={index > step}><span>{index + 1}</span>{label}</button></li>)}</ol>
    <form onSubmit={event => {
      event.preventDefault(); setValidation('');
      if (!form.brandId) { setValidation('Selecciona una marca del catálogo.'); return; }
      if (!apiApplication || !sftpApplication) { setValidation('Selecciona una aplicación API y una aplicación SFTP disponibles.'); setStep(0); return; }
      if (step < 2) {
        if (step === 1) { try { new RegExp(form.fileRegex); new RegExp(form.shopRegex); } catch { setValidation('Revisa las expresiones regulares.'); return; } }
        setStep(step + 1); return;
      }
      if (new Set(form.schedules.map(s => s.time)).size !== form.schedules.length) { setValidation('Cada horario debe ser único.'); return; }
      save.mutate();
    }}>
      {step === 0 && <div className="sftp-form-grid">
        <div className="sftp-field sftp-wide"><label>Marca</label>{rule ? <strong>{rule.brand.brandName}</strong> : <SftpApiBrandField value={form.brandId} displayValue={brandName} onChange={(id, label) => { setForm(current => ({ ...current, brandId: id, applicationId: '', sftpApplicationId: '' })); setBrandName(label); }} />}</div>
        <label className="sftp-field sftp-wide">Aplicación API DiDi Food<select required className="form-input" value={form.applicationId} disabled={!form.brandId || options.isPending} onChange={e => set('applicationId', e.target.value)}>
          <option value="">{options.isFetching ? 'Cargando aplicaciones…' : 'Selecciona una aplicación API'}</option>
          {form.applicationId && !apiApplication && <option value={form.applicationId} disabled>{rule?.application.appName ?? 'Aplicación seleccionada'} · no disponible</option>}
          {options.data?.applications.map(app => <option key={app.id} value={app.id}>{app.appName} · {app.appId} · {app.country}</option>)}
        </select><small>Usa el App ID y el secreto guardados en Admin → Applications. Se muestran las aplicaciones del país de la marca.</small></label>
        <label className="sftp-field sftp-wide">Aplicación SFTP<select required className="form-input" value={form.sftpApplicationId} disabled={!form.brandId || options.isPending} onChange={e => set('sftpApplicationId', e.target.value)}>
          <option value="">{options.isFetching ? 'Cargando servidores…' : 'Selecciona una aplicación SFTP'}</option>
          {form.sftpApplicationId && !sftpApplication && <option value={form.sftpApplicationId} disabled>{rule?.sftpApplication.name ?? 'Aplicación seleccionada'} · no disponible</option>}
          {options.data?.sftpApplications.map(app => <option key={app.id} value={app.id}>{app.name} · {app.host}:{app.port}</option>)}
        </select><small>Usa las credenciales de Admin → Aplicaciones SFTP. Se muestran servidores activos de esta marca o sin marca asignada.</small></label>
        {sftpApplication && <div className="sftp-note sftp-wide"><strong>{sftpApplication.username}@{sftpApplication.host}:{sftpApplication.port}</strong><p>Ruta raíz: <span className="sftp-mono">{sftpApplication.rootPath?.trim() || '/upload'}</span></p><p>La ruta raíz y las credenciales se toman de Aplicaciones SFTP al iniciar cada ejecución.</p></div>}
        {form.brandId && options.data && (!options.data.applications.length || !options.data.sftpApplications.length) && <p className="sftp-wide" role="status">No hay aplicaciones compatibles en uno de los catálogos. Registra o actualiza la aplicación correspondiente en Admin y vuelve a este formulario.</p>}
        <div className="sftp-wide"><ErrorBox error={options.error} /></div>
      </div>}
      {step === 1 && <>
        <div className="sftp-form-grid">
          <label className="sftp-field">Antigüedad máxima del archivo (minutos)<input required type="number" min={1} max={525600} step={1} className="form-input" value={form.maxFileAgeMinutes} onChange={e => set('maxFileAgeMinutes', Number(e.target.value))} /><small>Se usa la última modificación reportada por el SFTP. Con 30, se leen archivos de hasta 30 minutos que coincidan con el regex y no estén registrados.</small></label>
          <label className="sftp-field">Regex de archivos<input required className="form-input sftp-mono" value={form.fileRegex} onChange={e => set('fileRegex', e.target.value)} /><small>Ejemplo: \.csv$ busca archivos CSV.</small></label>
          <label className="sftp-field">Separador de columnas<select className="form-input" value={form.delimiter} onChange={e => set('delimiter', e.target.value)}><option value="|">Barra vertical ( | )</option><option value=",">Coma ( , )</option><option value=";">Punto y coma ( ; )</option><option value={'\t'}>Tabulador</option></select></label>
          <label className="sftp-check sftp-wide"><input type="checkbox" checked={form.hasHeader} onChange={e => set('hasHeader', e.target.checked)} /> La primera fila contiene encabezados</label>
          <label className="sftp-field">Origen del ID de tienda<select className="form-input" value={form.shopSource} onChange={e => set('shopSource', e.target.value as Config['shopSource'])}><option value="filename">Nombre del archivo</option><option value="column">Columna del archivo</option></select></label>
          {form.shopSource === 'filename' ? <label className="sftp-field">Regex del ID de tienda<input required className="form-input sftp-mono" value={form.shopRegex} onChange={e => set('shopRegex', e.target.value)} /><small>El primer grupo entre paréntesis captura app_shop_id y conserva ceros iniciales.</small></label> : <label className="sftp-field">Columna app_shop_id<input required pattern="[A-Z]{1,3}" className="form-input" value={form.mapping.app_shop_id} placeholder="A" onChange={e => set('mapping', { ...form.mapping, app_shop_id: e.target.value.toUpperCase() })} /></label>}
        </div>
        <h3 className="sftp-divider">Relaciona los campos API con tus columnas</h3><p>Usa letras A, B, C… como en Excel. Los valores iniciales vienen del script adjunto; ajusta el nombre del producto si está en otra columna.</p>
        <div className="sftp-table-wrap"><table className="sftp-table"><thead><tr><th>Campo API</th><th>Uso</th><th>Columna CSV</th></tr></thead><tbody>{fields.map(([key, label, hint]) => <tr key={key}><td><strong>{label}</strong><small className="sftp-mono">{key}</small></td><td>{hint}</td><td><input aria-label={`Columna de ${key}`} className="form-input sftp-column" maxLength={3} pattern="[A-Z]{1,3}" required={!['activity_price', 'status'].includes(key)} value={form.mapping[key] || ''} placeholder="Automático" onChange={e => set('mapping', { ...form.mapping, [key]: e.target.value.toUpperCase() })} /></td></tr>)}</tbody></table></div>
        <p>Full genera menú y categorías “Despensa” automáticamente. Delta envía exclusivamente app_item_id y stock.</p>
      </>}
      {step === 2 && <>
        <div className="sftp-note"><strong>Todos los días · horario de Ciudad de México</strong><p>Full reemplaza el menú con el archivo más reciente de cada tienda. Delta aplica stock de los archivos pendientes, del más antiguo al más reciente.</p></div>
        {form.schedules.map((schedule, index) => <div className="sftp-schedule" key={index}>
          <label className="sftp-field">Hora MX<input type="time" required className="form-input" value={schedule.time} onChange={e => set('schedules', form.schedules.map((s, i) => i === index ? { ...s, time: e.target.value } : s))} /></label>
          <label className="sftp-field">Tipo de carga<select className="form-input" value={schedule.mode} onChange={e => set('schedules', form.schedules.map((s, i) => i === index ? { ...s, mode: e.target.value as Mode } : s))}><option value="full">Full · menú y stock</option><option value="delta">Delta · solo stock</option></select></label>
          <button type="button" className="btn btn-secondary" aria-label={`Eliminar horario ${schedule.time}`} disabled={form.schedules.length === 1} onClick={() => set('schedules', form.schedules.filter((_, i) => i !== index))}>Eliminar</button>
        </div>)}
        <button type="button" className="btn btn-secondary" disabled={form.schedules.length >= 48} onClick={() => set('schedules', [...form.schedules, { time: '18:00', mode: 'delta' }])}>+ Agregar horario</button>
        <label className="sftp-check sftp-note"><input type="checkbox" checked={form.active} onChange={e => set('active', e.target.checked)} /><span><strong>Activar lecturas automáticas</strong><small>Se enviarán datos a las tiendas en los horarios indicados. Puedes guardar la configuración pausada.</small></span></label>
      </>}
      {validation && <div className="sftp-error" role="alert">{validation}</div>}<ErrorBox error={save.error} />
      <div className="sftp-form-footer"><span>Paso {step + 1} de 3</span><div className="sftp-actions">{step > 0 && <button type="button" className="btn btn-secondary" onClick={() => setStep(step - 1)}>Atrás</button>}<button type="submit" className="btn btn-primary" disabled={save.isPending}>{save.isPending ? 'Guardando…' : step === 2 ? 'Guardar configuración' : 'Continuar'}</button></div></div>
    </form>
  </section>;
}
