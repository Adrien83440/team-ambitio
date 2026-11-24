// ============================================================================
// api/parcours-frein.js — FREIN PRINCIPAL APRÈS UN « NON » (24/11/2026)
// ----------------------------------------------------------------------------
// Demande d'Adrien du 24/11/2026 : un prospect qui ne signe pas reçoit une
// séquence ActiveCampaign adaptée à SON frein. Le closer n'a rien à faire
// (« ils vont oublier ») : le lendemain du RDV, l'IA lit l'appel et choisit.
//
// Chaque jour (cron du matin) : RDV commerciaux du parcours, issue
// `non_close`, de J-1 à J-6, pas encore classés.
//   1. Enregistrement disponible (`replay.status === 'ready'`, importé par
//      replay-closing la nuit) → l'IA lit transcription + résumé + note du
//      closer et choisit UN frein parmi six, avec la phrase du prospect.
//   2. Pas d'enregistrement : on attend jusqu'à J+3 ; ensuite la note du
//      closer seule ; sans note, frein « général ».
//   3. Le frein est écrit sur le RDV (`parcoursRdv.frein`) et sur la fiche
//      (`freinPrincipal`, trace dans la timeline), puis ActiveCampaign (en direct) :
//      tag du frein + `stop_autom`
//      (fin du nurturing généraliste) + retrait de « RDV à venir ».
//
// Même interrupteur et même mode test que le parcours RDV
// (_config/parcours_rdv). Le frein se corrige depuis la fiche : un champ
// `freinPrincipal.corrigePar` posé à la main n'est jamais écrasé.
//
// GET (cron, Bearer CRON_SECRET) | GET ?dry=1 (clé chantier) → simulation
// ============================================================================
'use strict';

const crypto = require('crypto');
const { admin, db } = require('./_firebaseAdmin');
const Dispo = require('../dispo-core.js');
const MT = require('./_meetTranscript');
const P = require('./_parcoursRdv');
const { callClaude } = require('./_ai');

const FV = admin.firestore.FieldValue;

const FREINS = {
  tresorerie: { tag: 'frein_tresorerie', libelle: 'Trésorerie / budget' },
  timing: { tag: 'frein_timing', libelle: 'Pas le bon moment' },
  decision: { tag: 'frein_decision', libelle: 'Doit en parler (associé, conjoint)' },
  preuves: { tag: 'frein_preuves', libelle: 'Besoin de preuves' },
  priorite: { tag: 'frein_priorite', libelle: 'Pas prioritaire / pas convaincu' },
  general: { tag: 'frein_general', libelle: 'Général (rien d\'exploitable)' },
};

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['frein', 'justification', 'citation'],
  properties: {
    frein: { type: 'string', enum: ['tresorerie', 'timing', 'decision', 'preuves', 'priorite', 'general'] },
    justification: { type: 'string', description: 'Une phrase : pourquoi ce frein, d\'après l\'appel.' },
    citation: { type: 'string', description: 'La phrase exacte du prospect qui exprime ce frein, recopiée de la transcription. Vide si aucune.' },
  },
};

const SYSTEME = [
  'Tu lis un appel de vente entre un closer d\'Adrien & Emily (accompagnement de dirigeants de TPE / PME) et un prospect qui n\'a PAS signé à la fin de l\'appel.',
  'Question unique : quel est le frein PRINCIPAL qui l\'a empêché de dire oui ? Choisis UNE valeur :',
  '- tresorerie : budget, trésorerie tendue, « je n\'ai pas les moyens », échéances, prêts en cours ;',
  '- timing : pas le bon moment, saison haute, période chargée, « on en reparle en janvier » ;',
  '- decision : doit en parler à quelqu\'un (associé, conjoint, banquier, comptable) avant de décider ;',
  '- preuves : doute sur les résultats, veut des avis, des cas clients, une mauvaise expérience passée avec un prestataire ;',
  '- priorite : ne voit pas l\'urgence, veut d\'abord essayer seul, pas convaincu que ce soit son problème ;',
  '- general : rien d\'exploitable (appel coupé, transcription vide, aucune raison exprimée).',
  'Si plusieurs freins apparaissent, prends celui que le prospect formule lui-même en dernier ou avec le plus d\'insistance. N\'invente rien : la citation est recopiée telle quelle. Français.',
].join('\n');

