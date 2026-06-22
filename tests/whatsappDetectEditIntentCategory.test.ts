import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { detectEditIntent } from '../server/routes/whatsapp';

// Task #379 — el bot debe poder reconocer cuando el usuario quiere cambiar la
// categoría desde la confirmación, sin desviar mensajes normales al paso de
// categoría. Estos tests pinean el contrato de `detectEditIntent` para el
// campo 'category' y verifican que no haya regresiones de enrutamiento contra
// los campos previos (account, currency, type, amount, cancel).

describe('detectEditIntent — categoría (Task #379)', () => {
  it('detecta cambio de categoría con la palabra "categoría" y extrae el valor', () => {
    assert.deepEqual(detectEditIntent('cambiar la categoría a transporte'), {
      field: 'category',
      value: 'transporte',
    });
    assert.deepEqual(detectEditIntent('la categoría es comida'), {
      field: 'category',
      value: 'comida',
    });
    assert.deepEqual(detectEditIntent('no, la categoría correcta es combustible'), {
      field: 'category',
      value: 'combustible',
    });
  });

  it('detecta verbos de clasificación fuertes con preposición explícita', () => {
    assert.deepEqual(detectEditIntent('ponelo en transporte'), {
      field: 'category',
      value: 'transporte',
    });
    assert.deepEqual(detectEditIntent('metelo en comida'), {
      field: 'category',
      value: 'comida',
    });
    assert.deepEqual(detectEditIntent('clasificalo como combustible'), {
      field: 'category',
      value: 'combustible',
    });
  });

  it('detecta "es/era/va para X" como cambio de categoría (caso del bug)', () => {
    assert.deepEqual(detectEditIntent('es para transporte'), {
      field: 'category',
      value: 'transporte',
    });
    assert.deepEqual(detectEditIntent('era para comida'), {
      field: 'category',
      value: 'comida',
    });
    assert.deepEqual(detectEditIntent('va para combustible'), {
      field: 'category',
      value: 'combustible',
    });
  });

  it('NO interpreta como categoría cuando "es para X" apunta a cliente/cuenta', () => {
    assert.notEqual(detectEditIntent('es para el cliente Juan').field, 'category');
    assert.notEqual(detectEditIntent('es para el proveedor Acme').field, 'category');
    assert.notEqual(detectEditIntent('va en la cuenta personal').field, 'category');
    assert.notEqual(detectEditIntent('anotalo aparte por favor').field, 'category');
  });

  it('no rompe la detección de cuenta, moneda, tipo, monto y cancelación', () => {
    assert.deepEqual(detectEditIntent('cambiar a personal'), {
      field: 'account',
      value: 'personal',
    });
    assert.equal(detectEditIntent('son dólares').field, 'currency');
    assert.equal(detectEditIntent('cambiar a ingreso').field, 'type');
    assert.equal(detectEditIntent('cambiar el monto').field, 'amount');
    assert.equal(detectEditIntent('cancelar').field, 'cancel');
  });
});
