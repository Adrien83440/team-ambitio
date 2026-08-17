// ============================================================================
// api/ringover-diag-states.js
// ----------------------------------------------------------------------------
// DIAGNOSTIC EN LECTURE SEULE — comment Ringover qualifie-t-il réellement ses
// appels, et le répondeur est-il distinguable d'une vraie conversation ?
//
// URL  : GET https://team.alteore.com/api/ringover-diag-states?hours=168
// Auth : requireAdmin
//
// ─── POURQUOI ─────────────────────────────────────────────────────────
// Le funnel annonce 81,8 % de décrochés sur les appels sortants d'Élodie,
// alors qu'elle constate l'inverse sur le terrain. Le prédicat actuel est
// « durationSec >= 5 s », et une annonce de répondeur dure bien plus de
// 5 secondes : elle passe donc pour une conversation.
//
// Or `last_state` et `is_answered` sont lus par le sync (ringover-sync-cron)
// mais JAMAIS stockés sur le document call_logs — seule la durée l'est.
// Impossible de trancher sur les données existantes : il faut redemander à
// Ringover ce qu'il sait vraiment de ces appels.
//
// Cet endpoint N'ÉCRIT RIEN et NE PASSE AUCUN APPEL. Il interroge l'historique
// et rend la distribution croisée last_state × is_answered × durée, pour
// répondre à une seule question : existe-t-il un état « répondeur » exploitable,
// et sinon, une signature de durée le trahit-elle ?
//
// ⚠ À SUPPRIMER une fois la règle de décroché arrêtée. C'est un outil de
//    décision, pas une brique du produit.
// ============================================================================

const { requireAdmin } = require('./_verifyFirebaseAuth');
const { ringoverFetch } = require('./_ringoverClient');

// Tranches de durée de conversation. Le répondeur, s'il n'est pas signalé
// comme tel, doit se voir ici : une annonce dure typiquement 15-40 s et se
// termine à la tonalité, produisant un pic là où une vraie conversation
// s'étale.
const BUCKETS = [
  { max: 0,    label: '0 s (jamais décroché)' },
  { max: 4,    label: '1-4 s' },
  { max: 9,    label: '5-9 s' },
  { max: 14,   label: '10-14 s' },
  { max: 19,   label: '15-19 s' },
  { max: 29,   label: '20-29 s' },
  { max: 44,   label: '30-44 s' },
  { max: 59,   label: '45-59 s' },
  { max: 119,  label: '1-2 min' },
  { max: 299,  label: '2-5 min' },
  { max: 1e9,  label: '5 min et +' },
];

function bucketOf(sec) {
  for (let i = 0; i < BUCKETS.length; i++) if (sec <= BUCKETS[i].max) return BUCKETS[i].label;
  return '?';
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const auth = await requireAdmin(req, res);
  if (!auth) return;

  const q = req.query || {};
  let hours = parseInt(q.hours, 10);
  if (isNaN(hours) || hours < 1) hours = 168;
  hours = Math.min(hours, 168);           // Ringover plafonne la fenêtre à 7 j

  const now = new Date();
  const start = new Date(now.getTime() - hours * 3600000);

  // ─── Récupération de l'historique (même pagination que le cron) ──────
  let callList = [];
  try {
    let offset = 0;
    const limit = 200;
    while (true) {
      const qs = new URLSearchParams({
        start_date:   start.toISOString(),
        end_date:     now.toISOString(),
        limit_count:  String(limit),
        limit_offset: String(offset),
      }).toString();
      const resp = await ringoverFetch(`/calls?${qs}`, { method: 'GET' });
      const list = (resp && resp.call_list) || [];
      callList = callList.concat(list);
      const total = (resp && resp.total_call_count) || 0;
      if (list.length < limit || callList.length >= total || list.length === 0) break;
      offset += limit;
      if (offset > 5000) break;
    }
  } catch (e) {
    console.error('[ringover-diag-states] fetch error:', e && e.message);
    return res.status(502).json({ error: 'ringover_api_error', message: (e && (e.rawResponse || e.message)) || 'inconnu' });
  }

  // ─── Distribution croisée ───────────────────────────────────────────
  const out = callList.filter((c) => c && c.direction === 'out');
  const byState = {};       // last_state → { n, answered, durations{bucket:n}, exemples[] }
  const allKeys = {};       // inventaire des champs renvoyés, pour repérer
                            // un éventuel indicateur de répondeur non exploité

  out.forEach((c) => {
    Object.keys(c || {}).forEach((k) => { allKeys[k] = (allKeys[k] || 0) + 1; });
    const st = String(c.last_state == null ? '(absent)' : c.last_state);
    if (!byState[st]) byState[st] = { n: 0, isAnsweredTrue: 0, durees: {}, exemples: [] };
    const b = byState[st];
    b.n++;
    if (c.is_answered === true) b.isAnsweredTrue++;
    const sec = Math.max(0, Math.round(Number(c.incall_duration) || 0));
    const bk = bucketOf(sec);
    b.durees[bk] = (b.durees[bk] || 0) + 1;
    if (b.exemples.length < 4) {
      b.exemples.push({
        incall_duration: sec,
        total_duration: Number(c.total_duration) || 0,
        is_answered: c.is_answered === true,
        start_time: c.start_time || null,
      });
    }
  });

  // Ce que dirait la règle ACTUELLE du funnel, pour mesurer l'écart.
  const seuil5 = out.filter((c) => (Number(c.incall_duration) || 0) >= 5).length;
  const isAnswered = out.filter((c) => c.is_answered === true).length;

  res.status(200).json({
    ok: true,
    fenetreHeures: hours,
    appelsSortants: out.length,
    regleActuelle: {
      description: 'durationSec >= 5 s — celle du funnel aujourd\'hui',
      decroches: seuil5,
      taux: out.length ? Math.round(seuil5 / out.length * 1000) / 10 : null,
    },
    selonRingover: {
      description: 'is_answered == true, tel que Ringover le déclare',
      decroches: isAnswered,
      taux: out.length ? Math.round(isAnswered / out.length * 1000) / 10 : null,
    },
    // LA réponse cherchée : si un état distingue le répondeur, il est ici.
    parLastState: byState,
    // Si aucun état ne le fait, un champ non exploité le trahit peut-être.
    champsDisponibles: Object.keys(allKeys).sort(),
  });
};
