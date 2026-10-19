// ============================================================================
// scripts/backfill-tunnel-crm-label.js — nom du tunnel sur les fiches Leads Live
// ----------------------------------------------------------------------------
// Contexte (19/10/2026) : les leads du quiz hébergé arrivent par Make →
// api/lead-optin.js, qui ne savait pas lire les tunnels. Leur fiche affichait
// la clé brute (`slug__optin-a`) ou « Funnel Quiz Élite », et le type
// « VSL Élite ». Les opt-ins directs (api/tunnel-optin.js) portaient
// « Tunnel · étape ». Les serveurs posent maintenant le nom Leads Live du
// tunnel (settings.crmLabel, sinon son nom) ; ce script remet les fiches
// existantes au même format.
//
// Cible : leads avec quizSubmittedAt, ou source 'tunnel' (fiches _merged
//         ignorées).
// Écrit, et rien d'autre :
//   · landingFirst / landingLast dont la page est une étape de tunnel connue :
//     label = nom Leads Live, stepLabel, tunnelId, stepId (le reste gardé) ;
//   · sourceDetail, s'il vaut encore un ancien libellé automatique (clé
//     brute, « Tunnel · étape », « VSL Élite », « Funnel Quiz Élite/Business »)
//     → nom Leads Live du dernier tunnel ;
//   · type : `vsl_elite` → type du tunnel quand il est réglé (hors
//     self_booking), sinon `quiz_funnel` pour un lead porteur d'un quiz.
//     Les autres types (business, self_booking…) ne sont jamais touchés.
// Les pages System.io historiques (quiz_elite, vsl_elite…) restent telles quelles.
//
// À lancer APRÈS avoir réglé, dans Tunnels → Réglages, le type « Quiz Funnel »
// et le « Nom affiché dans Leads Live » des tunnels concernés.
//
// Deux temps (règle du repo) :
//   node scripts/backfill-tunnel-crm-label.js            # LECTURE SEULE
//   node scripts/backfill-tunnel-crm-label.js --apply    # écrit, après validation
//
// Clé : GOOGLE_APPLICATION_CREDENTIALS=~/.secrets/ambitio-team-sa.json
// Accès REST natif (scripts/_firestore-rest.js).
// ============================================================================
'use strict';
const R = require('./_firestore-rest.js');

const APPLY = process.argv.indexOf('--apply') >= 0;
const TUNNEL_KEY_RE = /^[a-z0-9-]{1,40}__[a-z0-9-]{1,40}$/;
const OLD_AUTO_LABELS = { 'VSL Élite': 1, 'VSL Business': 1, 'Funnel Quiz Élite': 1, 'Funnel Quiz Business': 1, 'Quiz Funnel': 1 };

function cleanSlug(v, max) {
  return String(v || '').toLowerCase().trim().replace(/[^a-z0-9-]/g, '').slice(0, max || 40);
}
function crmLabelOf(t) {
  const c = String((t.settings && t.settings.crmLabel) || '').trim().slice(0, 80);
  return c || t.name || t.slug || 'Tunnel';
}

async function loadPages() {
  const docs = await R.runQuery({ from: [{ collectionId: 'tunnels' }], limit: 500 });
  const map = {};
  docs.forEach(function (x) {
    const t = x.data || {};
    t.id = x.id;
    if (t.archived === true || t.kind === 'test') return;
    const ts = cleanSlug(t.slug);
    if (!ts) return;
    (Array.isArray(t.steps) ? t.steps : []).forEach(function (s) {
      if (!s || !s.id) return;
      const key = ts + '__' + cleanSlug(s.slug);
      map[key] = {
        tunnel: t, step: s,
        label: crmLabelOf(t),
        oldLabel: (t.name || t.slug) + ((s.name || s.slug) ? ' · ' + (s.name || s.slug) : '')
      };
    });
  });
  return map;
}

