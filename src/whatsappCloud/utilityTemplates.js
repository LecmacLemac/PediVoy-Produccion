// Closed, transport-independent contracts. Values never appear in validation errors.
export const UTILITY_TEMPLATE_FIELDS = Object.freeze({
  order_confirmation: Object.freeze(['customer_name', 'items_block', 'total', 'address', 'delivery_date', 'delivery_window', 'driver_name', 'driver_phone']),
  transfer_payment: Object.freeze(['customer_name', 'amount', 'alias', 'cbu', 'bank', 'holder', 'company_name']),
  order_en_route: Object.freeze(['customer_name', 'address', 'tracking_token']),
});
export const UTILITY_TEMPLATE_KEYS = Object.freeze(Object.keys(UTILITY_TEMPLATE_FIELDS));
const invalid = () => { throw Object.assign(new Error('cloud_template_payload_invalid'), { code: 'cloud_template_payload_invalid' }); };
function record(value, keys) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value'))) invalid();
}
export function validateUtilityTemplateIntent(intent) {
  record(intent, ['key', 'parameters']);
  if (!UTILITY_TEMPLATE_KEYS.includes(intent.key)) invalid();
  const fields = UTILITY_TEMPLATE_FIELDS[intent.key];
  record(intent.parameters, fields);
  const parameters = {};
  for (const field of fields) {
    const value = intent.parameters[field];
    const limit = field === 'items_block' ? 600 : field === 'address' ? 500 : 200;
    const controls = field === 'items_block' ? /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u : /[\u0000-\u001f\u007f-\u009f]/u;
    if (typeof value !== 'string' || !value.trim() || value.length > limit || controls.test(value)) invalid();
    if (field === 'tracking_token' && !/^[A-Za-z0-9_-]+$/.test(value)) invalid();
    if (field === 'items_block' && (value.split('\n').length > 8 || value.split('\n').some(line => !line.trim()))) invalid();
    if (!value.isWellFormed()) invalid();
    parameters[field] = value;
  }
  return { key: intent.key, parameters };
}
export const buildOrderEnRouteIntent = parameters => validateUtilityTemplateIntent({ key: 'order_en_route', parameters });

export const buildOrderConfirmationIntent = parameters => validateUtilityTemplateIntent({ key: 'order_confirmation', parameters });
export const buildTransferPaymentIntent = parameters => validateUtilityTemplateIntent({ key: 'transfer_payment', parameters });

export function validateTemplateMapping(mapping) {
  try {
    record(mapping, ['name', 'language']);
    if (typeof mapping.name !== 'string' || typeof mapping.language !== 'string') invalid();
    const name = mapping.name.trim();
    const language = mapping.language.trim();
    if (!/^[a-z0-9_]{1,512}$/.test(name) || language !== 'es_AR') invalid();
    return { name, language };
  } catch {
    throw Object.assign(new Error('cloud_template_config_invalid'), { code: 'cloud_template_config_invalid' });
  }
}

export function buildMetaTemplateComponents(input) {
  const { key, parameters } = validateUtilityTemplateIntent(input);
  const components = [{ type: 'body', parameters: UTILITY_TEMPLATE_FIELDS[key]
    .filter(field => field !== 'tracking_token').map(field => ({ type: 'text', text: parameters[field] })) }];
  if (key === 'order_en_route') components.push({
    type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: parameters.tracking_token }],
  });
  return components;
}

// Accept already grouped/formatted product lines; never split a product or surrogate pair.
export function boundOrderItemsBlock(input) {
  const lines = typeof input === 'string' ? input.replace(/\r\n/g, '\n').split('\n') : input;
  if (!Array.isArray(lines) || !lines.length || lines.some(line => typeof line !== 'string'
      || !line.trim() || !line.isWellFormed() || /[\u0000-\u001f\u007f-\u009f]/u.test(line))) invalid();
  for (let count = Math.min(8, lines.length); count >= 0; count--) {
    const selected = lines.slice(0, count);
    if (count < lines.length) selected.push(`… y ${lines.length - count} productos más`);
    const block = selected.join('\n');
    if (selected.length <= 8 && block.length <= 600) return block;
  }
  invalid();
}
