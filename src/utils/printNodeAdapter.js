// =========================================================================
// PrintNode cloud printing connector - lets Tavzio's cloud backend send a
// print job to a physical receipt printer sitting inside a restaurant.
// Confirmed against PrintNode's own docs (https://www.printnode.com/en/docs):
// REST API at api.printnode.com, HTTP Basic auth using the account's API
// key as the username (empty password), raw print jobs sent as base64.
// Requires the free PrintNode Client running on whatever computer is
// physically connected to the printer - that's a one-time setup on the
// business's side, not something this backend can skip or automate.
// =========================================================================

const PRINTNODE_BASE = 'https://api.printnode.com';

function authHeader(apiKey) {
  return { Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}` };
}

// @returns { success, printers: [{ id, name, description, state }] } | { success: false, error }
async function listPrinters(apiKey) {
  if (!apiKey) return { success: false, error: 'No API key provided' };
  try {
    const res = await fetch(`${PRINTNODE_BASE}/printers`, { headers: authHeader(apiKey) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { success: false, error: `PrintNode rejected the API key (${res.status}): ${text || 'unauthorized'}` };
    }
    const data = await res.json();
    return {
      success: true,
      printers: (data || []).map((p) => ({ id: p.id, name: p.name, description: p.description, state: p.state })),
    };
  } catch (err) {
    return { success: false, error: err.message || 'Could not reach PrintNode' };
  }
}

// Sends a raw-text print job (works for any receipt/thermal printer the
// PrintNode Client already has configured) - content is plain text lines,
// base64-encoded per PrintNode's "raw" content type requirement.
async function sendPrintJob(config, contentText) {
  if (!config?.apiKey || !config?.printerId) {
    return { success: false, error: 'Printer is not connected' };
  }
  try {
    const res = await fetch(`${PRINTNODE_BASE}/printjobs`, {
      method: 'POST',
      headers: { ...authHeader(config.apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        printerId: Number(config.printerId),
        title: 'Tavzio table receipt',
        contentType: 'raw_base64',
        content: Buffer.from(contentText, 'utf8').toString('base64'),
        source: 'Tavzio',
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { success: false, error: `PrintNode print job failed (${res.status}): ${text || 'unknown error'}` };
    }
    const jobId = await res.json();
    return { success: true, jobId };
  } catch (err) {
    return { success: false, error: err.message || 'Could not reach PrintNode' };
  }
}

module.exports = { listPrinters, sendPrintJob };
