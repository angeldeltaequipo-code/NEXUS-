/* NEXUS-LPR — Centro de Comando (cliente) */
'use strict';

const $ = (id) => document.getElementById(id);
const TZ = 'America/Santiago';
let yo = null;
let ultimoIdAlerta = null;   // para no sonar con alertas antiguas al cargar
let sonidoActivo = localStorage.getItem('nexus_sonido') !== 'off';
let tabActual = 'vivo';

// ------------------------------------------------------------ utilidades
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fechaHora = (iso) => (iso ? new Date(iso).toLocaleString('es-CL', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—');
const haceCuanto = (iso) => {
  if (!iso) return 'nunca';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `hace ${s} s`;
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return fechaHora(iso);
};

async function api(ruta, opciones = {}) {
  const r = await fetch(ruta, {
    ...opciones,
    headers: { ...(opciones.body ? { 'Content-Type': 'application/json' } : {}), ...(opciones.headers || {}) },
    body: opciones.body ? JSON.stringify(opciones.body) : undefined,
  });
  if (r.status === 401) { location.href = '/login.html'; throw new Error('Sesión expirada'); }
  const j = r.headers.get('content-type')?.includes('json') ? await r.json() : null;
  if (!r.ok) throw new Error(j?.error || `Error ${r.status}`);
  return j;
}

function toast(msg, tipo = 'ok') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `fixed bottom-4 right-4 z-50 rounded-lg px-4 py-3 text-sm shadow-lg ${tipo === 'error' ? 'bg-red-600 text-white' : 'bg-primary text-white'}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 3500);
}

function abrirModal(titulo, html) {
  $('modal-titulo').textContent = titulo;
  $('modal-cuerpo').innerHTML = html;
  $('modal').classList.remove('hidden');
}
function cerrarModal() {
  $('modal').classList.add('hidden');
  $('modal-cuerpo').querySelectorAll('img').forEach((i) => i.src.startsWith('blob:') && URL.revokeObjectURL(i.src));
  $('modal-cuerpo').innerHTML = '';
}

function badgeEstado(e) {
  if (!e.nivel) return '<span class="badge-ok"><span class="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>ACCESO AUTORIZADO</span>';
  const cls = e.nivel === 'CRITICA' ? 'badge-alerta' : 'badge-precaucion';
  return `<span class="${cls}">${esc(e.estado)}</span>`;
}
const badgeNivel = (n) => (n === 'CRITICA' ? '<span class="badge-alerta">CRÍTICA</span>' : '<span class="badge-precaucion">PRECAUCIÓN</span>');

function filaEvento(e, conUbicacion = true) {
  const foto = e.foto ? ` <button class="btn-mini ml-1" data-foto="${e.id}" data-patente="${esc(e.patente)}" title="Ver foto de evidencia">📷</button>` : '';
  return `<tr class="${e.nivel ? 'bg-red-50/50' : ''} hover:bg-slate-50">
    <td class="td font-mono text-xs text-muted whitespace-nowrap">${fechaHora(e.timestamp)}</td>
    <td class="td font-mono font-bold whitespace-nowrap">${esc(e.patente)}</td>
    <td class="td">${badgeEstado(e)}${foto}</td>
    ${conUbicacion ? `<td class="td text-muted whitespace-nowrap">${esc(e.pasaje)}</td>` : ''}
    <td class="td"><span class="chip-cam" title="${esc(e.pasaje)}">${esc(e.camara)}</span></td>
    <td class="td text-right font-mono text-xs">${esc(e.confianza)}</td></tr>`;
}

// --------------------------------------------------------- alerta sonora
let audioCtx = null;
function beep() {
  if (!sonidoActivo) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.35, 0.7].forEach((t) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'square'; o.frequency.value = 880;
      g.gain.setValueAtTime(0.08, audioCtx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + t + 0.25);
      o.connect(g).connect(audioCtx.destination);
      o.start(audioCtx.currentTime + t); o.stop(audioCtx.currentTime + t + 0.26);
    });
  } catch { /* el navegador puede bloquear audio sin interacción previa */ }
}
function actualizarBotonSonido() {
  $('btn-sonido').innerHTML = sonidoActivo ? '🔔<span class="hidden sm:inline"> Sonido: activo</span>' : '🔕<span class="hidden sm:inline"> Sonido: apagado</span>';
}

// --------------------------------------------------------------- EN VIVO
async function refrescarVivo() {
  try {
    const [eventos, hotlist, resumen, camaras] = await Promise.all([
      api('/api/eventos'), api('/api/hotlist'), api('/api/resumen'), api('/api/camaras'),
    ]);
    $('estado-texto').textContent = 'OPERATIVO';
    $('estado-sistema').className = 'hidden sm:inline-flex items-center gap-1.5 rounded-full bg-emerald-50 border border-emerald-200 px-3 py-1 text-xs font-medium text-emerald-700';

    $('kpi-lecturas').textContent = resumen.lecturas24h.toLocaleString('es-CL');
    $('kpi-alertas').textContent = resumen.alertas24h;
    $('kpi-hotlist').textContent = resumen.hotlist;
    $('kpi-camaras').textContent = `${resumen.camarasOnline}/${resumen.camarasTotal}`;
    $('kpi-camaras').className = `kpi-valor ${resumen.camarasTotal && resumen.camarasOnline < resumen.camarasTotal ? 'text-amber-600' : ''}`;
    $('kpi-confianza').textContent = resumen.confianzaPromedio != null ? `${resumen.confianzaPromedio}%` : '—';

    $('sin-eventos').classList.toggle('hidden', eventos.length > 0);
    $('tabla-eventos').innerHTML = eventos.map((e) => filaEvento(e, false)).join('');

    // Nueva alerta → banner + sonido
    const alertas = eventos.filter((e) => e.nivel);
    const ultima = alertas[0];
    if (ultima && ultimoIdAlerta !== null && ultima.id > ultimoIdAlerta) {
      $('banner-texto').textContent = `${ultima.nivel === 'CRITICA' ? 'ALERTA CRÍTICA' : 'PRECAUCIÓN'}: ${ultima.patente} — ${ultima.estado.replace('LISTA NEGRA: ', '')} · ${ultima.pasaje} (${ultima.camara})`;
      $('banner').classList.remove('hidden');
      beep();
    }
    if (ultimoIdAlerta === null || (ultima && ultima.id > ultimoIdAlerta)) ultimoIdAlerta = ultima ? ultima.id : 0;

    $('lista-hotlist').innerHTML = hotlist.length ? hotlist.map((h) => `
      <li class="px-5 py-3 flex items-center justify-between gap-3">
        <div class="min-w-0">
          <p class="font-mono font-bold text-sm">${esc(h.patente)}</p>
          <p class="text-xs text-muted truncate">${esc(h.motivo)}${h.vence ? ` · vence ${esc(h.vence)}` : ''}</p>
        </div>
        <div class="flex items-center gap-2 shrink-0">${badgeNivel(h.nivel)}
          <button class="btn-mini" data-quitar="${esc(h.patente)}" title="Quitar de la hotlist">✕</button></div>
      </li>`).join('') : '<li class="px-5 py-6 text-center text-sm text-muted">Sin encargos registrados</li>';

    $('lista-camaras-vivo').innerHTML = camaras.length ? camaras.map((c) => `
      <li class="px-5 py-3 flex items-center justify-between gap-3">
        <div class="min-w-0"><p class="text-sm font-medium truncate">${esc(c.nombre)} <span class="chip-cam">${esc(c.id)}</span></p>
        <p class="text-xs text-muted truncate">${esc(c.ubicacion)} · ${haceCuanto(c.ultimo_contacto)}</p></div>
        ${!c.activa ? '<span class="badge-gris">DESACTIVADA</span>' : c.online ? '<span class="badge-ok">EN LÍNEA</span>' : '<span class="badge-alerta">SIN SEÑAL</span>'}
      </li>`).join('') : '<li class="px-5 py-6 text-center text-sm text-muted">Sin cámaras. Regístrelas en la pestaña Cámaras.</li>';
  } catch (e) {
    $('estado-texto').textContent = 'SIN CONEXIÓN';
    $('estado-sistema').className = 'inline-flex items-center gap-1.5 rounded-full bg-red-50 border border-red-200 px-3 py-1 text-xs font-medium text-red-700';
  }
}

$('form-hotlist').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    const r = await api('/api/hotlist', { method: 'POST', body: {
      patente: $('f-patente').value, motivo: $('f-motivo').value, nivel: $('f-nivel').value, vence: $('f-vence').value || null,
    } });
    toast(`Encargo registrado: ${r.patente}`);
    ev.target.reset();
    refrescarVivo();
  } catch (e) { toast(e.message, 'error'); }
});

document.addEventListener('click', async (ev) => {
  const quitar = ev.target.closest('[data-quitar]');
  if (quitar) {
    const p = quitar.dataset.quitar;
    if (!confirm(`¿Quitar ${p} de la hotlist?`)) return;
    try { await api(`/api/hotlist/${encodeURIComponent(p)}`, { method: 'DELETE' }); toast(`${p} quitada`); refrescarVivo(); }
    catch (e) { toast(e.message, 'error'); }
  }
  const foto = ev.target.closest('[data-foto]');
  if (foto) {
    try {
      const r = await fetch(`/api/eventos/${foto.dataset.foto}/foto`);
      if (!r.ok) throw new Error('No se pudo cargar la foto');
      const url = URL.createObjectURL(await r.blob());
      abrirModal(`Evidencia · ${foto.dataset.patente}`, `<img src="${url}" alt="Foto de evidencia" class="w-full rounded-lg border border-slate-200">
        <p class="text-xs text-muted mt-3">Acceso registrado en auditoría. No difunda esta imagen fuera de la finalidad de seguridad.</p>`);
    } catch (e) { toast(e.message, 'error'); }
  }
});

// ------------------------------------------------------------- HISTORIAL
function paramsHistorial() {
  const p = new URLSearchParams();
  if ($('h-patente').value.trim()) p.set('patente', $('h-patente').value.trim());
  if ($('h-desde').value) p.set('desde', $('h-desde').value);
  if ($('h-hasta').value) p.set('hasta', $('h-hasta').value);
  if ($('h-camara').value) p.set('camara', $('h-camara').value);
  if ($('h-alertas').checked) p.set('solo_alertas', '1');
  return p;
}
$('form-historial').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    const filas = await api(`/api/historial?${paramsHistorial()}`);
    $('tabla-historial').innerHTML = filas.map((e) => filaEvento(e, true)).join('');
    $('historial-vacio').textContent = filas.length ? '' : 'Sin resultados para esos filtros.';
    $('historial-vacio').classList.toggle('hidden', filas.length > 0);
    toast(`${filas.length} resultado(s)`);
  } catch (e) { toast(e.message, 'error'); }
});
$('btn-suprimir').addEventListener('click', async () => {
  const p = $('h-patente').value.trim();
  if (!p) return toast('Escriba primero la patente en el filtro', 'error');
  const motivo = prompt(`Supresión de datos de ${p.toUpperCase()} (Ley 21.719).\nEsto borra TODAS sus lecturas y fotos. Indique el motivo o N° de solicitud:`);
  if (!motivo) return;
  try {
    const r = await api(`/api/historial?patente=${encodeURIComponent(p)}&motivo=${encodeURIComponent(motivo)}`, { method: 'DELETE' });
    toast(`${r.eliminados} registro(s) de ${r.patente} eliminados`);
    $('tabla-historial').innerHTML = '';
  } catch (e) { toast(e.message, 'error'); }
});
$('btn-csv').addEventListener('click', () => { location.href = `/api/historial.csv?${paramsHistorial()}`; });

// --------------------------------------------------------------- CÁMARAS
async function cargarCamaras() {
  const camaras = await api('/api/camaras');
  $('camaras-vacio').classList.toggle('hidden', camaras.length > 0);
  const admin = yo.rol === 'admin';
  $('tabla-camaras').innerHTML = camaras.map((c) => `
    <tr class="hover:bg-slate-50">
      <td class="td font-mono font-semibold">${esc(c.id)}</td><td class="td">${esc(c.nombre)}</td>
      <td class="td text-muted">${esc(c.ubicacion)}</td>
      <td class="td">${!c.activa ? '<span class="badge-gris">DESACTIVADA</span>' : c.online ? '<span class="badge-ok">EN LÍNEA</span>' : '<span class="badge-alerta">SIN SEÑAL</span>'}</td>
      <td class="td text-muted text-xs">${haceCuanto(c.ultimo_contacto)}</td>
      ${admin ? `<td class="td text-right whitespace-nowrap">
        <button class="btn-mini" data-rotar="${esc(c.id)}">Nueva clave</button>
        <button class="btn-mini" data-toggle-cam="${esc(c.id)}" data-activa="${c.activa}">${c.activa ? 'Desactivar' : 'Activar'}</button></td>` : ''}
    </tr>`).join('');
  const sel = $('h-camara'), actual = sel.value;
  sel.innerHTML = '<option value="">Todas</option>' + camaras.map((c) => `<option value="${esc(c.id)}">${esc(c.id)}</option>`).join('');
  sel.value = actual;
}
function mostrarClave(id, key) {
  $('clave-cam').textContent = id;
  $('clave-valor').textContent = key;
  $('clave-nueva').classList.remove('hidden');
  $('clave-nueva').scrollIntoView({ behavior: 'smooth' });
}
$('btn-copiar').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('clave-valor').textContent); toast('Clave copiada'); }
  catch { toast('Seleccione y copie la clave manualmente', 'error'); }
});
$('form-camara').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    const r = await api('/api/camaras', { method: 'POST', body: { id: $('c-id').value, nombre: $('c-nombre').value, ubicacion: $('c-ubicacion').value } });
    ev.target.reset(); mostrarClave(r.id, r.apiKey); cargarCamaras();
  } catch (e) { toast(e.message, 'error'); }
});
document.addEventListener('click', async (ev) => {
  const rotar = ev.target.closest('[data-rotar]');
  if (rotar) {
    if (!confirm(`¿Generar nueva clave para ${rotar.dataset.rotar}? La anterior dejará de funcionar de inmediato.`)) return;
    try { const r = await api(`/api/camaras/${encodeURIComponent(rotar.dataset.rotar)}/rotar`, { method: 'POST' }); mostrarClave(r.id, r.apiKey); }
    catch (e) { toast(e.message, 'error'); }
  }
  const tog = ev.target.closest('[data-toggle-cam]');
  if (tog) {
    try { await api(`/api/camaras/${encodeURIComponent(tog.dataset.toggleCam)}`, { method: 'PATCH', body: { activa: tog.dataset.activa !== 'true' } }); cargarCamaras(); }
    catch (e) { toast(e.message, 'error'); }
  }
});

// -------------------------------------------------------------- USUARIOS
async function cargarUsuarios() {
  const us = await api('/api/usuarios');
  $('tabla-usuarios').innerHTML = us.map((u) => `
    <tr class="hover:bg-slate-50">
      <td class="td font-medium">${esc(u.usuario)}</td>
      <td class="td">${u.rol === 'admin' ? '<span class="badge-precaucion">ADMIN</span>' : '<span class="badge-gris">OPERADOR</span>'}</td>
      <td class="td">${u.activo ? '<span class="badge-ok">ACTIVO</span>' : '<span class="badge-gris">INACTIVO</span>'}</td>
      <td class="td text-muted text-xs">${fechaHora(u.creado)}</td>
      <td class="td text-right">${u.id !== yo.id ? `<button class="btn-mini" data-toggle-user="${u.id}" data-activo="${u.activo}">${u.activo ? 'Desactivar' : 'Activar'}</button>` : '<span class="text-xs text-muted">(usted)</span>'}</td>
    </tr>`).join('');
}
$('form-usuario').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    await api('/api/usuarios', { method: 'POST', body: { usuario: $('u-usuario').value.trim(), password: $('u-password').value, rol: $('u-rol').value } });
    ev.target.reset(); toast('Usuario creado'); cargarUsuarios();
  } catch (e) { toast(e.message, 'error'); }
});
document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-toggle-user]');
  if (!t) return;
  try { await api(`/api/usuarios/${t.dataset.toggleUser}`, { method: 'PATCH', body: { activo: t.dataset.activo !== 'true' } }); cargarUsuarios(); }
  catch (e) { toast(e.message, 'error'); }
});

// ------------------------------------------------------------- AUDITORÍA
async function cargarAuditoria() {
  const filas = await api('/api/auditoria');
  $('tabla-auditoria').innerHTML = filas.map((a) => `
    <tr class="hover:bg-slate-50">
      <td class="td font-mono text-xs text-muted whitespace-nowrap">${fechaHora(a.ts)}</td>
      <td class="td">${esc(a.usuario)}</td><td class="td font-mono text-xs">${esc(a.accion)}</td>
      <td class="td text-xs text-muted break-all">${esc(a.detalle)}</td><td class="td text-xs text-muted">${esc(a.ip)}</td>
    </tr>`).join('');
}

// --------------------------------------------------------------- general
function cambiarTab(tab) {
  tabActual = tab;
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('hidden', p.id !== `tab-${tab}`));
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('tab-activa', b.dataset.tab === tab));
  if (tab === 'camaras') cargarCamaras().catch((e) => toast(e.message, 'error'));
  if (tab === 'usuarios') cargarUsuarios().catch((e) => toast(e.message, 'error'));
  if (tab === 'auditoria') cargarAuditoria().catch((e) => toast(e.message, 'error'));
  if (tab === 'historial') cargarCamaras().catch(() => {});
}
$('tabs').addEventListener('click', (ev) => { const b = ev.target.closest('[data-tab]'); if (b) cambiarTab(b.dataset.tab); });

$('banner-cerrar').addEventListener('click', () => $('banner').classList.add('hidden'));
$('modal-cerrar').addEventListener('click', cerrarModal);
$('modal').addEventListener('click', (ev) => { if (ev.target.id === 'modal') cerrarModal(); });
$('btn-sonido').addEventListener('click', () => {
  sonidoActivo = !sonidoActivo;
  localStorage.setItem('nexus_sonido', sonidoActivo ? 'on' : 'off');
  actualizarBotonSonido();
  if (sonidoActivo) beep();
});
$('btn-usuario').addEventListener('click', () => $('menu-usuario').classList.toggle('hidden'));
document.addEventListener('click', (ev) => { if (!ev.target.closest('#btn-usuario')) $('menu-usuario').classList.add('hidden'); });
$('btn-salir').addEventListener('click', async () => { await fetch('/api/logout', { method: 'POST' }); location.href = '/login.html'; });
$('btn-password').addEventListener('click', () => {
  abrirModal('Cambiar contraseña', `
    <form id="form-pass" class="space-y-3 max-w-sm">
      <input id="p-actual" type="password" required placeholder="Contraseña actual" class="input" autocomplete="current-password">
      <input id="p-nueva" type="password" required minlength="10" placeholder="Nueva contraseña (mín. 10)" class="input" autocomplete="new-password">
      <button class="btn-primario w-full">Guardar</button>
    </form>`);
  $('form-pass').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try { await api('/api/yo/password', { method: 'POST', body: { actual: $('p-actual').value, nueva: $('p-nueva').value } }); cerrarModal(); toast('Contraseña actualizada'); }
    catch (e) { toast(e.message, 'error'); }
  });
});

setInterval(() => { $('reloj').textContent = new Date().toLocaleTimeString('es-CL', { timeZone: TZ, hour12: false }); }, 1000);

(async function iniciar() {
  try { yo = await api('/api/yo'); } catch { return; }
  $('btn-usuario').innerHTML = `${esc(yo.usuario)}<span class="hidden sm:inline"> · ${yo.rol === 'admin' ? 'Admin' : 'Operador'}</span> ▾`;
  if (yo.rol !== 'admin') document.querySelectorAll('.solo-admin').forEach((el) => el.classList.add('hidden'));
  actualizarBotonSonido();
  cambiarTab('vivo');
  try {
    const c = await api('/api/config');
    $('pie').textContent = `NEXUS-LPR v${c.version} · Retención: ${c.retencionDias} días (alertas ${c.retencionAlertasDias}) · Telegram: ${c.telegram ? 'activo' : 'no configurado'}`;
  } catch { /* opcional */ }
  refrescarVivo();
  setInterval(() => { if (tabActual === 'vivo' && !document.hidden) refrescarVivo(); }, 2000);
})();