function fixLanding(la, pages) {
  if (!la || !la.page || !TUNNEL_KEY_RE.test(la.page)) return null;
  const hit = pages[la.page];
  if (!hit) return null;
  const stepLabel = hit.step.name || hit.step.slug || '';
  if (la.label === hit.label && la.stepLabel === stepLabel && la.tunnelId === hit.tunnel.id) return null;
  return Object.assign({}, la, { label: hit.label, stepLabel: stepLabel, tunnelId: hit.tunnel.id, stepId: hit.step.id });
}

(async function () {
  setTimeout(function () { console.error('TIMEOUT 180 s'); process.exit(2); }, 180000);
  const pages = await loadPages();
  console.log('Tunnels : ' + Object.keys(pages).length + ' étape(s) connue(s)');
  const a = await R.runQuery({ from: [{ collectionId: 'leads' }], where: R.ff('quizSubmittedAt', 'GREATER_THAN_OR_EQUAL', new Date('2026-01-01T00:00:00Z')), limit: 2000 });
  const b = await R.runQuery({ from: [{ collectionId: 'leads' }], where: R.ff('source', 'EQUAL', 'tunnel'), limit: 2000 });
  const byId = {};
  a.concat(b).forEach(function (x) { byId[x.id] = x; });
  const leads = Object.keys(byId).map(function (k) { return byId[k]; });
  console.log((APPLY ? '[APPLY] ' : '[DRY-RUN] ') + leads.length + ' lead(s) candidats (quiz ou tunnel)');

  let todo = 0, done = 0;
  for (const x of leads) {
    const l = x.data || {};
    if (l._merged === true) continue;
    const fields = {}, mask = [];
    const lf = fixLanding(l.landingFirst, pages);
    const ll = fixLanding(l.landingLast, pages);
    if (lf) { fields.landingFirst = lf; mask.push('landingFirst'); }
    if (ll) { fields.landingLast = ll; mask.push('landingLast'); }

    const last = (l.landingLast && pages[l.landingLast.page]) || (l.landingFirst && pages[l.landingFirst.page]) || null;
    const sd = String(l.sourceDetail || '');
    if (last && sd !== last.label) {
      const lastPage = (l.landingLast && l.landingLast.page) || (l.landingFirst && l.landingFirst.page) || '';
      const oldLbl = (l.landingLast && l.landingLast.label) || '';
      if (!sd || OLD_AUTO_LABELS[sd] || sd === lastPage || sd === last.oldLabel || sd === oldLbl) {
        fields.sourceDetail = last.label; mask.push('sourceDetail');
      }
    }

    if (l.type === 'vsl_elite') {
      const tt = last ? String((last.tunnel.settings && last.tunnel.settings.leadType) || '').toLowerCase().replace(/[^a-z0-9_]/g, '') : '';
      let nt = '';
      if (tt && tt !== 'self_booking' && tt !== 'vsl_elite') nt = tt;
      else if (l.quizSubmittedAt || l.quiz) nt = 'quiz_funnel';
      if (nt) { fields.type = nt; mask.push('type'); }
    }

    if (!mask.length) continue;
    todo++;
    console.log('  → ' + x.id + ' | ' + (l.email || l.telephone || '?') + ' | type=' + l.type + ' | sourceDetail=' + sd
      + ' | tunnel=' + ((l.landingLast && l.landingLast.label) || (l.landingFirst && l.landingFirst.label) || '—')
      + '\n      écrirait : ' + mask.map(function (k) {
        const v = fields[k];
        return k + '=' + (typeof v === 'object' ? JSON.stringify({ label: v.label, stepLabel: v.stepLabel }) : v);
      }).join(' ; '));
    if (APPLY) {
      await R.patchDoc(x.path.split('/documents/')[1], fields, mask);
      done++;
    }
  }
  console.log(APPLY ? 'Écrits : ' + done : 'À écrire : ' + todo + ' fiche(s) — relancer avec --apply après validation');
  process.exit(0);
})().catch(function (e) { console.error('ERREUR', e.message); process.exit(1); });
