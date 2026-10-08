// ============================================================================
// api/mcp.js — SERVEUR MCP ALTEORE (programme IA, Lot 5) — LECTURE SEULE
// ----------------------------------------------------------------------------
// Permet à Adrien de brancher Claude (claude.ai, Claude Desktop, Claude Code)
// directement sur les données Alteore, et de les croiser avec ses autres
// connecteurs (Meta Ads, Gmail, Fathom…). Mêmes outils que « Demande à
// Alteore » (api/_aiTools.js) : AUCUNE écriture possible.
//
// Transport : MCP « Streamable HTTP », réponses JSON (pas de flux SSE).
// Méthodes : initialize, notifications/initialized, ping, tools/list,
// tools/call.
// Accès : secret partagé MCP_SECRET (variable Vercel, ≥ 32 caractères),
//   - en en-tête  Authorization: Bearer <MCP_SECRET>   (Claude Desktop / Code)
//   - ou dans l'URL https://team.alteore.com/api/mcp?key=<MCP_SECRET>
//     (connecteur personnalisé claude.ai sans OAuth — l'URL EST le secret :
//      ne jamais la partager ; la changer = changer MCP_SECRET).
// Les appels d'outils ne consomment PAS le budget API (ils lisent Firestore ;
// c'est l'abonnement Claude d'Adrien qui fait tourner le modèle).
// ============================================================================

const crypto = require('crypto');
const { db } = require('./_firebaseAdmin');
const { TOOLS, runTool } = require('./_aiTools');

const SERVER = { name: 'alteore', version: '1.0.0' };
const INSTRUCTIONS = 'Données internes d\'Alteore (coaching business B2B) en lecture seule : leads, RDV commerciaux et issues, appels, clients coaching et leur feu tricolore, impayés, objections, consommation IA. Les dates sont au format AAAA-MM-JJ, fuseau Europe/Paris.';

function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function authorized(req) {
  const secret = process.env.MCP_SECRET || '';
  if (secret.length < 32) return false;
  const h = String(req.headers['authorization'] || '');
  if (h.indexOf('Bearer ') === 0 && safeEqual(h.slice(7).trim(), secret)) return true;
  return safeEqual((req.query && req.query.key) || '', secret);
}

function ok(id, result) { return { jsonrpc: '2.0', id: id, result: result }; }
function err(id, code, message) { return { jsonrpc: '2.0', id: id == null ? null : id, error: { code: code, message: message } }; }

async function handle(msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return err(msg && msg.id, -32600, 'Invalid Request');
  const id = msg.id;
  const isNotification = id === undefined || id === null;
  const p = msg.params || {};
  switch (msg.method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: typeof p.protocolVersion === 'string' ? p.protocolVersion : '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER,
        instructions: INSTRUCTIONS,
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: TOOLS.map(function (t) {
        return { name: t.name, description: t.description, inputSchema: t.input_schema, annotations: { readOnlyHint: true, openWorldHint: false } };
      }) });
    case 'tools/call': {
      const name = String(p.name || '');
      if (!TOOLS.some(function (t) { return t.name === name; })) return err(id, -32602, 'Outil inconnu : ' + name);
      const out = await runTool(name, p.arguments || {});
      try { await db.collection('ai_usage').add({ task: 'mcp:' + name, model: 'mcp', ok: !(out && out.error), costUsd: 0, at: Date.now(), month: new Date().toISOString().slice(0, 7) }); } catch (e) { /* traçabilité best-effort */ }
      return ok(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 1).slice(0, 200000) }], isError: !!(out && out.error) });
    }
    default:
      return isNotification ? null : err(id, -32601, 'Méthode non supportée : ' + msg.method);
  }
}

module.exports = async function (req, res) {
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (!authorized(req)) { res.status(401).json(err(null, -32001, 'Non autorisé')); return; }
  if (req.method === 'GET') { res.status(405).setHeader('Allow', 'POST'); res.end(); return; }
  if (req.method === 'DELETE') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).end(); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { res.status(400).json(err(null, -32700, 'Parse error')); return; } }
  try {
    if (Array.isArray(body)) {
      const outs = (await Promise.all(body.map(handle))).filter(Boolean);
      if (!outs.length) { res.status(202).end(); return; }
      res.status(200).json(outs);
      return;
    }
    const out = await handle(body);
    if (!out) { res.status(202).end(); return; }
    res.status(200).json(out);
  } catch (e) {
    console.error('[mcp]', e);
    res.status(200).json(err(body && body.id, -32603, e && e.message ? e.message : 'Erreur interne'));
  }
};
