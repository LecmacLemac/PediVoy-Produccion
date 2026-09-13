import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import * as transferenciasRoute from '../src/routes/transferencias.js';

const { saveManualTransferFile, parseManualTransferFields } = transferenciasRoute;

const jpeg = suffix => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(suffix)]);

test('campos bancarios manuales aceptan ambos válidos o ninguno y rechazan vacíos/parciales', () => {
  assert.deepEqual(parseManualTransferFields({}), { nroOperacion: null, cuentaBancariaId: null });
  assert.deepEqual(parseManualTransferFields({
    nro_operacion: ' OP-123 ', cuenta_bancaria_id: '9',
  }), { nroOperacion: 'OP-123', cuentaBancariaId: 9 });
  for (const body of [
    { nro_operacion: '' , cuenta_bancaria_id: '' },
    { nro_operacion: '   ', cuenta_bancaria_id: '9' },
    { nro_operacion: 'OP-1' },
    { cuenta_bancaria_id: '9' },
    { nro_operacion: 'x'.repeat(201), cuenta_bancaria_id: '9' },
    { nro_operacion: 'OP-1', cuenta_bancaria_id: '0' },
  ]) {
    assert.throws(() => parseManualTransferFields(body), error => error?.code === 'INVALID_MANUAL_TRANSFER_FIELDS');
  }
});

