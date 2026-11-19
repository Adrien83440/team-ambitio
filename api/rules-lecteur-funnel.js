// ============================================================================
// api/rules-lecteur-funnel.js — PUBLICATION DU BLOC DE RÈGLES « LECTEUR FUNNEL »
// (19/11/2026, demande d'Adrien : « publie les rules toi »)
// ----------------------------------------------------------------------------
// La Console Firebase est la source de vérité des règles (CLAUDE.md) : cette
// route ne publie JAMAIS le fichier firestore.rules du dépôt. Elle LIT les
// règles actuellement publiées, y AJOUTE seulement le bloc autonome
// « LECTEUR FUNNEL » (copie embarquée api/_rulesLecteurFunnelBlock.js du bloc
// de firestore.rules, entre ses deux marqueurs), et publie.
// Si le bloc est déjà là (ancienne version), il est remplacé, rien d'autre.
//
//   GET ?key=<RULES_LECTEUR_KEY>              → dry-run : ce qui changerait
//   GET ?key=…&apply=1                         → publie (compilé par Firebase :
//                                                une erreur de syntaxe refuse
//                                                tout, rien n'est publié)
//   GET ?key=…&rollback=<nom du ruleset>       → republie une version d'avant
//
// Clé : variable Vercel RULES_LECTEUR_KEY (jamais dans le dépôt) ; absente →
// 404. Accès Admin SDK (compte de service Firebase). Trace : rules_deploys/*.
// ============================================================================
'use strict';

const crypto = require('crypto');
const BLOCK = require('./_rulesLecteurFunnelBlock');
const { admin, db } = require('./_firebaseAdmin');

const START = '    // ═══ LECTEUR FUNNEL';
const END = '// ═══ FIN LECTEUR FUNNEL';

function keyOk(k) {
  const want = process.env.RULES_LECTEUR_KEY || '';
  const a = Buffer.from(String(k || '')), b = Buffer.from(want);
  return want.length >= 24 && a.length === b.length && crypto.timingSafeEqual(a, b);
}
function blockOf(src) {
  const a = src.indexOf(START);
  if (a < 0) return null;
  const e = src.indexOf(END, a);
  if (e < 0) return null;
  const b = src.indexOf('\n', e);
  return { start: a, end: b < 0 ? src.length : b + 1, text: src.slice(a, b < 0 ? src.length : b + 1) };
}
/* Nouvelle source = source publiée + bloc (inséré avant les deux accolades
   finales « } } »), ou bloc remplacé s'il y est déjà. */
function merged(live, block) {
  const cur = blockOf(live);
  if (cur) {
    if (cur.text === block) return { action: 'identique', src: live };
    return { action: 'remplace', src: live.slice(0, cur.start) + block + live.slice(cur.end) };
  }
  if (/function\s+isFunnelViewer\s*\(/.test(live)) return { action: 'conflit', src: null };
  const m = /\}\s*\}\s*$/.exec(live);
  if (!m) return { action: 'structure_inconnue', src: null };
  const head = live.slice(0, m.index).replace(/\s*$/, '\n');
  return { action: 'ajoute', src: head + '\n' + block + live.slice(m.index).replace(/^\s*/, '  ') };
}

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};
  if (!keyOk(q.key)) { res.status(404).json({ ok: false }); return; }
  try {
    const SR = admin.securityRules();
    const live = await SR.getFirestoreRuleset();
    const liveSrc = (live.source && live.source[0] && live.source[0].content) || '';
    if (q.rollback) {
      const name = String(q.rollback);
      const r = await SR.releaseFirestoreRuleset(name);
      await db.collection('rules_deploys').add({ at: admin.firestore.FieldValue.serverTimestamp(), action: 'rollback', to: name, from: live.name });
      res.status(200).json({ ok: true, rollback: true, released: r && r.name ? r.name : name, previous: live.name });
      return;
    }
    /* Bloc embarqué (firestore.rules n'est pas déployé, voir .vercelignore). */
    const blk = blockOf(BLOCK);
    if (!blk) { res.status(500).json({ ok: false, error: 'bloc LECTEUR FUNNEL embarqué illisible' }); return; }
    const m = merged(liveSrc, blk.text);
    const out = {
      ok: true, liveRuleset: live.name, liveCreated: live.createTime || null,
      liveLines: liveSrc.split('\n').length, action: m.action,
      newLines: m.src ? m.src.split('\n').length : null,
      blockLines: blk.text.split('\n').length,
      /* Contrôle : hors du bloc, la nouvelle source est identique caractère pour caractère à la publiée. */
      untouchedOutsideBlock: m.src ? (function () {
        const nb = blockOf(m.src);
        const strip = function (s, b) { return (b ? s.slice(0, b.start) + s.slice(b.end) : s).replace(/\s+/g, ''); };
        return strip(m.src, nb) === strip(liveSrc, blockOf(liveSrc));
      })() : null
    };
    if (!q.apply || m.action === 'identique' || !m.src) { out.dry = !q.apply; res.status(200).json(out); return; }
    if (!out.untouchedOutsideBlock) { res.status(409).json(Object.assign(out, { ok: false, error: 'contrôle échoué : autre chose que le bloc changerait' })); return; }
    const rel = await SR.releaseFirestoreRulesetFromSource(m.src);
    await db.collection('rules_deploys').add({ at: admin.firestore.FieldValue.serverTimestamp(), action: m.action, block: 'lecteur_funnel', from: live.name, to: rel && rel.name || null });
    out.published = rel && rel.name || true;
    out.previousRuleset = live.name;
    res.status(200).json(out);
  } catch (e) {
    console.error('[rules-lecteur-funnel]', e);
    res.status(500).json({ ok: false, error: String(e && e.message || e).slice(0, 600) });
  }
};
module.exports.merged = merged;
module.exports.blockOf = blockOf;
