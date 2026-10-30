const test = require('node:test');
const assert = require('node:assert');
const { analizar, normalizar } = require('../lib/plates');

test('formatos chilenos exactos', () => {
  assert.equal(analizar('bbcc12').patente, 'BBCC-12');
  assert.equal(analizar('BB-CC-11').patente, 'BBCC-11');
  assert.equal(analizar('BBCC·12').patente, 'BBCC-12');
  assert.equal(analizar(' rjkt 83 ').patente, 'RJKT-83');
  assert.equal(analizar('AB1234').patente, 'AB-1234');   // auto antiguo
  assert.equal(analizar('AB1234').formato, 'auto_antiguo');
  assert.equal(analizar('BBC12').patente, 'BBC-12');     // moto nueva
  assert.equal(analizar('AB123').patente, 'AB-123');     // moto antigua
});

test('corrige confusiones típicas del OCR', () => {
  const r = analizar('RJKTB3');            // B leída en vez de 8
  assert.equal(r.patente, 'RJKT-83');
  assert.equal(r.corregida, true);
  assert.equal(analizar('8CFG21').patente, 'BCFG-21'); // 8 en posición de letra
  assert.equal(analizar('HLPRO9').patente, 'HLPR-09'); // O en posición de dígito
});

test('rechaza texto que no es patente', () => {
  assert.equal(analizar(''), null);
  assert.equal(analizar('CHILE'), null);
  assert.equal(analizar('1234567'), null);
  assert.equal(analizar(null), null);
});

test('normalizar: misma patente escrita distinto → mismo valor', () => {
  assert.equal(normalizar('bbcc-12'), normalizar('BB CC 12'));
  assert.equal(normalizar('AB-1234'), 'AB-1234');
  assert.equal(normalizar('X'), null);
});