test('reserva manual concurrente deduplica por hash y tenant y borra solo el archivo perdedor', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pedivoy-manual-dedupe-'));
  const rowsByKey = new Map();
  let nextId = 1;
  const queryFn = async (sql, params) => {
    if (sql.includes('INSERT INTO comprobantes_transferencia')) {
      assert.match(sql, /file_hash/);
      assert.match(sql, /dedupe_file_hash/);
      const key = `${params[0]}:${params[11]}`;
      if (rowsByKey.has(key)) {
        const error = new Error('duplicate key');
        error.code = '23505';
        error.constraint = 'uq_ct_file_hash_new';
        throw error;
      }
      const row = { id: nextId++, empresa_id: params[0], file_hash: params[10] };
      rowsByKey.set(key, row);
      return [row];
    }
    if (sql.includes('FROM comprobantes_transferencia')) {
      return [rowsByKey.get(`${params[0]}:${params[1]}`)];
    }
    throw new Error(`Consulta inesperada: ${sql}`);
  };
  const makeInput = (empresaId, filename) => {
    const absolutePath = path.join(dir, filename);
    fs.writeFileSync(absolutePath, filename);
    return {
      empresaId,
      choferId: 4,
      monto: 1500,
      metodo: 'transferencia',
      comentario: null,
      archivoPath: filename,
      pedidoId: 20,
      zonaId: null,
      comprobantePath: `/Transferencia/${filename}`,
      telefono: '5493510000000',
      fileHash: 'a'.repeat(64),
      estadoRevision: 'pendiente',
      riesgoScore: 0,
      riesgoFlags: null,
      absolutePath,
    };
  };

  try {
    const sameTenantInputs = [makeInput(7, 'same-a.jpg'), makeInput(7, 'same-b.jpg')];
    const sameTenantResults = await Promise.all(sameTenantInputs.map(input =>
      transferenciasRoute.reserveManualTransferUploadPg(input, { queryFn })
    ));

    assert.equal(sameTenantResults.filter(result => result.duplicate).length, 1);
    assert.equal(sameTenantResults.filter(result => !result.duplicate).length, 1);
    assert.equal(sameTenantInputs.filter(input => fs.existsSync(input.absolutePath)).length, 1);

    const otherTenant = makeInput(8, 'other-tenant.jpg');
    const otherTenantResult = await transferenciasRoute.reserveManualTransferUploadPg(otherTenant, { queryFn });
    assert.equal(otherTenantResult.duplicate, false);
    assert.equal(fs.existsSync(otherTenant.absolutePath), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reserva manual no suprime otras violaciones unique y borra su archivo no insertado', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pedivoy-manual-other-unique-'));
  const absolutePath = path.join(dir, 'kept.jpg');
  fs.writeFileSync(absolutePath, 'contenido');
  let calls = 0;
  const queryFn = async () => {
    calls += 1;
    if (calls > 1) return [];
    const error = new Error('otro unique');
    error.code = '23505';
    error.constraint = 'uq_comprobante_otro_campo';
    throw error;
  };

  try {
    await assert.rejects(
      transferenciasRoute.reserveManualTransferUploadPg({
        empresaId: 7,
        fileHash: 'c'.repeat(64),
        absolutePath,
      }, { queryFn }),
      error => error?.constraint === 'uq_comprobante_otro_campo'
    );
    assert.equal(calls, 1);
    assert.equal(fs.existsSync(absolutePath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reserva manual preserva error INSERT aunque falle unlink', async () => {
  const original = Object.assign(new Error('check ajeno'), { code: '23514', constraint: 'ct_check' });
  await assert.rejects(
    transferenciasRoute.reserveManualTransferUploadPg({ absolutePath: '/tmp/no-importa' }, {
      queryFn: async () => { throw original; },
      unlinkFn: async () => { throw new Error('unlink falló'); },
    }),
    error => error === original,
  );
});

test('reserva manual limpia el archivo perdedor aunque falle la lectura del duplicado', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pedivoy-manual-cleanup-'));
  const absolutePath = path.join(dir, 'loser.jpg');
  fs.writeFileSync(absolutePath, 'contenido');
  let calls = 0;
  const queryFn = async () => {
    calls += 1;
    if (calls === 1) {
      const error = new Error('duplicate key');
      error.code = '23505';
      error.constraint = 'uq_ct_file_hash_new';
      throw error;
    }
    throw new Error('falló lookup');
  };

  try {
    await assert.rejects(
      transferenciasRoute.reserveManualTransferUploadPg({
        empresaId: 7,
        fileHash: 'd'.repeat(64),
        absolutePath,
      }, { queryFn }),
      /falló lookup/
    );
    assert.equal(fs.existsSync(absolutePath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cargas manuales concurrentes reintentan colisiones con escritura exclusiva sin overwrite', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pedivoy-manual-upload-'));
  const collidedPath = path.join(dir, 'tr-forced.jpg');
  fs.writeFileSync(collidedPath, 'contenido-original');
  const ids = ['forced', 'forced', 'unique-a', 'unique-b'];
  const createId = () => ids.shift();

  try {
    const [first, second] = await Promise.all([
      saveManualTransferFile({ storageDir: dir, buffer: jpeg('primero'), mimetype: 'image/jpeg', createId }),
      saveManualTransferFile({ storageDir: dir, buffer: jpeg('segundo'), mimetype: 'image/jpeg', createId }),
    ]);

    assert.notEqual(first.filename, second.filename);
    assert.match(first.filename, /^tr-unique-[ab]\.jpg$/);
    assert.match(second.filename, /^tr-unique-[ab]\.jpg$/);
    assert.equal(fs.readFileSync(collidedPath, 'utf8'), 'contenido-original');
    assert.deepEqual(
      new Set([fs.readFileSync(first.absolutePath).toString('hex'), fs.readFileSync(second.absolutePath).toString('hex')]),
      new Set([jpeg('primero').toString('hex'), jpeg('segundo').toString('hex')])
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('carga manual deriva extensión del MIME y rechaza magic bytes o tamaño inválidos', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pedivoy-manual-policy-'));
  try {
    const saved = await saveManualTransferFile({
      storageDir: dir,
      buffer: jpeg('válido'),
      mimetype: 'image/jpeg',
      originalName: 'ataque.php',
      createId: () => 'safe-id',
    });
    assert.equal(saved.filename, 'tr-safe-id.jpg');

    await assert.rejects(
      saveManualTransferFile({
        storageDir: dir,
        buffer: Buffer.from('%PDF-falso-jpeg'),
        mimetype: 'image/jpeg',
      }),
      error => error?.code === 'INVALID_FILE_TYPE'
    );
    await assert.rejects(
      saveManualTransferFile({
        storageDir: dir,
        buffer: jpeg('demasiado-grande'),
        mimetype: 'image/jpeg',
        maxBytes: 4,
      }),
      error => error?.code === 'FILE_TOO_LARGE'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('endpoint de carga manual usa buffer validado y reserva exclusiva en vez de Date.now/diskStorage', async () => {
  const source = await readFile(new URL('../src/routes/transferencias.js', import.meta.url), 'utf8');
  const uploadStart = source.indexOf("router.post(\n    '/upload'");
  const uploadRoute = source.slice(uploadStart, source.indexOf('// VERIFICAR', uploadStart));
  assert.match(source, /storage:\s*multer\.memoryStorage\(\)/);
  assert.match(uploadRoute, /saveManualTransferFile/);
  assert.match(uploadRoute, /parseManualTransferFields\(body\)/);
  assert.ok(uploadRoute.indexOf('empresa_cuentas_bancarias') < uploadRoute.indexOf('saveManualTransferFile'));
  assert.match(uploadRoute, /let savedFile = null/);
  assert.match(uploadRoute, /let insertConfirmed = false/);
  assert.match(uploadRoute, /savedFile && !insertConfirmed/);
  assert.match(uploadRoute, /await unlink\(savedFile\.absolutePath\)/);
  assert.doesNotMatch(uploadRoute, /Date\.now|path\.extname/);
});
