/**
 * Normalización de patentes chilenas.
 *
 * Formatos soportados (se guardan siempre en forma canónica con guion):
 *   Autos nuevo  (2007+)  BBCC12   -> BBCC-12
 *   Autos antiguo         AB1234   -> AB-1234
 *   Motos nuevo           BBC12    -> BBC-12
 *   Motos antiguo         AB123    -> AB-123
 *
 * Así "bbcc 12", "BB-CC-11", "BBCC·12" y "BBCC12" son la MISMA patente
 * al cruzarla contra la hotlist.
 */

const FORMATOS = [
  { nombre: 'auto_nuevo',   re: /^([A-Z]{4})(\d{2})$/ },
  { nombre: 'auto_antiguo', re: /^([A-Z]{2})(\d{4})$/ },
  { nombre: 'moto_nuevo',   re: /^([A-Z]{3})(\d{2})$/ },
  { nombre: 'moto_antiguo', re: /^([A-Z]{2})(\d{3})$/ },
];

// Confusiones típicas del OCR según la posición esperada
const A_LETRA = { '0': 'D', '1': 'L', '2': 'Z', '4': 'A', '5': 'S', '6': 'G', '7': 'T', '8': 'B' };
const A_DIGITO = { O: '0', D: '0', Q: '0', U: '0', I: '1', L: '1', T: '7', Z: '2', S: '5', G: '6', B: '8', A: '4' };

/** Deja solo letras y dígitos en mayúscula. */
function limpiar(texto) {
  if (typeof texto !== 'string') return '';
  return texto.toUpperCase().normalize('NFD').replace(/[^A-Z0-9]/g, '');
}

/** Intenta encajar el texto en un patrón letras+dígitos corrigiendo errores OCR. */
function corregirPara(texto, nLetras, nDigitos) {
  if (texto.length !== nLetras + nDigitos) return null;
  let out = '';
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (i < nLetras) out += /[A-Z]/.test(c) ? c : (A_LETRA[c] || '?');
    else out += /\d/.test(c) ? c : (A_DIGITO[c] || '?');
  }
  return out.includes('?') ? null : out;
}

/**
 * Devuelve { patente, formato, corregida } o null si no parece patente chilena.
 * @param {string} texto  lectura cruda (OCR o ingreso manual)
 * @param {object} opts   { corregirOCR: true } permite corregir confusiones 0/O, 8/B, etc.
 */
function analizar(texto, opts = {}) {
  const corregirOCR = opts.corregirOCR !== false;
  const limpio = limpiar(texto);
  if (!limpio) return null;

  // 1) Coincidencia exacta
  for (const f of FORMATOS) {
    const m = limpio.match(f.re);
    if (m) return { patente: `${m[1]}-${m[2]}`, formato: f.nombre, corregida: false };
  }
  if (!corregirOCR) return null;

  // 2) Con corrección de errores OCR (largo 6: auto nuevo antes que antiguo)
  const intentos = [
    ['auto_nuevo', 4, 2], ['auto_antiguo', 2, 4],
    ['moto_nuevo', 3, 2], ['moto_antiguo', 2, 3],
  ];
  for (const [nombre, l, d] of intentos) {
    const c = corregirPara(limpio, l, d);
    if (c) return { patente: `${c.slice(0, l)}-${c.slice(l)}`, formato: nombre, corregida: true };
  }
  return null;
}

/**
 * Normaliza para guardar/cruzar. Si no calza con ningún formato chileno,
 * devuelve el texto limpio (permite patentes extranjeras en la hotlist).
 */
function normalizar(texto) {
  const r = analizar(texto, { corregirOCR: false });
  if (r) return r.patente;
  const limpio = limpiar(texto);
  return limpio.length >= 4 && limpio.length <= 10 ? limpio : null;
}

module.exports = { analizar, normalizar, limpiar };
