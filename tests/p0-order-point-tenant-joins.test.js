import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function templateLiterals(source) {
  const blocks = [];
  for (let start = 0; start < source.length; start += 1) {
    if (source[start] !== '`' || source[start - 1] === '\\') continue;
    let value = '';
    let escaped = false;
    for (let index = start + 1; index < source.length; index += 1) {
      const char = source[index];
      if (escaped) {
        value += char;
        escaped = false;
      } else if (char === '\\') {
        value += char;
        escaped = true;
      } else if (char === '`') {
        blocks.push(value);
        start = index;
        break;
      } else {
        value += char;
      }
    }
  }
  return blocks;
}

function orderPointBlocks(relativePath) {
  const source = fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  return templateLiterals(source).filter(sql =>
    /\bpedidos\s+(?:AS\s+)?p\b/i.test(sql)
    && /\bpuntos_entrega\s+(?:AS\s+)?\w+\b/i.test(sql)
  );
}

function assertDirectPedidoPuntoClosure(sql, label) {
  const direct = [...sql.matchAll(/(?:JOIN\s+puntos_entrega\s+(\w+)\s+ON|JOIN\s+pedidos\s+(p)\s+ON)([\s\S]*?)(?=\b(?:LEFT|RIGHT|FULL|INNER|JOIN|WHERE|GROUP|ORDER|LIMIT|HAVING|RETURNING|FOR)\b|$)/gi)];
  assert.ok(direct.length > 0, `${label}: no se pudo inventariar el JOIN pedido-punto\n${sql}`);
  for (const match of direct) {
    const pointAlias = match[1];
    const orderAlias = match[2];
    const on = match[3];
    if (pointAlias === 'pe') {
      assert.match(on, /pe\.empresa_id\s*=\s*p\.empresa_id|p\.empresa_id\s*=\s*pe\.empresa_id/i,
        `${label}: JOIN p↔pe sin igualdad tenant\n${sql}`);
    } else if (orderAlias === 'p' && /p\.punto_entrega_id\s*=\s*pe\.id|pe\.id\s*=\s*p\.punto_entrega_id/i.test(on)) {
      assert.match(on, /pe\.empresa_id\s*=\s*p\.empresa_id|p\.empresa_id\s*=\s*pe\.empresa_id/i,
        `${label}: JOIN pe↔p sin igualdad tenant\n${sql}`);
    }
  }
}

test('inventario exhaustivo de reportes: los cinco bloques pedido-punto cierran padre, hijo y tenant', () => {
  const blocks = orderPointBlocks('../src/routes/reportes.js');
  assert.equal(blocks.length, 5, `inventario reportes inesperado: ${blocks.length}`);
  for (const [index, sql] of blocks.entries()) {
    assertDirectPedidoPuntoClosure(sql, `reportes #${index + 1}`);
    assert.match(sql, /p\.empresa_id\s*=\s*\$1/i, `reportes #${index + 1}: falta tenant del pedido\n${sql}`);
    assert.match(sql, /pe\.empresa_id\s*=\s*(?:p\.empresa_id|\$1)/i, `reportes #${index + 1}: falta tenant del punto\n${sql}`);
  }
});

test('inventario exhaustivo de estrategias: ocho bloques pedido-punto no interpretan relaciones cross-tenant', () => {
  const blocks = orderPointBlocks('../src/estrategias.js');
  assert.equal(blocks.length, 8, `inventario estrategias inesperado: ${blocks.length}`);
  for (const [index, sql] of blocks.entries()) {
    if (/JOIN\s+puntos_entrega\s+pe\s+ON/i.test(sql) || /JOIN\s+pedidos\s+p\s+ON/i.test(sql)) {
      assertDirectPedidoPuntoClosure(sql, `estrategias #${index + 1}`);
    }
    if (/FROM\s+pedidos\s+p[\s\S]*JOIN\s+puntos_entrega\s+pe/i.test(sql)) {
      assert.match(sql, /p\.empresa_id\s*=\s*\$\d+|\$\{filtroEmpresa\}/i, `estrategias #${index + 1}: falta tenant del pedido\n${sql}`);
      assert.match(sql, /pe\.empresa_id\s*=\s*(?:p\.empresa_id|\$\d+)/i, `estrategias #${index + 1}: falta tenant del punto\n${sql}`);
    }
    for (const subquery of sql.matchAll(/FROM\s+pedidos\s+p\s+WHERE([\s\S]*?)(?=\)|LIMIT|$)/gi)) {
      if (/p\.punto_entrega_id\s*=\s*pe\.id/i.test(subquery[1])) {
        assert.match(subquery[1], /p\.empresa_id\s*=\s*pe\.empresa_id/i,
          `estrategias #${index + 1}: subconsulta pedido-punto sin tenant\n${sql}`);
      }
    }
  }
});

test('inventario exhaustivo de transferencias: asociación manual y ambas ramas automáticas cierran pedido-punto', () => {
  const blocks = orderPointBlocks('../src/transferenciasServices.js');
  assert.equal(blocks.length, 4, `inventario transferencias inesperado: ${blocks.length}`);
  for (const [index, sql] of blocks.entries()) {
    assertDirectPedidoPuntoClosure(sql, `transferencias #${index + 1}`);
    assert.match(sql, /p\.empresa_id\s*=\s*pe\.empresa_id|pe\.empresa_id\s*=\s*p\.empresa_id/i,
      `transferencias #${index + 1}: falta cierre tenant de relación\n${sql}`);
  }
});

test('callers de transferencias derivan tenant desde auth o configuración server-side', () => {
  const route = fs.readFileSync(new URL('../src/routes/transferencias.js', import.meta.url), 'utf8');
  const pipeline = fs.readFileSync(new URL('../src/transferenciasPipeline.js', import.meta.url), 'utf8');
  const association = route.slice(
    route.indexOf("router.post('/:id/asociar-pedido'"),
    route.indexOf('// VERIFICAR'),
  );
  assert.match(association, /actorEmpresaId:\s*req\.user\?\.empresa_id/);
  assert.doesNotMatch(association, /actorEmpresaId:\s*req\.body/);
  assert.match(pipeline, /empresaId:\s*canalEmpresaId/);
  assert.doesNotMatch(pipeline, /empresaId:\s*filePayload/);
});