function egal(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function texteAppel(entries, speakers) {
  // speakers[] : noms des intervenants, indexés par `p` (_meetTranscript.js).
  const noms = {};
  (speakers || []).forEach(function (s, i) { noms[i] = typeof s === 'string' ? s : ((s && (s.name || s.label)) || ('Intervenant ' + (i + 1))); });
  let out = '';
  for (let i = 0; i < entries.length && out.length < 60000; i++) {
    const e = entries[i] || {};
    const qui = noms[e.p] || ('[' + (e.p == null ? '?' : e.p) + ']');
    out += qui + ' : ' + String(e.t || '').trim() + '\n';
  }
  return out;
}

async function classer(it, opts) {
  const b = it.data;
  const rp = b.replay || {};
  const debut = MT.bookingStartMs(b);
  const age = Date.now() - debut;
  let source = null, contenu = '';
  if (rp.status === 'ready') {
    const entries = await MT.readEntries(it.id, rp.chunks);
    if (entries.length) {
      source = 'transcription';
      contenu = (rp.summary ? 'RÉSUMÉ DE L\'APPEL :\n' + rp.summary + '\n\n' : '') + 'TRANSCRIPTION :\n' + texteAppel(entries, rp.speakers);
    }
  }
  if (!source && age < 3 * 86400000) return { attendre: true };
  if (b.outcomeNote) {
    contenu += '\n\nNOTE DU CLOSER APRÈS L\'APPEL :\n' + String(b.outcomeNote).slice(0, 3000);
    if (!source) source = 'note_closer';
  }
  if (!source) return { frein: 'general', justification: 'Aucun enregistrement ni note du closer trois jours après le RDV.', citation: '', source: 'aucune' };
  if (opts.simulation) return { frein: '(simulation)', source: source };
  const r = await callClaude({ task: 'parcours_frein', system: SYSTEME, schema: SCHEMA, maxTokens: 800, prompt: contenu, noContext: true });
  if (!r.ok || !r.json || !FREINS[r.json.frein]) return { erreur: (r && r.error) || 'ia_reponse_invalide' };
  return { frein: r.json.frein, justification: String(r.json.justification || '').slice(0, 400), citation: String(r.json.citation || '').slice(0, 400), source: source, modele: r.model || null };
}

async function passage(opts) {
  const cfg = await P.lireConfig();
  const simulation = !!opts.simulation || cfg.actif !== true;
  const auj = Dispo.parisStamp(new Date()).ymd;
  const typeMap = await P.lireTypes();
  const T = await P.destinatairesTest(cfg);
  const snap = await db.collection('bookings').where('date', '>=', Dispo.addDays(auj, -6)).where('date', '<=', Dispo.addDays(auj, -1)).get();
  const out = { ok: true, simulation: simulation, examines: 0, detail: [] };
  for (let i = 0; i < snap.docs.length; i++) {
    const d = snap.docs[i];
    const b = Object.assign({ _id: d.id }, d.data() || {});
    if (b.outcome !== 'non_close') continue;
    const t = P.typeDe(b, typeMap);
    if (!t || !((t.notifications || {}).parcoursRdv === true) || !P.estCommercial(b, t)) continue;
    const et = (b.parcoursRdv || {}).etapes || {};
    // Frein déjà choisi mais ActiveCampaign en échec : on ne relit pas
    // l'appel, on rejoue seulement l'envoi (au plus 6 essais).
    const blocDeja = (b.parcoursRdv || {}).frein;
    if (et.frein && et.frein.ok === false && blocDeja && blocDeja.tag && !simulation && (cfg.modeTest === false || P.estRdvDeTest(b, T))) {
      if ((await P.reserver(d.ref, 'frein', { rejouable: true })) === 'ok') {
        const rr = await P.versActiveCampaign(cfg, 'frein', b, { frein: blocDeja.frein, tag: blocDeja.tag });
        await P.noter(d.ref, 'frein', Object.assign({ canal: 'ac' }, rr));
        out.detail.push({ id: d.id, date: b.date, frein: blocDeja.frein, resultat: rr.ok ? 'rejoue' : 'echec', erreur: rr.ok ? undefined : rr.erreur });
      }
      continue;
    }
    if (et.frein) continue;
    // Un autre RDV est déjà posé : pas de séquence « après un non », et
    // l'étiquette « RDV à venir » reste (elle appartient au nouveau RDV).
    if (await P.autreRdvAVenir(b, d.id, Date.now(), typeMap)) { out.detail.push({ id: d.id, date: b.date, resultat: 'autre_rdv_a_venir' }); continue; }
    // Seuls les RDV entrés dans le parcours (tag « RDV à venir » posé).
    if (!(et.ac_rdv_pris && et.ac_rdv_pris.ok) && !simulation) continue;
    out.examines++;
    const ligne = { id: d.id, date: b.date };
    const estTest = cfg.modeTest === false || P.estRdvDeTest(b, T);
    const c = await classer({ id: d.id, data: b }, { simulation: simulation || !estTest });
    if (c.attendre) { ligne.resultat = 'attend_enregistrement'; out.detail.push(ligne); continue; }
    if (c.erreur) { ligne.resultat = 'erreur'; ligne.erreur = c.erreur; out.detail.push(ligne); continue; }
    ligne.frein = c.frein; ligne.source = c.source;
    if (simulation || !estTest) { ligne.resultat = 'simule'; out.detail.push(ligne); continue; }

    const ref = d.ref;
    if ((await P.reserver(ref, 'frein')) !== 'ok') { ligne.resultat = 'deja'; out.detail.push(ligne); continue; }
    const F = FREINS[c.frein];
    const bloc = { frein: c.frein, libelle: F.libelle, tag: F.tag, justification: c.justification, citation: c.citation, source: c.source, at: Date.now(), bookingId: d.id };
    await ref.set({ parcoursRdv: { frein: bloc } }, { merge: true });
    if (b.leadId) {
      const lref = db.collection('leads').doc(String(b.leadId));
      const ls = await lref.get();
      const deja = ls.exists ? (ls.data() || {}).freinPrincipal : null;
      if (!(deja && deja.corrigePar)) {
        await lref.update({
          freinPrincipal: bloc,
          timeline_history: FV.arrayUnion({ text: '🧭 Frein principal détecté après le RDV : ' + F.libelle + (c.citation ? ' — « ' + c.citation + ' »' : '') + ' → séquence de suivi adaptée', date: new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }), color: '#f59e0b' }),
        }).catch(function (e) { console.warn('[parcours-frein] lead', e && e.message); });
      }
    }
    const r = await P.versActiveCampaign(cfg, 'frein', b, { frein: c.frein, tag: F.tag });
    await P.noter(ref, 'frein', Object.assign({ canal: 'ac' }, r));
    ligne.resultat = r.ok ? 'envoye' : 'echec';
    if (!r.ok) ligne.erreur = r.erreur;
    out.detail.push(ligne);
  }
  return out;
}

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const s = process.env.CRON_SECRET || '';
    const a = String((req.headers && req.headers.authorization) || '');
    const estCron = !!s && a.indexOf('Bearer ') === 0 && egal(a.slice(7).trim(), s);
    const want = String(process.env.PARCOURS_AUDIT_KEY || '');
    const cle = want.length >= 24 && egal((req.headers && req.headers['x-audit-key']) || (req.query && req.query.k) || '', want);
    if (!estCron && !cle) { res.status(401).json({ ok: false, error: 'Non autorisé' }); return; }
    const out = await passage({ simulation: !estCron || (req.query && req.query.dry === '1') });
    res.status(200).json(out);
  } catch (e) {
    console.error('[parcours-frein]', e && e.stack ? e.stack : e);
    res.status(500).json({ ok: false, error: 'server_error', detail: e && e.message });
  }
};
module.exports.FREINS = FREINS;
