// =========================================================================
// Generic ("Custom") POS connector — the no-code translator
// =========================================================================
// Handles the common shape most simple POS APIs follow: one request, a
// token in a header, a JSON body. Configured entirely from super admin -
// no file, no deploy, per business.
//
// `config` expected shape:
//   {
//     endpoint: string,              // full URL to POST to
//     authHeaderName: string,        // e.g. "Authorization"
//     authHeaderValue: string,       // e.g. "Bearer abc123"
//     bodyTemplate: string,          // JSON string with {{placeholders}}
//     responseIdPath: string,        // dot-path to the order id in the response, e.g. "data.id"
//   }
//
// Template placeholders available: {{table}}, {{note}}, {{total}}, {{items}}
// - {{items}} is replaced with a JSON array of {name, price, quantity, note}
// - everything else is replaced with its plain value
//
// HONEST LIMIT, stated plainly: this only covers the common single-request
// shape. POS systems needing a login step before the real request, a
// multi-step flow (look up a customer, then book), or non-JSON formats
// still need a real one-time adapter file, same as Foodics/Zenoti/etc.
// =========================================================================

function fillTemplate(template, order, items) {
  const itemsJson = JSON.stringify(
    items.map((i) => ({ name: i.item_name, price: i.unit_price, quantity: i.quantity, note: i.note || '' }))
  );

  return template
    .replaceAll('{{table}}', JSON.stringify(order.table_label || ''))
    .replaceAll('{{note}}', JSON.stringify(order.note || ''))
    .replaceAll('{{total}}', String(order.total ?? 0))
    .replaceAll('{{items}}', itemsJson);
}

// Reads a value out of a nested object using a simple dot-path,
// e.g. getByPath({data: {id: 5}}, "data.id") -> 5
function getByPath(obj, path) {
  if (!path) return undefined;
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

async function pushOrder(config, order, items) {
  if (!config?.endpoint || !config?.bodyTemplate) {
    return { success: false, error: 'Custom connector is not fully configured (missing endpoint or body template)' };
  }

  let body;
  try {
    body = fillTemplate(config.bodyTemplate, order, items);
    JSON.parse(body); // validate the filled-in template is still valid JSON before sending
  } catch (err) {
    return { success: false, error: `Body template did not produce valid JSON: ${err.message}` };
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (config.authHeaderName && config.authHeaderValue) {
      headers[config.authHeaderName] = config.authHeaderValue;
    }

    const response = await fetch(config.endpoint, { method: 'POST', headers, body });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return { success: false, error: data.message || `Request failed with status ${response.status}` };
    }

    const externalId = getByPath(data, config.responseIdPath);
    return { success: true, externalOrderId: externalId != null ? String(externalId) : '' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { pushOrder };
