const state={config:null,sessionId:null,promotions:[],selected:new Set(),preview:null,activityAction:1,activityActions:new Map(),idMode:'keep',sftpFiles:[],sftpAccounts:[],sftpAccountId:'',destinationMode:'selected',selectedStores:new Set(),itemIdReplacements:new Map(),duplicateItemConflicts:[],duplicateItemChoices:new Map(),zeroDiscountItems:[],zeroDiscountPolicy:'',unsupportedPercentageItems:[],unsupportedPercentagePolicy:'',taskStoreId:'',taskEntries:[],taskResults:[],taskRawResults:new Map(),taskQueryJobId:'',taskQueryRunning:false,taskPage:1,taskPageSize:50,taskRenderTimer:null,defaultRuleId:'',diagnostics:null,automationPreview:null,automationFiles:[]};
const $=id=>document.getElementById(id);
const DEFAULT_RULES_KEY='didi-promo-manager.default-rules.v1';
const TASK_QUEUE_KEY='didi-promo-manager.task-queue.v1';
const ui={view:'prepare',diagnosticsLoading:false,operations:new Map(),sftpSearchRequest:0};
const views={
  prepare:{title:'Promociones, bajo control.',description:'Carga un archivo, elige las tiendas y revisa el JSON antes de enviar.'},
  automation:{title:'De tu SFTP a cada tienda.',description:'Prepara los archivos de una marca y revisa la operación completa en un solo lugar.'},
  tracking:{title:'Cada envío, a la vista.',description:'Consulta tus Task IDs por tienda y distingue los resultados de las incidencias.'},
  diagnostics:{title:'Detecta antes de enviar.',description:'Revisa la estructura y los valores de una muestra por marca, sin modificar archivos.'},
  guide:{title:'Todo lo que necesitas saber.',description:'Plantilla, reglas y pasos para preparar y seguir tus promociones.'},
};
function initializeNavigation(){
  $('prepare').insertAdjacentElement('afterend',$('previewPanel'));
  document.querySelector('.content').append(document.querySelector('.preview-action'));
  window.addEventListener('hashchange',showCurrentView);
  showCurrentView();
}
function showCurrentView(){
  const anchor=location.hash.slice(1);
  const view=anchor==='mainContent'?ui.view:anchor==='sftpAutomation'?'automation':anchor==='tracking'?'tracking':anchor==='diagnostics'?'diagnostics':anchor==='documentation'||anchor.startsWith('doc-')?'guide':'prepare';
  ui.view=view;
  document.querySelectorAll('[data-view-panel]').forEach(panel=>panel.classList.toggle('view-inactive',panel.dataset.viewPanel!==view));
  document.querySelectorAll('[data-view-link]').forEach(link=>{if(link.dataset.viewLink===view)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');});
  $('viewTitle').textContent=views[view].title;$('viewDescription').textContent=views[view].description;
  document.title=`${view==='prepare'?'Preparar envío':view==='automation'?'Operación SFTP':view==='tracking'?'Seguimiento':view==='diagnostics'?'Diagnóstico':'Guía'} · Promo Manager`;
  if(view==='diagnostics'&&state.config&&!state.diagnostics&&!ui.diagnosticsLoading)loadDiagnostics(false);
  requestAnimationFrame(()=>{
    const target=anchor.startsWith('doc-')?$(anchor):$('mainContent');
    target?.scrollIntoView({block:'start'});
  });
}
function operationFor(path){
  if(path.startsWith('/api/sftp-automation/preview'))return ['automation','Descargando y preparando archivos SFTP…'];
  if(path.startsWith('/api/sftp-automation/execute'))return ['automation','Ejecutando la operación por tienda…'];
  if(path.startsWith('/api/diagnostics'))return ['diagnostics','Analizando los archivos de muestra…'];
  if(path==='/api/send')return ['prepare','Enviando las promociones confirmadas…'];
  if(path==='/api/preview')return ['prepare','Generando y validando la vista previa…'];
  if(path==='/api/files'||path==='/api/sftp-files/load')return ['prepare','Cargando y validando el archivo…'];
  return null;
}
function renderActivity(){
  const operations=[...ui.operations.values()];
  if(state.taskQueryRunning)operations.push(['tracking','Consultando Task IDs. El avance está en Seguimiento.']);
  $('operationStatus').classList.toggle('hidden',!operations.length);
  $('operationStatusText').textContent=operations.map(([,message])=>message).join(' · ');
  document.querySelectorAll('[data-view-link]').forEach(link=>link.classList.toggle('is-busy',operations.some(([view])=>view===link.dataset.viewLink)));
}
function renderPreparationOverview(readiness){
  const destinations=state.destinationMode==='all'?(state.config?brandStores().length:0):state.selectedStores.size;
  $('overviewSource').textContent=state.sessionId?$('fileStatus').textContent:currentSftpAccount()?'Marca lista · carga un archivo':'Selecciona una marca y carga un archivo';
  $('overviewDestination').textContent=destinations?`${destinations.toLocaleString()} tienda${destinations===1?'':'s'}${state.destinationMode==='all'?' · marca completa':''}`:'Elige las tiendas que recibirán el envío';
  $('overviewSelection').textContent=state.selected.size?`${state.selected.size.toLocaleString()} promoción${state.selected.size===1?'':'es'} seleccionada${state.selected.size===1?'':'s'}`:'Selecciona promociones del catálogo';
  [$('overviewSource'),$('overviewDestination'),$('overviewSelection')].forEach((element,index)=>element.closest('.preparation-overview > div').classList.toggle('is-ready',[!!state.sessionId,destinations>0,state.selected.size>0][index]));
  $('previewReadiness').textContent=readiness;
}

async function api(path,options={}){
  const operation=operationFor(path);const operationId=Symbol(path);
  if(operation){ui.operations.set(operationId,operation);renderActivity();}
  try{
  const token=localStorage.getItem('token');
  if(!token)throw new Error('Inicia sesión como administrador en Tequila para continuar.');
  const response=await fetch(`/guaro/api/promo-manager${path.slice(4)}`,{headers:{'content-type':'application/json',Authorization:`Bearer ${token}`,...(options.headers||{})},...options});
  const data=await response.json().catch(()=>({error:'Respuesta local inválida.'}));
  if(!response.ok||data.error){const error=new Error(data.error||`HTTP ${response.status}`);error.outputDirectory=data.outputDirectory||'';throw error;}
  return data;
  }finally{if(operation){ui.operations.delete(operationId);renderActivity();}}
}
function notice(message,type='success'){$('notice').textContent=message;$('notice').className=`notice ${type}`;}
function clearNotice(){$('notice').className='notice hidden';}
function escapeHtml(value){return String(value).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function formatDate(value){return String(value).slice(0,10);}
function formatBytes(value){const bytes=Number(value);if(!Number.isFinite(bytes))return '';if(bytes<1024)return `${bytes} B`;if(bytes<1024**2)return `${(bytes/1024).toFixed(1)} KB`;return `${(bytes/1024**2).toFixed(1)} MB`;}

function diagnosticStatus(status){return ({healthy:'Sin anomalías',warning:'Revisar',critical:'Crítico',unavailable:'No disponible'})[status]||status;}
function diagnosticSummary(results){return {brands:results.length,healthy:results.filter(result=>result.status==='healthy').length,warnings:results.filter(result=>result.status==='warning').length,critical:results.filter(result=>result.status==='critical').length,unavailable:results.filter(result=>result.status==='unavailable').length,anomalies:results.reduce((total,result)=>total+(result.anomalies||[]).length,0)};}
function diagnosticOptionText(option){return [option.storeName,option.city,option.sourceShopId&&`ID de tienda de origen ${option.sourceShopId}`,option.shopId&&`Shop ID ${option.shopId}`,option.appShopId&&`App Shop ID ${option.appShopId}`,option.fileName].filter(Boolean).join(' · ');}
function renderDiagnosticStoreOptions(resultIndex,query=''){
  const container=document.querySelector(`[data-diagnostic-store-options="${resultIndex}"]`);if(!container||!state.diagnostics)return;
  const result=state.diagnostics.results[resultIndex];const normalized=query.trim().toLocaleLowerCase('es');
  const options=(result.sampleOptions||[]).filter(option=>!normalized||diagnosticOptionText(option).toLocaleLowerCase('es').includes(normalized)).slice(0,20);
  container.innerHTML=options.length?options.map(option=>{const active=result.sample?.accountId===option.accountId&&result.sample?.fileName===option.fileName;const label=option.storeName||option.sourceShopId||'Tienda sin nombre';const detail=[option.city,option.sourceShopId&&`ID ${option.sourceShopId}`,option.fileTimestamp||option.modifiedAt,option.fileName].filter(Boolean).join(' · ');return `<button type="button" class="diagnostic-store-option${active?' active':''}" data-diagnose-sample data-result-index="${resultIndex}" data-account-id="${escapeHtml(option.accountId)}" data-file-name="${escapeHtml(option.fileName)}" ${active?'disabled':''}><strong>${escapeHtml(label)}</strong><span>${escapeHtml(detail)}</span></button>`;}).join(''):`<div class="diagnostic-store-empty">No hay tiendas que coincidan con “${escapeHtml(query)}”.</div>`;
  container.querySelectorAll('[data-diagnose-sample]').forEach(button=>button.addEventListener('click',()=>diagnoseSelectedSample(button)));
}
async function diagnoseSelectedSample(button){
  const resultIndex=Number(button.dataset.resultIndex);const accountId=button.dataset.accountId;const fileName=button.dataset.fileName;if(!Number.isSafeInteger(resultIndex)||!accountId||!fileName)return;
  button.disabled=true;const original=button.innerHTML;button.innerHTML='<strong>Analizando…</strong><span>Descargando y validando la muestra elegida.</span>';
  try{
    const response=await api('/api/diagnostics/sample',{method:'POST',body:JSON.stringify({accountId,fileName})});
    state.diagnostics.results[resultIndex]=response.result;state.diagnostics.generatedAt=response.generatedAt;state.diagnostics.summary=diagnosticSummary(state.diagnostics.results);state.diagnostics.cached=false;
    renderDiagnostics(state.diagnostics);notice(`Diagnóstico actualizado con la tienda ${response.result.sample?.storeName||response.result.sample?.sourceShopId||fileName}.`);
  }catch(error){button.disabled=false;button.innerHTML=original;notice(error.message,'error');}
}
function renderDiagnostics(data){
  state.diagnostics=data;
  const summary=data.summary||{};const generated=data.generatedAt?new Date(data.generatedAt).toLocaleString('es-MX'):'sin fecha';
  $('diagnosticsSummary').innerHTML=`<span>${Number(summary.brands||0).toLocaleString()} marcas</span><span class="healthy">${Number(summary.healthy||0).toLocaleString()} sin alertas</span><span class="warning">${Number(summary.warnings||0).toLocaleString()} por revisar</span><span class="critical">${Number(summary.critical||0).toLocaleString()} críticas</span><span class="critical">${Number(summary.unavailable||0).toLocaleString()} no disponibles</span><span>${data.cached?'Resultado guardado':'Actualizado'} · ${escapeHtml(generated)}</span>`;
  $('diagnosticsRules').innerHTML=(data.rules||[]).map(rule=>`<div><strong>${escapeHtml(rule.label)}</strong><span>${escapeHtml(rule.description)}</span></div>`).join('');
  const results=Array.isArray(data.results)?data.results:[];
  $('diagnosticsResults').innerHTML=results.length?results.map((result,resultIndex)=>{
    const sample=result.sample;const stats=sample?.stats||{};const store=sample?(sample.storeName?`${sample.storeName} · ${sample.sourceShopId}`:sample.sourceShopId||'Tienda no identificada'):'Sin tienda de muestra';
    const sampleHtml=sample?`<div class="diagnostic-sample"><div><span>Tienda</span><strong title="${escapeHtml(store)}">${escapeHtml(store)}</strong></div><div><span>Promociones</span><strong>${Number(stats.promotions||0).toLocaleString()}</strong></div><div><span>Productos</span><strong>${Number(stats.items||0).toLocaleString()}</strong></div></div><p class="diagnostic-file">${escapeHtml(sample.fileName)} · ${escapeHtml(sample.fileTimestamp||sample.modifiedAt||'sin fecha')} · ${escapeHtml(formatBytes(sample.size))} · ${escapeHtml(sample.encoding||'')}</p>`:'';
    const issues=(result.anomalies||[]).map(issue=>`<div class="diagnostic-issue ${escapeHtml(issue.severity)}"><strong>${escapeHtml(issue.title)}${Number(issue.count||0)>1?` · ${Number(issue.count).toLocaleString()} casos`:''}</strong><span>${escapeHtml(issue.message)}</span>${issue.evidence?.length?`<ul class="diagnostic-evidence">${issue.evidence.map(item=>`<li>${escapeHtml(item)}</li>`).join('')}</ul>`:''}</div>`).join('');
    const download=sample?.accountId&&sample?.fileName?`<button class="button subtle diagnostic-download" type="button" data-download-diagnostic data-account-id="${escapeHtml(sample.accountId)}" data-file-name="${escapeHtml(sample.fileName)}">Descargar archivo</button>`:'';
    const sampleOptions=result.sampleOptions||[];const picker=sampleOptions.length>1?`<details class="diagnostic-store-picker"><summary>Elegir otra tienda · ${sampleOptions.length.toLocaleString()} disponibles</summary><input type="search" data-diagnostic-store-search data-result-index="${resultIndex}" placeholder="Buscar nombre, ciudad, Shop/App Shop ID o archivo"><div class="diagnostic-store-options" data-diagnostic-store-options="${resultIndex}"><div class="diagnostic-store-empty">Abre y busca la tienda que deseas diagnosticar.</div></div></details>`:'';
    return `<article class="diagnostic-card" data-status="${escapeHtml(result.status)}"><div class="diagnostic-card-heading"><div><h3>${escapeHtml(result.brandName)}</h3><small>${escapeHtml((result.accountIds||[]).join(' · '))}</small></div><div class="diagnostic-card-actions"><span class="diagnostic-status ${escapeHtml(result.status)}">${escapeHtml(diagnosticStatus(result.status))}</span>${download}</div></div>${picker}${sampleHtml}${issues?`<div class="diagnostic-issues">${issues}</div>`:'<div class="diagnostic-healthy-message">La muestra cumple el estándar y no activó ninguna alerta.</div>'}</article>`;
  }).join(''):'<div class="diagnostics-empty">No hay marcas SFTP configuradas para diagnosticar.</div>';
  document.querySelectorAll('[data-download-diagnostic]').forEach(button=>button.addEventListener('click',()=>downloadDiagnosticFile(button)));
  document.querySelectorAll('[data-diagnostic-store-search]').forEach(input=>{const index=Number(input.dataset.resultIndex);input.addEventListener('input',()=>renderDiagnosticStoreOptions(index,input.value));input.closest('details')?.addEventListener('toggle',event=>{if(event.target.open)renderDiagnosticStoreOptions(index,input.value);});});
}
async function loadDiagnostics(force=false){
  if(ui.diagnosticsLoading)return;ui.diagnosticsLoading=true;
  const button=$('refreshDiagnostics');button.disabled=true;button.textContent=force?'Ejecutando…':'Diagnosticando…';
  $('diagnosticsResults').innerHTML='<div class="diagnostics-loading">Seleccionando una tienda y analizando un archivo por marca…</div>';
  try{renderDiagnostics(await api(`/api/diagnostics${force?'?refresh=1':''}`));}
  catch(error){$('diagnosticsSummary').innerHTML='<span class="critical">Diagnóstico no disponible</span>';$('diagnosticsResults').innerHTML=`<div class="diagnostics-empty">${escapeHtml(error.message)}</div>`;}
  finally{ui.diagnosticsLoading=false;button.disabled=false;button.textContent='Ejecutar nuevamente';}
}

function automationTypes(){return [...document.querySelectorAll('.automation-types input:checked')].map(input=>Number(input.value));}
function automationDateValue(id){const value=$(id).value.trim();if(!value)return '';const normalized=value.replace('T',' ');return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(normalized)?`${normalized}:00`:normalized;}
function invalidateAutomationPreview(){state.automationPreview=null;$('automationPreviewPanel').classList.add('hidden');$('automationConfirm').checked=false;$('automationExecuteButton').disabled=true;$('automationResult').classList.add('hidden');}
function updateAutomationForm({invalidate=true}={}){
  if(invalidate)invalidateAutomationPreview();
  const accountId=$('automationAccountSelect').value;const mode=$('automationFileMode').value;const send=$('automationSendApi').checked;const updateDates=$('automationUpdateDates').checked;
  $('automationSpecificFileField').classList.toggle('hidden',mode!=='specific');
  $('automationDateFields').classList.toggle('hidden',!updateDates);
  $('automationWriteSftp').disabled=!updateDates;if(!updateDates)$('automationWriteSftp').checked=false;
  const datesReady=!updateDates||Boolean(automationDateValue('automationStartDate')||automationDateValue('automationEndDate'));
  const idReady=!send||/^\d{1,64}$/.test($('automationActivityId').value.trim());
  const fileReady=mode!=='specific'||Boolean($('automationFileSelect').value);
  const operationReady=send||$('automationWriteSftp').checked;
  $('automationPreviewButton').disabled=!accountId||!automationTypes().length||!datesReady||!idReady||!fileReady||!operationReady;
}
async function loadAutomationFiles(force=false){
  const accountId=$('automationAccountSelect').value;if(!accountId){state.automationFiles=[];$('automationFileSelect').innerHTML='<option value="">Selecciona una cuenta…</option>';updateAutomationForm();return;}
  $('automationRefreshFiles').disabled=true;$('automationStatus').textContent='Consultando archivos de la cuenta…';
  try{
    const result=await api(`/api/sftp-files?accountId=${encodeURIComponent(accountId)}&limit=1000${force?'&refresh=1':''}`);
    state.automationFiles=result.files||[];
    $('automationFileSelect').innerHTML=state.automationFiles.length?'<option value="">Selecciona un archivo…</option>'+state.automationFiles.map(file=>`<option value="${escapeHtml(file.name)}">${escapeHtml(file.sourceShopId||'Sin tienda')} · ${escapeHtml(file.modifiedAt||file.fileTimestamp||'sin fecha')} · ${escapeHtml(formatBytes(file.size))}</option>`).join(''):'<option value="">No hay archivos cargables</option>';
    $('automationStatus').textContent=`${state.automationFiles.length.toLocaleString()} archivos mostrados de ${Number(result.total||0).toLocaleString()}. En modo reciente se usará uno por tienda.`;
  }catch(error){state.automationFiles=[];$('automationFileSelect').innerHTML='<option value="">No disponible</option>';$('automationStatus').textContent='No fue posible consultar el SFTP';notice(error.message,'error');}
  finally{$('automationRefreshFiles').disabled=false;updateAutomationForm();}
}
function automationStatusLabel(status){return ({ready:'Lista',blocked:'Bloqueada',skipped:'Omitida'})[status]||status;}
function renderAutomationPreview(preview){
  state.automationPreview=preview;const summary=preview.summary||{};const totals=preview.totals||{};
  $('automationPreviewSummary').textContent=`${Number(summary.readyFiles||0).toLocaleString()} archivos listos de ${Number(summary.selectedFiles||0).toLocaleString()} · ${Number(totals.requests||0).toLocaleString()} solicitud${Number(totals.requests)===1?'':'es'} · ${Number(totals.items||0).toLocaleString()} productos`;
  $('automationAudit').textContent=preview.auditDirectory?`Auditoría preparada en: ${preview.auditDirectory}`:'';
  $('automationSummaryCards').innerHTML=`<span><strong>${Number(summary.storesToSend||0).toLocaleString()}</strong> tiendas por enviar</span><span><strong>${Number(summary.filesToEdit||0).toLocaleString()}</strong> archivos por editar</span><span><strong>${Number(summary.blockedFiles||0).toLocaleString()}</strong> bloqueados</span><span><strong>${Number(summary.skippedFiles||0).toLocaleString()}</strong> sin el tipo elegido</span>`;
  const files=preview.files||[];
  $('automationFileTable').innerHTML=files.length?files.map(file=>{
    const store=file.store?`${file.store.name} · ${file.store.appShopId}`:file.sourceShopId||'Sin tienda vinculada';
    const types=(file.types||[]).map(type=>`Tipo ${type.type} · ${type.name}: ${Number(type.promotions||0).toLocaleString()} promos / ${Number(type.items||0).toLocaleString()} productos`).join('<br>')||'Sin promociones seleccionadas';
    const rules=file.rules?[file.rules.zeroPercentItemsOmitted&&`${file.rules.zeroPercentItemsOmitted} de 0% omitidos`,file.rules.unsupportedPercentItemsOmitted&&`${file.rules.unsupportedPercentItemsOmitted} fuera de rango omitidos`,file.rules.duplicateRowsCollapsed&&`${file.rules.duplicateRowsCollapsed} duplicados idénticos consolidados`,file.changedRows&&`${file.changedRows} filas con nueva vigencia`].filter(Boolean).join(' · ')||'Sin ajustes automáticos':'—';
    const mappings=(file.activityIdMappings||[]).map(item=>`${item.originalId} → ${item.sentId}`).join(' · ')||'—';
    return `<tr><td><strong>${escapeHtml(store)}</strong><small>${escapeHtml(file.fileName)}</small></td><td>${types}</td><td>${escapeHtml(rules)}</td><td>${escapeHtml(mappings)}</td><td><span class="automation-file-status ${escapeHtml(file.status)}">${escapeHtml(automationStatusLabel(file.status))}</span>${file.message?`<small>${escapeHtml(file.message)}</small>`:''}</td></tr>`;
  }).join(''):'<tr><td colspan="5" class="empty">No se prepararon archivos.</td></tr>';
  $('automationJsonPreview').textContent=JSON.stringify(preview.samplePayloads||[],null,2);
  $('automationConfirm').checked=false;$('automationExecuteButton').disabled=true;$('automationResult').classList.add('hidden');$('automationPreviewPanel').classList.remove('hidden');
  $('automationPreviewPanel').scrollIntoView({behavior:'smooth',block:'start'});
}
async function prepareAutomationPreview(){
  clearNotice();invalidateAutomationPreview();$('automationPreviewButton').disabled=true;$('automationPreviewButton').textContent='Preparando archivos…';$('automationStatus').textContent='Descargando y validando. En cuentas grandes puede tardar varios minutos…';
  try{
    const body={
      accountId:$('automationAccountSelect').value,fileMode:$('automationFileMode').value,fileName:$('automationFileSelect').value,
      types:automationTypes(),newActivityId:$('automationActivityId').value.trim(),
      updateDates:$('automationUpdateDates').checked,startDate:automationDateValue('automationStartDate'),endDate:automationDateValue('automationEndDate'),
      writeSftp:$('automationWriteSftp').checked,sendApi:$('automationSendApi').checked,
    };
    const preview=await api('/api/sftp-automation/preview',{method:'POST',body:JSON.stringify(body)});renderAutomationPreview(preview);
    $('automationStatus').textContent=`Preparación completa: ${preview.summary.readyFiles} listos, ${preview.summary.blockedFiles} bloqueados y ${preview.summary.skippedFiles} omitidos.`;
    notice('La vista previa masiva está lista. Todavía no se modificó el SFTP ni se llamó a la API.');
  }catch(error){$('automationStatus').textContent='La preparación no terminó';notice(error.message,'error');}
  finally{$('automationPreviewButton').textContent='Preparar vista previa masiva';updateAutomationForm({invalidate:false});}
}
async function executeAutomation(){
  if(!state.automationPreview)return;const operations=state.automationPreview.selection.operations;const action=[operations.writeSftp&&'editar los archivos SFTP',operations.sendApi&&'enviar promociones a producción'].filter(Boolean).join(' y ');
  if(!window.confirm(`Se procederá a ${action}. ¿Continuar con la vista previa confirmada?`))return;
  clearNotice();$('automationExecuteButton').disabled=true;$('automationExecuteButton').textContent='Ejecutando…';$('automationStatus').textContent='Operación en curso. No cierres esta página…';
  try{
    const result=await api('/api/sftp-automation/execute',{method:'POST',body:JSON.stringify({previewId:state.automationPreview.previewId,confirmed:true})});
    if(result.api?.results)captureTaskEntries(result.api);
    const incidents=Number(result.sftp?.failedFiles||0)+Number(result.api?.rejectedBatches||0)+Number(result.api?.unknownBatches||0)+Number(result.api?.skippedAuthentication||0)+Number(result.api?.skippedAfterWriteFailure||0);
    $('automationResult').classList.remove('hidden');$('automationResult').innerHTML=`<strong>${incidents?'Operación terminada con incidencias':'Operación completada'}</strong><br>SFTP: ${Number(result.sftp?.updatedFiles||0).toLocaleString()} actualizados · ${Number(result.sftp?.failedFiles||0).toLocaleString()} fallidos<br>API: ${Number(result.api?.acceptedBatches||0).toLocaleString()} aceptados · ${Number(result.api?.rejectedBatches||0).toLocaleString()} rechazados · ${Number(result.api?.unknownBatches||0).toLocaleString()} desconocidos · ${Number(result.api?.skippedAuthentication||0).toLocaleString()} sin autenticación<br><small>${escapeHtml(result.outputDirectory||'')}</small>`;
    $('automationStatus').textContent=incidents?'Finalizó con incidencias; revisa el resultado y la auditoría.':'Finalizó correctamente.';notice(incidents?'La operación continuó después de errores aislados. Revisa el detalle.':'La operación terminó correctamente.',incidents?'error':'success');
  }catch(error){$('automationResult').classList.remove('hidden');$('automationResult').textContent=error.outputDirectory?`${error.message} · Auditoría: ${error.outputDirectory}`:error.message;$('automationStatus').textContent='La operación falló';notice(error.message,'error');}
  finally{$('automationExecuteButton').textContent='Ejecutar operación';}
}

function storeLabel(store){
  const details=[store.city,store.appShopId&&`App Shop ID ${store.appShopId}`,store.shopId&&`Shop ID ${store.shopId}`].filter(Boolean).join(' · ');
  return `${store.name}${details?` · ${details}`:''}${store.tokenConfigured?' · token en .env':''}`;
}
function currentSftpAccount(){return state.sftpAccounts.find(account=>account.id===state.sftpAccountId)||null;}
function brandStores(){return state.config.stores.filter(store=>store.sftpAccountId===state.sftpAccountId);}
function isSftpSource(){return document.querySelector('#sourceMode [data-source="sftp"]')?.classList.contains('active')===true;}
function clearLoadedSource(message='Ningún archivo cargado'){
  state.sessionId=null;state.promotions=[];state.selected.clear();state.activityActions.clear();state.preview=null;state.itemIdReplacements.clear();state.duplicateItemConflicts=[];state.duplicateItemChoices.clear();state.zeroDiscountItems=[];state.zeroDiscountPolicy='';state.unsupportedPercentageItems=[];state.unsupportedPercentagePolicy='';
  $('fileInput').value='';$('fileStatus').textContent=message;$('stats').innerHTML='<span>0 promociones</span><span>0 productos</span>';
  $('previewPanel').classList.add('hidden');renderTable();updateSelection();
}
function updateSourceAvailability(){
  const enabled=Boolean(currentSftpAccount());
  $('fileInput').disabled=!enabled;$('dropzone').classList.toggle('disabled',!enabled);$('dropzone').setAttribute('aria-disabled',String(!enabled));
  $('sftpSearch').disabled=!enabled;$('sftpFileSelect').disabled=!enabled;$('refreshSftp').disabled=!enabled;
  $('downloadSftpFile').disabled=!enabled||!$('sftpFileSelect').value;
  if(!enabled){$('loadSftpFile').disabled=true;if(!state.sessionId)$('fileStatus').textContent='Selecciona una marca antes de cargar el archivo';}
}
function visibleStores(){
  const query=$('storeSearch').value.trim().toLocaleLowerCase('es');
  const city=$('storeCityFilter').value;
  return brandStores().filter(store=>(!city||store.city===city)&&(!query||[store.name,store.city,store.shopId,store.appShopId].some(value=>String(value||'').toLocaleLowerCase('es').includes(query))));
}
function renderStores(){
  const stores=visibleStores();
  $('storePicker').innerHTML=stores.length
    ?stores.map(store=>`<label class="store-choice"><input type="checkbox" value="${escapeHtml(store.id)}" ${state.selectedStores.has(store.id)?'checked':''}><span><strong>${escapeHtml(store.name)}</strong><small>${store.city?`<span class="city-label">${escapeHtml(store.city)}</span> · `:''}App Shop ID ${escapeHtml(store.appShopId)} · Shop ID ${escapeHtml(store.shopId)}</small></span></label>`).join('')
    :`<div class="empty">${currentSftpAccount()?'Esta marca no tiene tiendas coincidentes o asociadas.':'Selecciona una marca para ver sus tiendas.'}</div>`;
  document.querySelectorAll('#storePicker input').forEach(input=>input.addEventListener('change',()=>{input.checked?state.selectedStores.add(input.value):state.selectedStores.delete(input.value);updateDestination();}));
  updateDestination();
}
function updateDestination(){
  const all=state.destinationMode==='all';
  const account=currentSftpAccount();const stores=brandStores();const brandName=account?.brandName||account?.name||'la marca';
  $('selectedDestinationControls').classList.toggle('hidden',all);
  $('allDestinationSummary').classList.toggle('hidden',!all);
  $('destinationCount').textContent=`${state.selectedStores.size.toLocaleString()} seleccionada${state.selectedStores.size===1?'':'s'}`;
  $('allStoreCount').textContent=`Marca completa: ${brandName} · ${stores.length.toLocaleString()} tiendas`;
  $('authTokenField').classList.toggle('hidden',all||state.selectedStores.size!==1);
  if(all||state.selectedStores.size!==1)$('authToken').value='';
  updateSelection();
}

function taskStores(){
  const query=$('taskStoreSearch').value.trim().toLocaleLowerCase('es');
  const city=$('taskCityFilter').value;
  return state.config.stores.filter(store=>(!city||store.city===city)&&(!query||[store.name,store.city,store.shopId,store.appShopId].some(value=>String(value||'').toLocaleLowerCase('es').includes(query))));
}
function renderTaskStores(){
  const stores=taskStores().slice(0,100);
  $('taskStorePicker').innerHTML=stores.length?stores.map(store=>`<button class="task-store-option ${state.taskStoreId===store.id?'active':''}" type="button" role="option" aria-selected="${state.taskStoreId===store.id}" data-store-id="${escapeHtml(store.id)}"><span><strong>${escapeHtml(store.name)}</strong><small>App Shop ID ${escapeHtml(store.appShopId)} · Shop ID ${escapeHtml(store.shopId)}</small></span><span class="task-city">${escapeHtml(store.city||'Sin ciudad')}</span></button>`).join(''):'<div class="empty">No hay tiendas con esos filtros.</div>';
  document.querySelectorAll('#taskStorePicker [data-store-id]').forEach(button=>button.addEventListener('click',()=>{
    state.taskStoreId=button.dataset.storeId;
    const store=state.config.stores.find(candidate=>candidate.id===state.taskStoreId);
    $('taskStoreSelected').textContent=store?`Seleccionada: ${storeLabel(store)}`:'Selecciona una tienda.';
    renderTaskStores();
    updateTaskQueryState();
  }));
}
function updateTaskQueryState(){$('queryButton').disabled=!state.taskStoreId||!/^\d{1,64}$/.test($('taskIdInput').value.trim());}

function readSavedTaskEntries(){
  try{
    const entries=JSON.parse(localStorage.getItem(TASK_QUEUE_KEY)||'[]');
    if(!Array.isArray(entries))return [];
    return entries.slice(0,2000).filter(entry=>entry&&/^\d{1,64}$/.test(String(entry.taskId||''))&&typeof entry.storeId==='string');
  }catch{return [];}
}
function saveTaskEntries(){
  try{localStorage.setItem(TASK_QUEUE_KEY,JSON.stringify(state.taskEntries));}catch{}
}

function exactTaskId(result){
  const candidates=[result?.response?.data?.taskID,result?.response?.data?.taskId,result?.response?.taskID,result?.response?.taskId];
  const value=candidates.find(candidate=>/^\d{1,64}$/.test(String(candidate??'')));
  return value===undefined?'':String(value);
}
function taskKey(entry){return `${entry.storeId}:${entry.taskId}`;}
function taskDetailSummary(result){
  if(result?.detailSummary)return result.detailSummary;
  const details=Array.isArray(result?.response?.data?.details)?result.response.data.details:[];let code200=0;const codes={};
  for(const detail of details){const code=String(detail?.errno??'sin código');codes[code]=(codes[code]||0)+1;if(Number(detail?.errno)===200)code200+=1;}
  return {total:details.length,code200,incidents:details.length-code200,codes};
}
function taskDisplayStatus(result){
  if(!result)return {key:'pending',label:'Sin consultar'};
  if(result.queryStatus!=='queried')return {key:'error',label:result.queryStatus==='api_error'?'Error API':result.queryStatus==='http_error'?`HTTP ${result.httpStatus}`:'Error de red'};
  const summary=taskDetailSummary(result);
  if(summary.incidents>0)return {key:'incident',label:`${Number(summary.code200).toLocaleString()} código 200 · ${Number(summary.incidents).toLocaleString()} incidencias`};
  if(summary.total>0)return {key:'queried',label:`${Number(summary.code200).toLocaleString()} sin incidencias`};
  const data=result.response?.data;
  const value=data?.status??data?.task_status??data?.taskStatus??data?.result??data?.message;
  const detail=value===undefined?'Consultado':typeof value==='object'?JSON.stringify(value):String(value);
  return {key:'queried',label:detail.slice(0,80)};
}
function scheduleBulkTaskRender(){
  if(state.taskRenderTimer)return;
  state.taskRenderTimer=setTimeout(()=>{state.taskRenderTimer=null;renderBulkTasks();},180);
}
function formatTaskDuration(milliseconds){
  const seconds=Math.max(0,Math.round(Number(milliseconds||0)/1000));
  if(seconds<60)return `${seconds} s`;
  const minutes=Math.floor(seconds/60);const remainder=seconds%60;
  return `${minutes} min${remainder?` ${remainder} s`:''}`;
}
function updateBulkTaskProgress(job){
  const panel=$('bulkTaskProgress');panel.classList.remove('hidden','complete','failed');
  const total=Math.max(0,Number(job.total||0));const completed=Math.max(0,Number(job.completed||0));
  let percent=0;let stage='Preparando consulta';let detail=`${completed.toLocaleString()} de ${total.toLocaleString()}`;
  if(job.phase==='authentication'){
    const batchesTotal=Math.max(1,Number(job.authBatchesTotal||1));const batchesDone=Math.max(0,Number(job.authBatchesDone||0));
    percent=Math.round(Math.min(1,batchesDone/batchesTotal)*15);stage='Resolviendo credenciales';detail=`Lote ${batchesDone.toLocaleString()} de ${batchesTotal.toLocaleString()} · ${Number(job.authStoresDone||0).toLocaleString()} de ${Number(job.authStoresTotal||0).toLocaleString()} tiendas`;
  }else if(job.phase==='querying'){
    percent=Math.round(15+(total?Math.min(1,completed/total)*85:85));stage='Consultando Task IDs';detail=`${completed.toLocaleString()} de ${total.toLocaleString()} · ${Number(job.concurrency||0).toLocaleString()} en paralelo`;
  }else if(job.phase==='complete'){
    percent=100;stage='Consulta completada';detail=`${completed.toLocaleString()} de ${total.toLocaleString()}`;panel.classList.add('complete');
  }else if(job.phase==='failed'){
    stage='La consulta no pudo continuar';detail=job.error||`${completed.toLocaleString()} de ${total.toLocaleString()}`;panel.classList.add('failed');
    percent=total?Math.round(Math.min(1,completed/total)*100):0;
  }
  $('bulkTaskProgressStage').textContent=stage;$('bulkTaskProgressDetail').textContent=detail;$('bulkTaskProgressPercent').textContent=`${percent}%`;
  $('bulkTaskProgressFill').style.width=`${percent}%`;$('bulkTaskProgressBar').setAttribute('aria-valuenow',String(percent));
  $('bulkTaskProgressCounts').textContent=`${completed.toLocaleString()} terminadas · ${Number(job.queried||0).toLocaleString()} consultadas · ${Number(job.errors||0).toLocaleString()} errores`;
  let timing=`Tiempo transcurrido: ${formatTaskDuration(job.elapsedMs)}`;
  if(job.phase==='querying'&&completed>=8&&job.queryElapsedMs>0){const remaining=(job.queryElapsedMs/completed)*Math.max(0,total-completed);timing=`Estimado restante: ${formatTaskDuration(remaining)}`;}
  if(job.phase==='complete')timing=`Finalizó en ${formatTaskDuration(job.elapsedMs)}`;
  $('bulkTaskProgressEta').textContent=timing;
}
async function loadBulkTaskRaw(details){
  if(!details.open)return;const key=details.dataset.taskKey;const pre=details.querySelector('pre');if(!key||!pre||pre.dataset.loaded==='true')return;
  const result=state.taskResults.find(candidate=>taskKey(candidate)===key);const entry=state.taskEntries.find(candidate=>taskKey(candidate)===key);
  if(result?.response){pre.textContent=JSON.stringify(result,null,2);pre.dataset.loaded='true';return;}
  if(state.taskRawResults.has(key)){pre.textContent=JSON.stringify(state.taskRawResults.get(key),null,2);pre.dataset.loaded='true';return;}
  if(!state.taskQueryJobId||!Number.isSafeInteger(result?.jobIndex)){pre.textContent=JSON.stringify(result||entry,null,2);pre.dataset.loaded='true';return;}
  pre.textContent='Cargando respuesta original…';
  try{const raw=await api(`/api/query-tasks/jobs/${encodeURIComponent(state.taskQueryJobId)}/results/${result.jobIndex}`);state.taskRawResults.set(key,raw);pre.textContent=JSON.stringify(raw,null,2);pre.dataset.loaded='true';}
  catch(error){pre.textContent=error.message;}
}
function renderBulkTasks(){
  $('trackingBadge').textContent=state.taskEntries.length.toLocaleString();
  $('trackingBadge').classList.toggle('hidden',!state.taskEntries.length);
  $('trackingEmpty').classList.toggle('hidden',state.taskEntries.length>0);
  renderActivity();
  const panel=$('bulkTaskPanel');
  if(!state.taskEntries.length){panel.classList.add('hidden');return;}
  panel.classList.remove('hidden');$('bulkTaskCount').textContent=`${state.taskEntries.length.toLocaleString()} consulta${state.taskEntries.length===1?'':'s'}`;
  $('queryAllTasks').disabled=state.taskQueryRunning;$('clearTaskQueue').disabled=state.taskQueryRunning;
  const resultByKey=new Map(state.taskResults.map(result=>[taskKey(result),result]));
  const query=$('bulkTaskSearch').value.trim().toLocaleLowerCase('es');const statusFilter=$('bulkTaskStatus').value;
  const rows=state.taskEntries.map(entry=>({entry,result:resultByKey.get(taskKey(entry))})).filter(({entry,result})=>{
    const status=taskDisplayStatus(result);
    return (!statusFilter||status.key===statusFilter)&&(!query||[entry.storeName,entry.storeId,entry.taskId,entry.batchNumber].some(value=>String(value??'').toLocaleLowerCase('es').includes(query)));
  });
  const statuses=state.taskEntries.map(entry=>taskDisplayStatus(resultByKey.get(taskKey(entry))).key);
  const queried=statuses.filter(status=>status==='queried'||status==='incident').length;
  const incidents=statuses.filter(status=>status==='incident').length;
  const errors=state.taskEntries.filter(entry=>taskDisplayStatus(resultByKey.get(taskKey(entry))).key==='error').length;
  const pending=state.taskEntries.length-queried-errors;
  const pageSize=state.taskPageSize;const pageCount=Math.max(1,Math.ceil(rows.length/pageSize));state.taskPage=Math.min(Math.max(1,state.taskPage),pageCount);
  const start=(state.taskPage-1)*pageSize;const pageRows=rows.slice(start,start+pageSize);
  $('bulkTaskSummary').textContent=`${queried.toLocaleString()} consultados · ${incidents.toLocaleString()} con incidencias · ${errors.toLocaleString()} errores de consulta · ${pending.toLocaleString()} pendientes · ${rows.length.toLocaleString()} coinciden con los filtros`;
  $('bulkTaskTable').innerHTML=pageRows.length?pageRows.map(({entry,result})=>{
    const status=taskDisplayStatus(result);const key=taskKey(entry);
    return `<tr><td><strong>${escapeHtml(entry.storeName||entry.storeId)}</strong><br><small>${escapeHtml(entry.storeId)}</small></td><td>${escapeHtml(entry.batchNumber??'—')}</td><td><code>${escapeHtml(entry.taskId)}</code></td><td><span class="task-query-status ${status.key}">${escapeHtml(status.label)}</span></td><td><details data-task-key="${escapeHtml(key)}"><summary>Ver JSON</summary><pre>Carga bajo demanda para mantener la pantalla ligera.</pre></details></td></tr>`;
  }).join(''):'<tr><td colspan="5" class="empty">No hay consultas con estos filtros.</td></tr>';
  $('bulkTaskTable').querySelectorAll('details[data-task-key]').forEach(details=>details.addEventListener('toggle',()=>loadBulkTaskRaw(details)));
  const pagination=$('bulkTaskPagination');pagination.classList.toggle('hidden',rows.length<=pageSize);
  $('bulkTaskPageSummary').textContent=rows.length?`Página ${state.taskPage.toLocaleString()} de ${pageCount.toLocaleString()} · ${start+1}-${Math.min(start+pageSize,rows.length)} de ${rows.length.toLocaleString()}`:'Sin resultados';
  $('bulkTaskPrevious').disabled=state.taskPage<=1;$('bulkTaskNext').disabled=state.taskPage>=pageCount;
}
function captureTaskEntries(sendResult){
  const seen=new Set();state.taskEntries=[];state.taskResults=[];state.taskRawResults.clear();state.taskQueryJobId='';state.taskPage=1;
  for(const result of sendResult.results||[]){
    const taskId=exactTaskId(result);const storeId=String(result.storeId||'');const key=`${storeId}:${taskId}`;
    if(!taskId||!storeId||seen.has(key))continue;
    seen.add(key);state.taskEntries.push({storeId,storeName:result.storeName||storeId,batchNumber:result.batchNumber??null,taskId});
  }
  saveTaskEntries();
  renderBulkTasks();
  const first=state.taskEntries[0];
  if(first){
    state.taskStoreId=first.storeId;$('taskIdInput').value=first.taskId;
    const store=state.config.stores.find(candidate=>candidate.id===first.storeId);
    $('taskStoreSelected').textContent=store?`Seleccionada: ${storeLabel(store)}`:`Seleccionada: ${first.storeName}`;
    renderTaskStores();updateTaskQueryState();
  }
}
function clearTaskQueue(){
  state.taskEntries=[];state.taskResults=[];state.taskRawResults.clear();state.taskQueryJobId='';state.taskPage=1;saveTaskEntries();renderBulkTasks();
  $('bulkTaskProgress').classList.add('hidden');$('bulkTaskPagination').classList.add('hidden');
  notice('Se limpió la lista local de Task ID.');
}

function cityOptions(stores=state.config.stores){
  const cities=[...new Set(stores.map(store=>store.city).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'es'));
  return '<option value="">Todas las ciudades</option>'+cities.map(city=>`<option value="${escapeHtml(city)}">${escapeHtml(city)}</option>`).join('');
}

function syncSelectedBrand({applyRule=true}={}){
  const account=currentSftpAccount();const stores=brandStores();const brandName=account?.brandName||account?.name||'la marca';
  state.selectedStores.clear();state.preview=null;$('previewPanel').classList.add('hidden');
  $('storeSearch').value='';$('storeCityFilter').innerHTML=cityOptions(stores);
  $('storeSearchLabel').textContent=`Buscar tienda · ${brandName}`;
  $('storePicker').setAttribute('aria-label',`Tiendas de ${brandName}`);
  if(applyRule&&account){
    const expectedId=/soriana/i.test(`${account.name} ${account.brandName||''}`)?'soriana':`sftp:${account.id}`;
    if(state.config.defaultRuleProfiles?.some(profile=>profile.id===expectedId))state.defaultRuleId=expectedId;
    renderDefaultRuleProfiles();applyDefaultRule();
  }
  renderStores();updateSourceAvailability();updateSelection();
}

function readSavedDefaultRules(){
  try{
    const rules=JSON.parse(localStorage.getItem(DEFAULT_RULES_KEY)||'{}');
    return rules&&typeof rules==='object'&&!Array.isArray(rules)?rules:{};
  }catch{return {};}
}
function writeSavedDefaultRules(rules){
  try{localStorage.setItem(DEFAULT_RULES_KEY,JSON.stringify(rules));return true;}
  catch{return false;}
}
function configuredDefaultRule(id){
  const profile=state.config?.defaultRuleProfiles?.find(candidate=>candidate.id===id);
  if(!profile)return null;
  const saved=readSavedDefaultRules()[id]||{};
  const savedItemIdType=Number(saved.appItemIdType);
  return {...profile,activityAction:1,appItemIdType:[0,1].includes(savedItemIdType)?savedItemIdType:Number(profile.appItemIdType)===0?0:1};
}
function renderDefaultRuleProfiles(){
  const profiles=state.config?.defaultRuleProfiles||[];
  $('defaultRuleProfile').innerHTML=profiles.map(profile=>`<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)}</option>`).join('');
  if(!profiles.some(profile=>profile.id===state.defaultRuleId))state.defaultRuleId=profiles[0]?.id||'';
  $('defaultRuleProfile').value=state.defaultRuleId;
}
function updateDefaultRuleSummary(dirty=false){
  const rule=configuredDefaultRule(state.defaultRuleId);
  if(!rule){$('defaultRuleSummary').textContent='Sin regla aplicada.';$('saveDefaultRule').disabled=true;return;}
  const currentType=Number($('appItemIdType').value);
  const stopping=state.activityAction===2;
  $('defaultRuleSummary').textContent=stopping
    ?`${rule.name} · Detener es temporal y no reemplaza la regla predeterminada.`
    :`${dirty?'Cambio sin guardar · ':''}${rule.name} · Crear o actualizar · ${currentType===1?'UPC':'app_item_id'}`;
  $('defaultRuleSummary').classList.toggle('dirty',dirty||stopping);
  $('saveDefaultRule').disabled=stopping;
}
function applyDefaultRule(){
  const rule=configuredDefaultRule(state.defaultRuleId);
  if(!rule)return;
  state.activityAction=1;
  $('appItemIdType').value=String(rule.appItemIdType);
  updateActivityAction();
  updateDefaultRuleSummary(false);
}
function saveDefaultRule(){
  if(state.activityAction!==1){notice('La acción Detener es temporal y no puede guardarse como regla predeterminada.','error');return;}
  const rules=readSavedDefaultRules();
  rules[state.defaultRuleId]={activityAction:1,appItemIdType:Number($('appItemIdType').value)};
  if(!writeSavedDefaultRules(rules)){notice('El navegador no permitió guardar la regla local.','error');return;}
  updateDefaultRuleSummary(false);
  const rule=configuredDefaultRule(state.defaultRuleId);
  notice(`Regla de ${rule.name} guardada: ${rule.appItemIdType===1?'UPC':'app_item_id'}.`);
}
function resetDefaultRule(){
  const rules=readSavedDefaultRules();
  delete rules[state.defaultRuleId];
  if(!writeSavedDefaultRules(rules)){notice('El navegador no permitió restablecer la regla local.','error');return;}
  applyDefaultRule();
  const rule=configuredDefaultRule(state.defaultRuleId);
  notice(`Regla de ${rule.name} restablecida: ${rule.appItemIdType===1?'UPC':'app_item_id'}.`);
}

async function initialize(){
  try{
    state.config=await api('/api/config');
    state.sftpAccounts=Array.isArray(state.config.sftpAccounts)?state.config.sftpAccounts:[];
    state.sftpAccountId='';
    const accountOptions=state.sftpAccounts.length
      ?'<option value="">Selecciona una marca…</option>'+state.sftpAccounts.map(account=>{const brand=account.brandName&&account.brandName!==account.name?`${account.brandName} · `:'';return `<option value="${escapeHtml(account.id)}">${escapeHtml(brand+account.name)} · ${Number(account.storeCount||0).toLocaleString()} tiendas${account.filePattern?` · ${escapeHtml(account.filePattern)}`:''}</option>`;}).join('')
      :'<option value="">Sin cuentas configuradas</option>';
    $('sftpAccountSelect').innerHTML=accountOptions;
    $('automationAccountSelect').innerHTML=accountOptions;
    $('sftpAccountSelect').value=state.sftpAccountId;
    renderDefaultRuleProfiles();
    $('docBatchSize').textContent=Number(state.config.batchSize||0).toLocaleString();
    $('docMaxItems').textContent=Number(state.config.maxItemsPerBatch||0).toLocaleString();
    const endpoint=state.config.apiUrl||'PROMO_API_URL no configurado';
    $('apiEndpoint').textContent=endpoint;
    $('apiEndpoint').style.fontSize=endpoint.length>52?'11px':'';
    $('taskCityFilter').innerHTML=cityOptions();
    syncSelectedBrand();
    renderTaskStores();
    updateTaskQueryState();
    state.taskEntries=readSavedTaskEntries().filter(entry=>state.config.stores.some(store=>store.id===entry.storeId));
    renderBulkTasks();
    const sftpButton=document.querySelector('[data-source="sftp"]');
    sftpButton.disabled=!state.config.sftpConfigured||!state.sftpAccounts.length;
    if(sftpButton.disabled)sftpButton.title='No hay cuentas SFTP de promociones disponibles';
    $('automationPreviewButton').disabled=true;
    if(ui.view==='diagnostics')loadDiagnostics(false);
  }catch(error){notice(error.message,'error');}
}

function applyLoadedFile(result,sourceLabel){
  state.sessionId=result.sessionId;state.promotions=result.promotions;state.selected.clear();state.activityActions.clear();state.preview=null;state.itemIdReplacements.clear();state.duplicateItemConflicts=result.duplicateItemConflicts||[];state.duplicateItemChoices.clear();state.zeroDiscountItems=result.zeroDiscountItems||[];state.zeroDiscountPolicy='';state.unsupportedPercentageItems=result.unsupportedPercentageItems||[];state.unsupportedPercentagePolicy='';
  $('fileStatus').textContent=`${result.fileName} · ${result.promotions.length} promociones`;
  $('stats').innerHTML=`<span>${result.stats.promotions.toLocaleString()} promociones</span><span>${result.stats.items.toLocaleString()} productos</span>`;
  $('previewPanel').classList.add('hidden');
  renderTable();updateSelection();
  const conflicts=state.duplicateItemConflicts.length;const zeroDiscounts=state.zeroDiscountItems.length;const unsupportedPercentages=state.unsupportedPercentageItems.length;
  notice(`${sourceLabel}: ${result.stats.promotions} promociones y ${result.stats.items} productos asociados.${conflicts?` ${conflicts} UPC repetido${conflicts===1?' requiere':'s requieren'} una elección.`:''}${zeroDiscounts?` ${zeroDiscounts} fila${zeroDiscounts===1?'':'s'} con 0% requiere${zeroDiscounts===1?'':'n'} una decisión.`:''}${unsupportedPercentages?` ${unsupportedPercentages} producto${unsupportedPercentages===1?' tiene':'s tienen'} un porcentaje rechazado por DiDi y puede${unsupportedPercentages===1?'':'n'} omitirse.`:''}`,conflicts||zeroDiscounts||unsupportedPercentages?'warning':'success');
}

async function loadFile(file){
  if(!currentSftpAccount()){$('fileInput').value='';notice('Selecciona la marca antes de cargar un archivo local.','error');return;}
  clearNotice();$('fileStatus').textContent=`Leyendo ${file.name}…`;$('previewButton').disabled=true;
  try{
    const bytes=new Uint8Array(await file.arrayBuffer());let binary='';const chunk=0x8000;
    for(let i=0;i<bytes.length;i+=chunk)binary+=String.fromCharCode(...bytes.subarray(i,i+chunk));
    const result=await api('/api/files',{method:'POST',body:JSON.stringify({fileName:file.name,contentBase64:btoa(binary)})});
    applyLoadedFile(result,'Archivo local validado');
  }catch(error){$('fileStatus').textContent='No se pudo cargar el archivo';notice(error.message,'error');}
}

async function loadSftpFiles(force=false){
  const requestId=++ui.sftpSearchRequest;const search=$('sftpSearch').value.trim();
  const account=state.sftpAccounts.find(candidate=>candidate.id===state.sftpAccountId);
  if(!account){$('sftpStatus').textContent='Selecciona una marca / cuenta SFTP';return;}
  const isCurrent=()=>requestId===ui.sftpSearchRequest&&state.sftpAccountId===account.id&&$('sftpSearch').value.trim()===search;
  $('refreshSftp').disabled=true;$('sftpStatus').textContent=`Consultando ${account.name}…`;
  try{
    const query=encodeURIComponent(search);
    const accountId=encodeURIComponent(account.id);
    const result=await api(`/api/sftp-files?accountId=${accountId}&q=${query}&limit=500${force?'&refresh=1':''}`);
    if(!isCurrent())return;
    state.sftpFiles=result.files;
    $('sftpFileSelect').innerHTML=result.files.length
      ?result.files.map(file=>{const details=[file.sourceShopId,file.fileTimestamp||file.modifiedAt,formatBytes(file.size)].filter(Boolean).map(escapeHtml).join(' · ');return `<option value="${escapeHtml(file.name)}" ${file.loadable?'':'disabled'}>${details?`${details} · `:''}${escapeHtml(file.name)}</option>`;}).join('')
      :'<option value="">Sin archivos coincidentes</option>';
    $('sftpStatus').textContent=`${account.name} · ${result.files.length.toLocaleString()} mostrados de ${result.total.toLocaleString()} coincidencias`;
    $('downloadSftpFile').disabled=!$('sftpFileSelect').value;$('loadSftpFile').disabled=!$('sftpFileSelect').value;
  }catch(error){if(!isCurrent())return;state.sftpFiles=[];$('sftpFileSelect').innerHTML='<option value="">No disponible</option>';$('downloadSftpFile').disabled=true;$('loadSftpFile').disabled=true;$('sftpStatus').textContent='No se pudo consultar';notice(error.message,'error');}
  finally{if(requestId===ui.sftpSearchRequest)$('refreshSftp').disabled=!currentSftpAccount();}
}

async function downloadSftpFile(accountId,fileName){
  const params=new URLSearchParams({accountId,fileName});
  const token=localStorage.getItem('token');
  if(!token)throw new Error('Inicia sesión como administrador en Tequila para descargar.');
  const response=await fetch(`/guaro/api/promo-manager/sftp-files/download?${params}`,{headers:{Authorization:`Bearer ${token}`}});
  if(!response.ok){const data=await response.json().catch(()=>({}));throw new Error(data.error||`HTTP ${response.status}`);}
  const objectUrl=URL.createObjectURL(await response.blob());
  const link=document.createElement('a');link.href=objectUrl;link.download=fileName;document.body.appendChild(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(objectUrl),1000);
}

async function downloadDiagnosticFile(button){
  const accountId=button.dataset.accountId;const fileName=button.dataset.fileName;if(!accountId||!fileName)return;
  clearNotice();button.disabled=true;button.textContent='Descargando…';
  try{await downloadSftpFile(accountId,fileName);notice(`Archivo diagnosticado descargado: ${fileName}`);}
  catch(error){notice(error.message,'error');}
  finally{button.disabled=false;button.textContent='Descargar archivo';}
}

async function downloadSelectedSftp(){
  const fileName=$('sftpFileSelect').value;if(!fileName)return;
  const account=state.sftpAccounts.find(candidate=>candidate.id===state.sftpAccountId);if(!account)return;
  clearNotice();$('downloadSftpFile').disabled=true;$('downloadSftpFile').textContent='Descargando…';
  try{
    await downloadSftpFile(account.id,fileName);
    $('sftpStatus').textContent=`${account.name} · descargado: ${fileName}`;
  }catch(error){notice(error.message,'error');}
  finally{$('downloadSftpFile').textContent='Descargar archivo';$('downloadSftpFile').disabled=!currentSftpAccount()||!$('sftpFileSelect').value;}
}

async function loadSelectedSftp(){
  const fileName=$('sftpFileSelect').value;if(!fileName)return;
  const account=state.sftpAccounts.find(candidate=>candidate.id===state.sftpAccountId);if(!account)return;
  clearNotice();$('loadSftpFile').disabled=true;$('loadSftpFile').textContent='Descargando…';
  try{
    const result=await api('/api/sftp-files/load',{method:'POST',body:JSON.stringify({fileName,accountId:account.id})});
    applyLoadedFile(result,`Archivo ${account.name} validado`);$('sftpStatus').textContent=`${account.name} · cargado: ${result.fileName}`;
  }catch(error){notice(error.message,'error');}
  finally{$('loadSftpFile').textContent='Cargar archivo seleccionado';$('loadSftpFile').disabled=!currentSftpAccount()||!$('sftpFileSelect').value;}
}

function activeTypes(){return [...document.querySelectorAll('.type-filters input:checked')].map(input=>Number(input.value));}
function visiblePromotions(){
  const query=$('searchInput').value.trim().toLocaleLowerCase('es');const types=activeTypes();
  return state.promotions.filter(p=>types.includes(p.type)&&(!query||p.activityId.toLowerCase().includes(query)||p.name.toLocaleLowerCase('es').includes(query)));
}
function promotionAction(activityId){return state.activityActions.get(String(activityId))??state.activityAction;}
function renderTable(){
  const rows=visiblePromotions();
  const empty=state.sessionId?'<strong>No hay coincidencias</strong><p>Prueba otro nombre, Activity ID o tipo de promoción.</p>':'<span class="empty-symbol" aria-hidden="true">↥</span><strong>Tu catálogo comienza aquí</strong><p>Elige una marca y carga un archivo desde tu computadora o su SFTP. Aquí podrás buscar y seleccionar las promociones.</p>';
  $('promoTable').innerHTML=rows.length?rows.map(p=>`<tr><td><input type="checkbox" aria-label="Seleccionar promoción ${escapeHtml(p.activityId)}" data-id="${escapeHtml(p.activityId)}" ${state.selected.has(p.activityId)?'checked':''}></td><td>${escapeHtml(p.activityId)}</td><td>${escapeHtml(p.name)}</td><td><span class="pill">${p.type}</span></td><td><select class="row-action-select" data-action-id="${escapeHtml(p.activityId)}" aria-label="Acción para ${escapeHtml(p.activityId)}"><option value="1" ${promotionAction(p.activityId)===1?'selected':''}>1 · Crear</option><option value="2" ${promotionAction(p.activityId)===2?'selected':''}>2 · Detener</option></select></td><td>${formatDate(p.startDate)} → ${formatDate(p.endDate)}</td><td>${p.items.toLocaleString()}</td></tr>`).join(''):`<tr><td colspan="7" class="empty catalog-empty">${empty}</td></tr>`;
  $('selectVisible').disabled=!rows.length;
  document.querySelectorAll('#promoTable input').forEach(input=>input.addEventListener('change',()=>{input.checked?state.selected.add(input.dataset.id):state.selected.delete(input.dataset.id);updateSelection();}));
  document.querySelectorAll('#promoTable [data-action-id]').forEach(select=>select.addEventListener('change',()=>{state.activityActions.set(select.dataset.actionId,Number(select.value));state.preview=null;$('previewPanel').classList.add('hidden');renderTable();updateSelection();}));
}
function selectedItemIds(){
  return new Set(state.promotions.filter(p=>state.selected.has(p.activityId)&&promotionAction(p.activityId)===1).flatMap(p=>p.itemIds||[]).map(String));
}
function updateUpcAddState(){
  const available=selectedItemIds();
  const original=$('upcOriginal').value.trim();const replacement=$('upcReplacement').value.trim();
  $('addUpcReplacement').disabled=!available.has(original)||!/^\d{1,64}$/.test(replacement)||original===replacement;
}
function renderUpcEditor(){
  const available=selectedItemIds();
  $('upcOptions').innerHTML=[...available].sort().map(id=>`<option value="${escapeHtml(id)}"></option>`).join('');
  $('upcAvailability').textContent=available.size?`${available.size.toLocaleString()} UPC disponibles en las promociones seleccionadas.`:'Selecciona promociones para ver sus productos.';
  $('upcReplacementList').innerHTML=state.itemIdReplacements.size?[...state.itemIdReplacements].map(([originalId,sentId])=>`<div class="upc-replacement"><span>${escapeHtml(originalId)} → ${escapeHtml(sentId)}</span><button type="button" data-remove-upc="${escapeHtml(originalId)}" aria-label="Quitar cambio de UPC ${escapeHtml(originalId)}">Quitar</button></div>`).join(''):'';
  document.querySelectorAll('[data-remove-upc]').forEach(button=>button.addEventListener('click',()=>{state.itemIdReplacements.delete(button.dataset.removeUpc);renderUpcEditor();}));
  updateUpcAddState();
}
function addUpcReplacement(){
  const originalId=$('upcOriginal').value.trim();const sentId=$('upcReplacement').value.trim();const available=selectedItemIds();
  if(!available.has(originalId)){notice('El UPC original no existe en las promociones seleccionadas.','error');return;}
  if(!/^\d{1,64}$/.test(sentId)){notice('El UPC nuevo debe contener únicamente entre 1 y 64 dígitos.','error');return;}
  if(originalId===sentId){notice('El UPC nuevo debe ser diferente del actual.','error');return;}
  state.itemIdReplacements.set(originalId,sentId);$('upcOriginal').value='';$('upcReplacement').value='';renderUpcEditor();clearNotice();
}
function duplicateMechanic(item){
  if(item.discount_perc!==undefined)return `${item.discount_perc}% de descuento`;
  if(item.buy_num!==undefined)return `Compra ${item.buy_num}, recibe ${item.get_num}`;
  if(item.bxgy_x!==undefined){const cents=Number(item.bxgy_y);return `${item.bxgy_x} pieza${item.bxgy_x===1?'':'s'} por $${Math.trunc(cents/100)}.${String(cents%100).padStart(2,'0')}`;}
  return 'Mecánica sin detalle';
}
function requiredZeroDiscountItems(){
  return state.zeroDiscountItems.filter(item=>state.selected.has(String(item.activityId))&&promotionAction(item.activityId)===1&&activeTypes().includes(Number(item.activityType)));
}
function renderZeroDiscounts(){
  const items=state.zeroDiscountItems;$('zeroDiscountSection').classList.toggle('hidden',!items.length);
  if(!items.length)return;
  const required=requiredZeroDiscountItems();
  document.querySelectorAll('#zeroDiscountMode [data-zero-policy]').forEach(button=>button.classList.toggle('active',button.dataset.zeroPolicy===state.zeroDiscountPolicy));
  $('zeroDiscountHint').textContent=required.length
    ?`${required.length} producto${required.length===1?'':'s'} seleccionado${required.length===1?'':'s'} tiene${required.length===1?'':'n'} descuento de 0%. Elige una opción para continuar.`
    :`${items.length} fila${items.length===1?'':'s'} con descuento de 0% en el archivo; la decisión será obligatoria al seleccionar esas promociones.`;
}
function requiredUnsupportedPercentageItems(){
  return state.unsupportedPercentageItems.filter(item=>state.selected.has(String(item.activityId))&&promotionAction(item.activityId)===1&&activeTypes().includes(Number(item.activityType)));
}
function renderUnsupportedPercentages(){
  const items=state.unsupportedPercentageItems;$('unsupportedPercentageSection').classList.toggle('hidden',!items.length);
  if(!items.length)return;
  const required=requiredUnsupportedPercentageItems();
  document.querySelectorAll('#unsupportedPercentageMode [data-unsupported-percentage-policy]').forEach(button=>button.classList.toggle('active',button.dataset.unsupportedPercentagePolicy===state.unsupportedPercentagePolicy));
  const counts=[...required.reduce((values,item)=>{const key=String(item.discountPercentage);values.set(key,(values.get(key)||0)+1);return values;},new Map())]
    .sort(([left],[right])=>Number(left)-Number(right)).map(([value,count])=>`${count} con ${value}%`).join(' · ');
  $('unsupportedPercentageHint').textContent=required.length
    ?`${required.length} producto${required.length===1?'':'s'} seleccionado${required.length===1?' está':'s están'} fuera del rango de 5% a 99%${counts?` (${counts})`:''}. Elige omitirlos para continuar.`
    :`${items.length} producto${items.length===1?'':'s'} del archivo tiene${items.length===1?'':'n'} un porcentaje rechazado por DiDi. La omisión será obligatoria si seleccionas esas promociones.`;
}
function requiredDuplicateConflicts(){
  return state.duplicateItemConflicts.filter(conflict=>state.selected.has(String(conflict.activityId))&&promotionAction(conflict.activityId)===1&&activeTypes().includes(Number(conflict.activityType)));
}
function renderDuplicateItems(){
  const conflicts=state.duplicateItemConflicts;$('duplicateItemSection').classList.toggle('hidden',!conflicts.length);
  if(!conflicts.length){$('duplicateItemList').innerHTML='';return;}
  const required=new Set(requiredDuplicateConflicts().map(conflict=>String(conflict.id)));
  const unresolved=[...required].filter(id=>!state.duplicateItemChoices.has(id));
  $('duplicateItemHint').textContent=required.size?`${required.size-unresolved.length} de ${required.size} conflictos seleccionados para las promociones activas.`:'Selecciona una promoción para indicar qué conflictos deben resolverse.';
  $('duplicateItemList').innerHTML=conflicts.map(conflict=>{const id=String(conflict.id);const selected=state.duplicateItemChoices.get(id);const options=conflict.candidates.map(candidate=>`<option value="${candidate.row}" ${selected===candidate.row?'selected':''}>Fila ${candidate.row} · ${escapeHtml(duplicateMechanic(candidate.item))} · ${escapeHtml(candidate.activityName)}</option>`).join('');return `<label class="duplicate-item-card"><strong>UPC ${escapeHtml(conflict.sku)}</strong><small>${escapeHtml(conflict.activityId)} · tienda ${escapeHtml(conflict.sourceShopId)}${required.has(id)?' · elección obligatoria':' · no seleccionada'}</small><select data-duplicate-conflict="${escapeHtml(id)}" aria-invalid="${required.has(id)&&!selected}"><option value="">Elige la fila que se conserva…</option>${options}</select></label>`;}).join('');
  document.querySelectorAll('[data-duplicate-conflict]').forEach(select=>select.addEventListener('change',()=>{const id=select.dataset.duplicateConflict;if(select.value)state.duplicateItemChoices.set(id,Number(select.value));else state.duplicateItemChoices.delete(id);state.preview=null;$('previewPanel').classList.add('hidden');updateSelection();}));
}
function updateSelection(){
  $('selectionCount').textContent=`${state.selected.size} seleccionada${state.selected.size===1?'':'s'}`;
  $('clearSelection').disabled=!state.selected.size;
  const hasCreate=state.selected.size?[...state.selected].some(activityId=>promotionAction(activityId)===1):state.activityAction===1;
  document.querySelectorAll('#idMode button').forEach(button=>button.disabled=!hasCreate);
  $('groupPromotions').disabled=!hasCreate;$('groupOption').classList.toggle('disabled',!hasCreate);$('upcSection').classList.toggle('hidden',!hasCreate);
  if(!hasCreate){
    state.idMode='keep';document.querySelectorAll('#idMode button').forEach(button=>button.classList.toggle('active',button.dataset.mode==='keep'));
    $('manualIdField').classList.add('hidden');$('manualIdHint').classList.add('hidden');$('groupPromotions').checked=false;state.itemIdReplacements.clear();
  }
  const destinationReady=state.destinationMode==='all'?brandStores().length>0:state.selectedStores.size>0;
  const manualReady=state.idMode!=='manual'||/^\d{1,64}$/.test($('manualId').value.trim());
  const duplicatesReady=requiredDuplicateConflicts().every(conflict=>state.duplicateItemChoices.has(String(conflict.id)));
  const zeroDiscountReady=requiredZeroDiscountItems().length===0||['omit','keep'].includes(state.zeroDiscountPolicy);
  const unsupportedPercentagesReady=requiredUnsupportedPercentageItems().length===0||state.unsupportedPercentagePolicy==='omit';
  $('manualId').toggleAttribute('aria-invalid',state.idMode==='manual'&&!manualReady);
  $('previewButton').disabled=!state.sessionId||state.selected.size===0||!destinationReady||!manualReady||!duplicatesReady||!zeroDiscountReady||!unsupportedPercentagesReady;
  renderPreparationOverview(!state.sessionId?'Carga un archivo para comenzar.':!destinationReady?'Elige al menos una tienda destino.':!state.selected.size?'Selecciona las promociones del catálogo.':!manualReady?'Completa el Activity ID en Ajustes de la promoción.':!duplicatesReady?'Resuelve los UPC repetidos para continuar.':!zeroDiscountReady?'Elige qué hacer con los descuentos de 0%.':!unsupportedPercentagesReady?'Revisa los porcentajes no admitidos.':'Todo listo. Revisa el JSON antes de enviar.');
  renderZeroDiscounts();
  renderUnsupportedPercentages();
  renderDuplicateItems();
  renderUpcEditor();
}

function updateActivityAction(){
  const stopping=state.activityAction===2;
  document.querySelectorAll('#activityActionMode button').forEach(button=>button.classList.toggle('active',Number(button.dataset.action)===state.activityAction));
  $('activityActionHint').classList.toggle('stop-action',stopping);
  $('activityActionHint').textContent=stopping
    ?'Las promociones nuevas usarán la acción 2 (detener). Puedes cambiar cada fila a la acción 1 en el catálogo.'
    :'Las promociones nuevas usarán la acción 1 (crear o actualizar). Puedes cambiar cada fila a la acción 2 en el catálogo.';
  $('confirmSendText').textContent='Confirmo las acciones, tiendas, promociones, vigencias e identificadores.';
  state.preview=null;$('previewPanel').classList.add('hidden');renderTable();updateSelection();
}

async function generatePreview(){
  clearNotice();$('previewButton').disabled=true;$('previewButton').textContent='Generando…';
  try{
    const body={sessionId:state.sessionId,sftpAccountId:state.sftpAccountId,destinationMode:state.destinationMode,storeIds:[...state.selectedStores],activityIds:[...state.selected],types:activeTypes(),activityAction:state.activityAction,activityActions:[...state.selected].map(activityId=>({activityId,action:promotionAction(activityId)})),appItemIdType:Number($('appItemIdType').value),idMode:state.idMode,newActivityId:$('manualId').value.trim(),groupSameTypeAndValidity:$('groupPromotions').checked,itemIdReplacements:[...state.itemIdReplacements].map(([originalId,sentId])=>({originalId,sentId})),duplicateItemSelections:[...state.duplicateItemChoices].map(([conflictId,row])=>({conflictId,row})),zeroDiscountPolicy:state.zeroDiscountPolicy||undefined,unsupportedPercentagePolicy:state.unsupportedPercentagePolicy||undefined};
    const preview=await api('/api/preview',{method:'POST',body:JSON.stringify(body)});state.preview=preview;
    const grouped=preview.selection.grouping?.groups||[];
    const groupingText=preview.totals.promotionsBeforeGrouping!==preview.totals.promotions?`${preview.totals.promotionsBeforeGrouping} → ${preview.totals.promotions} promociones agrupadas · `:'';
    const destinationText=preview.destinationCount===1?preview.stores[0].name:`${preview.destinationCount.toLocaleString()} tiendas`;
    const createCount=Number(preview.totals.actions?.create??(preview.selection.activityAction===2?0:preview.totals.promotions));
    const stopCount=Number(preview.totals.actions?.stop??(preview.selection.activityAction===2?preview.totals.promotions:0));
    const omittedUnsupported=Number(preview.selection.unsupportedPercentageResolution?.omittedItems||0);
    const actionText=`${createCount.toLocaleString()} por crear o actualizar · ${stopCount.toLocaleString()} por detener · ${groupingText}${preview.totals.items.toLocaleString()} productos${omittedUnsupported?` · ${omittedUnsupported.toLocaleString()} fuera de rango omitidos`:''}`;
    $('previewSummary').textContent=`${actionText} · ${preview.totals.requests.toLocaleString()} solicitud${preview.totals.requests===1?'':'es'} · ${destinationText}`;
    $('previewAudit').textContent=preview.auditDirectory?`Auditoría guardada en: ${preview.auditDirectory}`:'';
    const replacements=preview.selection.activityIdReplacement?.mappings||[];
    const itemMappings=preview.selection.itemIdReplacement?.mappings||[];
    const mappings=[...grouped.map(group=>`${group.sourceActivityIds.join(' + ')} → ${group.activityId}`),...replacements.map(mapping=>`${mapping.originalId} → ${mapping.sentId}`),...itemMappings.map(mapping=>`UPC ${mapping.originalId} → ${mapping.sentId}`)];
    const itemIdLabel=`app_item_id_type ${preview.batches[0]?.payload?.app_item_id_type??$('appItemIdType').value}`;
    const actionLabel=preview.selection.activityAction==='mixed'?'Acciones 1 y 2 combinadas':preview.selection.activityAction===2?'Acción 2 · detener con el ID original':'Acción 1 · crear o actualizar';
    $('idMapping').textContent=`${itemIdLabel} · ${actionLabel}${mappings.length?` · ${mappings.join(' · ')}`:' · Activity ID original'}`;
    let jsonView;
    if(preview.destinationCount===1)jsonView=preview.batches.length===1?preview.batches[0].payload:preview.batches.map(batch=>batch.payload);
    else if(preview.previewScope==='representative_destination')jsonView={nota:`Vista previa representativa: se prepararon ${preview.totals.requests} solicitudes independientes.`,destinos:preview.destinationCount,tienda_ejemplo:preview.batches[0]?.store,lotes:preview.batches.map(batch=>batch.payload)};
    else jsonView=preview.batches.map(batch=>({tienda:batch.store,lote:batch.batchNumber,payload:batch.payload}));
    $('jsonPreview').textContent=JSON.stringify(jsonView,null,2);
    $('confirmSend').checked=false;$('sendButton').disabled=true;$('sendResult').classList.add('hidden');$('previewPanel').classList.remove('hidden');
    $('previewPanel').scrollIntoView({behavior:'smooth',block:'start'});
  }catch(error){notice(error.message,'error');}finally{$('previewButton').textContent='Generar vista previa';updateSelection();}
}

async function sendPreview(){
  if(!state.preview)return;clearNotice();const stop=state.preview.selection.activityAction===2;const ok=window.confirm(stop?'Se detendrán estas actividades en producción. ¿Continuar?':'Se enviará esta vista previa exacta a producción. ¿Continuar?');if(!ok)return;
  $('sendButton').disabled=true;$('sendButton').textContent='Enviando…';
  try{
    const result=await api('/api/send',{method:'POST',body:JSON.stringify({previewId:state.preview.previewId,authToken:$('authToken').value.trim()})});
    captureTaskEntries(result);const first=result.results?.[0]||{};const task=exactTaskId(first);
    const problems=(result.rejectedBatches||0)+(result.unknownBatches||0);const title=problems?'Envío completado con incidencias':'Solicitudes aceptadas por DiDi';
    const summary=`${result.acceptedBatches||0} aceptadas · ${result.rejectedBatches||0} rechazadas · ${result.unknownBatches||0} desconocidas`;
    const taskSummary=state.taskEntries.length?`<br>${state.taskEntries.length.toLocaleString()} Task IDs listos para consulta masiva.`:'';
    $('sendResult').classList.remove('hidden');$('sendResult').innerHTML=`<strong>${title}</strong><br>${summary}<br>${escapeHtml(first.message||'Sin detalle')}${task?`<br>Primer Task ID exacto: <code>${escapeHtml(task)}</code>`:''}${taskSummary}<br><small>${escapeHtml(result.outputDirectory||'')}</small>`;
    if(task)$('taskIdInput').value=String(task);
    notice(problems?'El proceso terminó y continuó después de los errores aislados. Revisa el resumen.':'DiDi aceptó todos los lotes. Consulta los Task IDs para confirmar el procesamiento.',problems?'error':'success');
  }catch(error){notice(error.message,'error');$('sendResult').classList.remove('hidden');$('sendResult').textContent=error.outputDirectory?`${error.message} · Auditoría: ${error.outputDirectory}`:error.message;}
  finally{$('sendButton').textContent='Enviar a producción';}
}

function waitForTaskPoll(milliseconds){return new Promise(resolve=>setTimeout(resolve,milliseconds));}
function applyTaskJobUpdates(snapshot){
  if(Array.isArray(snapshot.updates)&&snapshot.updates.length){
    const byKey=new Map(state.taskResults.map(result=>[taskKey(result),result]));
    for(const result of snapshot.updates)byKey.set(taskKey(result),result);
    state.taskResults=[...byKey.values()];
    scheduleBulkTaskRender();
  }
  updateBulkTaskProgress(snapshot);
}
async function pollTaskQueryJob(initial){
  let snapshot=initial;let cursor=Number(initial.nextCursor||0);let failures=0;
  applyTaskJobUpdates(snapshot);
  while(snapshot.status==='running'){
    await waitForTaskPoll(750);
    try{snapshot=await api(`/api/query-tasks/jobs/${encodeURIComponent(initial.jobId)}?after=${cursor}`);failures=0;}
    catch(error){failures+=1;if(failures<4)continue;throw error;}
    cursor=Number(snapshot.nextCursor||cursor);applyTaskJobUpdates(snapshot);
  }
  renderBulkTasks();
  if(snapshot.status==='failed')throw new Error(snapshot.error||'La consulta masiva no pudo completarse.');
  return snapshot;
}
async function queryAllTasks(){
  if(!state.taskEntries.length||state.taskQueryRunning)return;
  clearNotice();state.taskQueryRunning=true;state.taskResults=[];state.taskRawResults.clear();state.taskPage=1;
  $('queryAllTasks').textContent='Consultando…';renderBulkTasks();
  const uniqueStores=new Set(state.taskEntries.map(entry=>entry.storeId));
  updateBulkTaskProgress({phase:'authentication',total:state.taskEntries.length,completed:0,queried:0,errors:0,authBatchesDone:0,authBatchesTotal:Math.ceil(uniqueStores.size/100),authStoresDone:0,authStoresTotal:uniqueStores.size,elapsedMs:0});
  try{
    const job=await api('/api/query-tasks/jobs',{method:'POST',body:JSON.stringify({
      tasks:state.taskEntries.map(({storeId,taskId,batchNumber})=>({storeId,taskId,batchNumber})),
      authToken:uniqueStores.size===1?$('authToken').value.trim():'',
    })});
    state.taskQueryJobId=job.jobId;
    const result=await pollTaskQueryJob(job);
    const incidents=state.taskResults.filter(item=>taskDisplayStatus(item).key==='incident').length;
    notice(result.errors
      ?`Se terminaron ${result.completed} consultas; ${result.errors} tuvieron error de consulta y las demás continúan visibles.`
      :`Se consultaron ${result.queried} Task IDs. ${incidents?`${incidents} tiendas reportaron incidencias de producto.`:'No se reportaron incidencias de producto.'}`,result.errors?'error':'success');
  }catch(error){notice(error.message,'error');}
  finally{state.taskQueryRunning=false;$('queryAllTasks').textContent='Volver a consultar';renderBulkTasks();}
}

async function queryTask(){
  if(!state.taskStoreId){notice('Selecciona la tienda a la que pertenece el Task ID.','error');return;}
  clearNotice();$('queryButton').disabled=true;$('queryButton').textContent='Consultando…';
  try{const result=await api('/api/query-task',{method:'POST',body:JSON.stringify({storeId:state.taskStoreId,taskId:$('taskIdInput').value.trim(),authToken:$('authToken').value.trim()})});$('queryResult').textContent=JSON.stringify(result,null,2);$('queryResult').classList.remove('hidden');}
  catch(error){notice(error.message,'error');}finally{$('queryButton').textContent='Consultar Task ID';updateTaskQueryState();}
}

$('fileInput').addEventListener('change',event=>event.target.files[0]&&loadFile(event.target.files[0]));
for(const event of ['dragenter','dragover'])$('dropzone').addEventListener(event,e=>{e.preventDefault();$('dropzone').classList.add('drag');});
for(const event of ['dragleave','drop'])$('dropzone').addEventListener(event,e=>{e.preventDefault();$('dropzone').classList.remove('drag');});
$('dropzone').addEventListener('drop',event=>event.dataTransfer.files[0]&&loadFile(event.dataTransfer.files[0]));
$('storeSearch').addEventListener('input',renderStores);
$('storeCityFilter').addEventListener('change',renderStores);
$('selectVisibleStores').addEventListener('click',()=>{visibleStores().forEach(store=>state.selectedStores.add(store.id));renderStores();});
$('clearStores').addEventListener('click',()=>{state.selectedStores.clear();renderStores();});
document.querySelectorAll('#destinationMode button').forEach(button=>button.addEventListener('click',()=>{state.destinationMode=button.dataset.mode;document.querySelectorAll('#destinationMode button').forEach(candidate=>candidate.classList.toggle('active',candidate===button));updateDestination();}));
$('searchInput').addEventListener('input',renderTable);document.querySelectorAll('.type-filters input').forEach(input=>input.addEventListener('change',renderTable));
$('selectVisible').addEventListener('click',()=>{visiblePromotions().forEach(p=>state.selected.add(p.activityId));renderTable();updateSelection();});
$('clearSelection').addEventListener('click',()=>{state.selected.clear();renderTable();updateSelection();});
$('defaultRuleProfile').addEventListener('change',event=>{state.defaultRuleId=event.target.value;applyDefaultRule();});
$('saveDefaultRule').addEventListener('click',saveDefaultRule);$('resetDefaultRule').addEventListener('click',resetDefaultRule);
$('activityActionMode').addEventListener('click',event=>{const button=event.target.closest('[data-action]');if(!button)return;state.activityAction=Number(button.dataset.action);updateActivityAction();updateDefaultRuleSummary(true);});
$('appItemIdType').addEventListener('change',()=>{state.preview=null;$('previewPanel').classList.add('hidden');updateSelection();updateDefaultRuleSummary(true);});
document.querySelectorAll('#sourceMode button').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('#sourceMode button').forEach(candidate=>candidate.classList.toggle('active',candidate===button));const sftp=button.dataset.source==='sftp';$('localSource').classList.toggle('hidden',sftp);$('sftpSource').classList.toggle('hidden',!sftp);if(sftp&&!state.sftpFiles.length)loadSftpFiles();}));
let sftpSearchTimer;$('sftpSearch').addEventListener('input',()=>{clearTimeout(sftpSearchTimer);sftpSearchTimer=setTimeout(()=>loadSftpFiles(),250);});
$('refreshSftp').addEventListener('click',()=>loadSftpFiles(true));$('sftpFileSelect').addEventListener('change',()=>{const unavailable=!$('sftpFileSelect').value;$('downloadSftpFile').disabled=unavailable;$('loadSftpFile').disabled=unavailable;});$('downloadSftpFile').addEventListener('click',downloadSelectedSftp);$('loadSftpFile').addEventListener('click',loadSelectedSftp);
$('sftpAccountSelect').addEventListener('change',event=>{state.sftpAccountId=event.target.value;state.sftpFiles=[];clearLoadedSource(state.sftpAccountId?'Marca seleccionada · carga el archivo de esta marca':'Selecciona una marca antes de cargar el archivo');syncSelectedBrand();$('sftpFileSelect').innerHTML=state.sftpAccountId?'<option value="">Consultando cuenta…</option>':'<option value="">Selecciona una marca…</option>';$('downloadSftpFile').disabled=true;$('loadSftpFile').disabled=true;if(state.sftpAccountId&&isSftpSource())loadSftpFiles();else $('sftpStatus').textContent=state.sftpAccountId?'Marca lista para archivo local':'Sin marca seleccionada';});
document.querySelectorAll('#idMode button').forEach(button=>button.addEventListener('click',()=>{state.idMode=button.dataset.mode;document.querySelectorAll('#idMode button').forEach(candidate=>candidate.classList.toggle('active',candidate===button));$('manualIdField').classList.toggle('hidden',state.idMode!=='manual');$('manualIdHint').classList.toggle('hidden',state.idMode!=='manual');updateSelection();}));
$('manualId').addEventListener('input',updateSelection);
$('groupPromotions').addEventListener('change',updateSelection);
$('zeroDiscountMode').addEventListener('click',event=>{const button=event.target.closest('[data-zero-policy]');if(!button)return;state.zeroDiscountPolicy=button.dataset.zeroPolicy;state.preview=null;$('previewPanel').classList.add('hidden');updateSelection();});
$('unsupportedPercentageMode').addEventListener('click',event=>{const button=event.target.closest('[data-unsupported-percentage-policy]');if(!button)return;state.unsupportedPercentagePolicy=button.dataset.unsupportedPercentagePolicy;state.preview=null;$('previewPanel').classList.add('hidden');updateSelection();});
$('upcOriginal').addEventListener('input',updateUpcAddState);$('upcReplacement').addEventListener('input',updateUpcAddState);$('addUpcReplacement').addEventListener('click',addUpcReplacement);
$('taskStoreSearch').addEventListener('input',renderTaskStores);$('taskCityFilter').addEventListener('change',renderTaskStores);$('taskIdInput').addEventListener('input',updateTaskQueryState);
$('bulkTaskSearch').addEventListener('input',()=>{state.taskPage=1;renderBulkTasks();});$('bulkTaskStatus').addEventListener('change',()=>{state.taskPage=1;renderBulkTasks();});$('queryAllTasks').addEventListener('click',queryAllTasks);$('clearTaskQueue').addEventListener('click',clearTaskQueue);
$('bulkTaskPrevious').addEventListener('click',()=>{state.taskPage=Math.max(1,state.taskPage-1);renderBulkTasks();});$('bulkTaskNext').addEventListener('click',()=>{state.taskPage+=1;renderBulkTasks();});$('bulkTaskPageSize').addEventListener('change',event=>{state.taskPageSize=Number(event.target.value)||50;state.taskPage=1;renderBulkTasks();});
$('automationAccountSelect').addEventListener('change',()=>{state.automationFiles=[];$('automationFileSelect').innerHTML='<option value="">Consultando cuenta…</option>';invalidateAutomationPreview();loadAutomationFiles();});
$('automationFileMode').addEventListener('change',()=>{updateAutomationForm();if($('automationFileMode').value==='specific'&&!state.automationFiles.length)loadAutomationFiles();});
$('automationFileSelect').addEventListener('change',()=>updateAutomationForm());
$('automationActivityId').addEventListener('input',()=>updateAutomationForm());
document.querySelectorAll('.automation-types input').forEach(input=>input.addEventListener('change',()=>updateAutomationForm()));
$('automationSendApi').addEventListener('change',()=>updateAutomationForm());
$('automationUpdateDates').addEventListener('change',()=>updateAutomationForm());
$('automationWriteSftp').addEventListener('change',()=>updateAutomationForm());
$('automationStartDate').addEventListener('input',()=>updateAutomationForm());$('automationEndDate').addEventListener('input',()=>updateAutomationForm());
$('automationRefreshFiles').addEventListener('click',()=>loadAutomationFiles(true));
$('automationPreviewButton').addEventListener('click',prepareAutomationPreview);
$('automationConfirm').addEventListener('change',event=>{$('automationExecuteButton').disabled=!event.target.checked||!state.automationPreview?.executable;});
$('automationExecuteButton').addEventListener('click',executeAutomation);
$('refreshDiagnostics').addEventListener('click',()=>loadDiagnostics(true));
$('previewButton').addEventListener('click',generatePreview);$('confirmSend').addEventListener('change',event=>$('sendButton').disabled=!event.target.checked);$('sendButton').addEventListener('click',sendPreview);$('queryButton').addEventListener('click',queryTask);
initializeNavigation();
updateActivityAction();
initialize();
