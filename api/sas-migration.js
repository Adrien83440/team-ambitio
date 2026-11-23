// ============================================================================
// api/sas-migration.js — PASSAGE DE LA SARL EN SAS, DONNÉES DE PRODUCTION
// (23/11/2026, demande d'Adrien : « il faut que tout passe en SAS »)
// ----------------------------------------------------------------------------
// Le code du dépôt ne suffit pas : les factures lisent l'émetteur dans
// `_config/billing` et leurs conditions dans `_config/billing/cgv`, les contrats
// en service sont dans `signature_templates`. Cette route fait, en base, ce que
// le commit fait dans les fichiers.
//
//   GET  (clé seule)         → À BLANC : ce qui serait modifié, rien d'écrit
//   GET  ?apply=1            → applique, puis trace dans sas_migration_log/*
//
// Ce qui change :
//   1. `_config/billing`       : forme juridique « SAS » + toute mention SARL de
//                                la société dans les textes (modèles d'e-mail…)
//   2. `_config/billing/cgv`   : NOUVELLE version active ; l'ancienne est
//                                archivée (isActive:false), jamais écrasée
//   3. `booking_config/_settings.orgName`
//   4. `signature_templates`   : modèles GÉNÉRÉS (texte), hors contrats ponctuels
//                                → nouvelle version (sous-collection versions),
//                                comme un enregistrement de l'Atelier contrats
//                                Modèles PDF importés (demande d'Adrien : « tu
//                                les régénères et tu les ajoutes à la place ») :
//                                leur copie texte est convertie en contrat
//                                généré (legacyToGenerated, comme l'Atelier) et
//                                passe en SAS ; le PDF d'origine reste stocké.
//
// Ce qui ne change JAMAIS : factures émises (instantané figé), contrats signés
// ou déjà envoyés (webSnapshot de la demande), modèles PDF sans copie texte
// (listés : à reprendre dans l'Atelier), la valeur technique
// `billingScope: 'sarl'` des fiches clients.
//
// Rien n'est supprimé : les valeurs d'avant sont gardées dans la trace.
// Aucune donnée personnelle en sortie (réglages et modèles seulement ; un
// contrat ponctuel n'est jamais nommé). Clé : en-tête `x-sas-key` égal à la
// variable Vercel SAS_MIGRATION_KEY (jamais dans le dépôt) ; absente → 404.
// Route temporaire : à retirer une fois la bascule faite.
// ============================================================================
'use strict';

const crypto = require('crypto');
const { db, admin } = require('./_firebaseAdmin');
const render = require('./_contract-render');

function keyOk(req) {
  const want = String(process.env.SAS_MIGRATION_KEY || '');
  const got = String((req.headers && req.headers['x-sas-key']) || '');
  if (want.length < 24 || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

/* ── La règle de réécriture (pure, testée contre les fichiers du dépôt) ──────
   Toutes les règles sont ancrées sur « Ambitio Corp » ou sur les deux
   représentants : un « SARL » qui décrit un CLIENT n'est jamais touché. */
const RULES = [
  [/soci[ée]t[ée] [àa] responsabilit[ée] limit[ée]e \(SARL\)/gi, 'société par actions simplifiée (SAS)'],
  [/(Ambitio\s?Corp\*{0,2}\s*(?:,|—|–|-|\()\s*)soci[ée]t[ée] [àa] responsabilit[ée] limit[ée]e/gi, '$1société par actions simplifiée'],
  [/(repr[ée]sent[ée]e par (?:\*\*)?Emily\s+Ughetto)\s+et\s+(Adrien\s+Fran[cç]ois)(?!,\s*Directeur)/gi, '$1, Présidente, et $2, Directeur général'],
  [/repr[ée]sent[ée]e par Monsieur Adrien FRAN[ÇC]OIS et Madame Emily UGHETTO, agissant en qualit[ée] de co-?g[ée]rants d[ûu]ment habilit[ée]s/gi,
    'représentée par Madame Emily UGHETTO, Présidente, et Monsieur Adrien FRANÇOIS, Directeur général, dûment habilités'],
  [/(Directeur g[ée]n[ée]ral),? en leur qualit[ée] de co-?g[ée]rants/gi, '$1'],
  [/\bSARL(\s+)(Ambitio\s?Corp)/gi, 'SAS$1$2'],
  [/cog[ée]r[ée]e par Adrien François et Emily/gi, 'présidée par Emily Ughetto, Adrien François étant Directeur général'],
  [/(Ambitio\s?Corp\*{0,2}\s*(?:,|—|–|-|\()\s*)SARL\b/gi, '$1SAS'],
];
function rename(s) {
  let out = String(s);
  RULES.forEach(function (r) { out = out.replace(r[0], r[1]); });
  return out;
}
const SECRET_KEY = /token|secret|password|passwd|apikey|api_key|private|credential|base64|signature/i;
/* Parcourt une valeur ; renvoie la valeur réécrite et la liste des changements. */
function walk(v, path, changes, residus) {
  if (typeof v === 'string') {
    if (v.length > 200000) return v;
    const n = rename(v);
    if (n !== v) changes.push({ path: path, avant: around(v, n, false), apres: around(v, n, true) });
    if (/\bSARL\b|co-?g[ée]r/i.test(n) && residus) residus.push({ path: path, extrait: snippet(n, n.search(/\bSARL\b|co-?g[ée]r/i)) });
    return n;
  }
  if (Array.isArray(v)) return v.map(function (x, i) { return walk(x, path + '[' + i + ']', changes, residus); });
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const o = {};
    Object.keys(v).forEach(function (k) {
      o[k] = SECRET_KEY.test(k) ? v[k] : walk(v[k], path ? path + '.' + k : k, changes, residus);
    });
    return o;
  }
  return v;   /* Timestamp, nombre, booléen, null : inchangé */
}
function snippet(s, i) { return s.slice(Math.max(0, i - 70), i + 90).replace(/\s+/g, ' '); }
/* Extrait autour de la première différence. */
function around(a, b, after) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return snippet(after ? b : a, i);
}
function nextVersion(cur, taken) {
  const m = /^(\d+)\.(\d+)$/.exec(String(cur || ''));
  let maj = m ? Number(m[1]) : 1, min = m ? Number(m[2]) : 0, v;
  do { min++; v = maj + '.' + min; } while (taken['v' + v.replace(/\./g, '_')]);
  return v;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!keyOk(req)) { res.status(404).end('Not found'); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'GET seulement' }); return; }
  const apply = String((req.query && req.query.apply) || '') === '1';
  const voir = String((req.query && req.query.voir) || '') === '1';
  const VOIR = /g[ée]rant|g[ée]rance|SARL|responsabilit[ée] limit|Ambitio|Ughetto|Pr[ée]sident|Directeur g[ée]n/i;
  const nowIso = new Date().toISOString();
  const TS = admin.firestore.FieldValue.serverTimestamp();
  const report = { mode: apply ? 'APPLIQUÉ' : 'À BLANC — rien écrit', at: nowIso };
  const trace = { at: nowIso, by: 'sas-migration' };

  try {
    /* ── 1. Émetteur des factures ─────────────────────────────────────────── */
    const billRef = db.collection('_config').doc('billing');
    const billSnap = await billRef.get();
    const bill = billSnap.exists ? (billSnap.data() || {}) : null;
    const r1 = { existe: !!bill, changements: [], residus: [] };
    const upd1 = {};
    if (bill) {
      r1.formeAvant = bill.companyLegalForm || '';
      r1.capital = bill.companyShareCapital || '';
      if (bill.companyLegalForm !== 'SAS') {
        upd1.companyLegalForm = 'SAS';
        r1.changements.push({ path: 'companyLegalForm', avant: bill.companyLegalForm || '', apres: 'SAS' });
      }
      Object.keys(bill).forEach(function (k) {
        if (k === 'companyLegalForm' || SECRET_KEY.test(k)) return;
        const ch = [];
        const n = walk(bill[k], k, ch, r1.residus);
        if (ch.length) { upd1[k] = n; r1.changements = r1.changements.concat(ch); }
      });
      if (apply && Object.keys(upd1).length) {
        const before = {};
        Object.keys(upd1).forEach(function (k) { before[k] = bill[k] === undefined ? null : bill[k]; });
        trace.billingAvant = before;
        await billRef.update(Object.assign({}, upd1, { sasMigrationAt: nowIso }));
      }
    }
    report.emetteur = r1;

    /* ── 2. Conditions générales de facturation ───────────────────────────── */
    const cgvCol = billRef.collection('cgv');
    const cgvSnap = await cgvCol.get();
    const taken = {}; const actives = [];
    cgvSnap.forEach(function (d) { taken[d.id] = true; if ((d.data() || {}).isActive) actives.push({ id: d.id, data: d.data() }); });
    const r2 = { versions: cgvSnap.size, actives: actives.map(function (a) { return a.data.version || a.id; }) };
    if (actives.length === 1) {
      const A = actives[0];
      const ch = [], rs = [];
      const text = walk(String(A.data.text || ''), 'text', ch, rs);
      r2.residus = rs;
      if (ch.length) {
        const v = nextVersion(A.data.version, taken);
        r2.nouvelleVersion = v; r2.remplace = A.data.version || A.id;
        r2.avant = ch[0].avant; r2.apres = ch[0].apres;
        if (apply) {
          const batch = db.batch();
          batch.update(cgvCol.doc(A.id), { isActive: false, archivedAt: nowIso, archivedReason: 'Passage en SAS' });
          batch.set(cgvCol.doc('v' + v.replace(/\./g, '_')), {
            version: v, text: text, isActive: true, activeFrom: TS, createdAt: TS, updatedAt: TS,
            createdBy: 'sas-migration', updatedBy: 'sas-migration', note: 'Passage de la SARL en SAS (copie de la version ' + (A.data.version || A.id) + ')',
          });
          await batch.commit();
          trace.cgv = { de: A.id, vers: 'v' + v.replace(/\./g, '_') };
        }
      } else { r2.rien = 'la version active ne mentionne pas la SARL'; }
    } else { r2.rien = actives.length ? 'plusieurs versions actives : non touché' : 'aucune version active'; }
    report.cgv = r2;

    /* ── 3. Réglages de la réservation ────────────────────────────────────── */
    const bkRef = db.collection('booking_config').doc('_settings');
    const bkSnap = await bkRef.get();
    const r3 = { existe: bkSnap.exists };
    if (bkSnap.exists) {
      const on = String((bkSnap.data() || {}).orgName || '');
      const nn = rename(on);
      r3.avant = on; r3.apres = nn;
      if (nn !== on && apply) { trace.bookingOrgNameAvant = on; await bkRef.update({ orgName: nn }); }
    }
    report.booking = r3;

    /* ── 4. Modèles de contrat ────────────────────────────────────────────── */
    const tSnap = await db.collection('signature_templates').get();
    const r4 = { total: tSnap.size, modifies: [], pdfConvertis: [], pdfSansTexte: [], pdfSansMentionSarl: [], ponctuelsAvecSarl: 0, dejaAJour: 0 };
    const todo = [];
    tSnap.forEach(function (d) {
      const T = d.data() || {};
      const hasWeb = !!(T.web && Array.isArray(T.web.sections));
      const gen = !!(hasWeb && T.web.generated);
      const ch = [], rs = [];
      const web = hasWeb ? walk(T.web, 'web', ch, rs) : null;
      const nameCh = [];
      walk(String(T.name || ''), 'name', nameCh, null);
      if (T.isAdhoc) { r4.ponctuels = (r4.ponctuels || 0) + 1; if (ch.length) r4.ponctuelsAvecSarl++; return; }
      if (voir && hasWeb) {
        /* Lecture seule : les blocs qui parlent de la société ou de ses dirigeants. */
        const vus = [];
        (T.web.sections || []).forEach(function (sec, i) { (sec.blocks || []).forEach(function (b, j) {
          if (VOIR.test(String(b))) vus.push({ ou: i + '.' + j, avant: String(b).slice(0, 700), apres: rename(String(b)).slice(0, 700) });
        }); });
        report.blocs = report.blocs || {};
        report.blocs[d.id] = vus;
      }
      if (!gen) {
        const nom = String(T.name || '').slice(0, 80);
        if (!hasWeb) { r4.pdfSansTexte.push({ id: d.id, nom: nom }); return; }
        if (!ch.length) { r4.pdfSansMentionSarl.push({ id: d.id, nom: nom }); return; }
        /* Modèle PDF importé : sa copie texte devient le contrat (généré). */
        const ch2 = [], rs2 = [];
        const conv = walk(render.legacyToGenerated(T.web, T.fields || []), 'web', ch2, rs2);
        r4.pdfConvertis.push({
          id: d.id, nom: nom, articles: conv.sections.length, variables: (conv.variables || []).length, cases: (conv.clientChecks || []).length,
          changements: ch2.map(function (c) { return { path: c.path, avant: c.avant, apres: c.apres }; }), residus: rs2,
        });
        todo.push({ id: d.id });
        return;
      }
      if (!ch.length) { r4.dejaAJour++; return; }
      r4.modifies.push({
        id: d.id, nom: String(T.name || '').slice(0, 80), version: (T.web.version || 0) + ' → ' + ((T.web.version || 0) + 1),
        changements: ch.map(function (c) { return { path: c.path, avant: c.avant, apres: c.apres }; }), residus: rs,
      });
      todo.push({ id: d.id, web: web });
    });
    if (apply) {
      trace.templates = [];
      for (let i = 0; i < todo.length; i++) {
        const ref = db.collection('signature_templates').doc(todo[i].id);
        const done = await db.runTransaction(async function (tx) {
          const s = await tx.get(ref);
          const T = s.data() || {};
          if (!(T.web && Array.isArray(T.web.sections)) || T.isAdhoc) return null;
          const converti = !T.web.generated;
          const ch = [];
          /* relu dans la transaction */
          const web0 = walk(converti ? render.legacyToGenerated(T.web, T.fields || []) : T.web, 'web', ch, null);
          if (!ch.length) return null;
          const version = (T.web.version || 0) + 1;
          const web = Object.assign({}, web0, { version: version, savedAt: nowIso, savedBy: 'sas-migration' });
          const prev = ref.collection('versions').doc(String(T.web.version || 0).padStart(4, '0'));
          const p = await tx.get(prev);
          /* L'ancienne version doit rester consultable, même si elle n'avait
             jamais été enregistrée par l'Atelier. */
          if (!p.exists) tx.set(prev, { version: T.web.version || 0, name: T.name || '', web: T.web, note: 'Version d\'avant le passage en SAS (sauvegarde automatique)', by: 'sas-migration', at: TS, atIso: nowIso });
          tx.set(ref, Object.assign({ web: web, updatedAt: TS }, converti ? { generated: true, pdfRemplaceLe: nowIso } : {}), { merge: true });
          tx.set(ref.collection('versions').doc(String(version).padStart(4, '0')), {
            version: version, name: T.name || '', web: web, note: (converti ? 'Contrat PDF régénéré en contrat généré. ' : '') + 'Passage de la SARL en SAS (Emily Ughetto Présidente, Adrien François Directeur général)',
            by: 'sas-migration', at: TS, atIso: nowIso,
          });
          return { id: ref.id, de: T.web.version || 0, vers: version, pdfConverti: converti };
        });
        if (done) trace.templates.push(done);
      }
      r4.ecrits = trace.templates.length;
    }
    report.contrats = r4;

    /* ── 5. Autres réglages qui citent la SARL (champs texte de premier niveau
       corrigés ; ce qui est plus profond est seulement signalé) ─────────── */
    const cfg = await db.collection('_config').get();
    const autres = [];
    const aEcrire = [];
    cfg.forEach(function (d) {
      if (d.id === 'billing') return;
      const rs = [];
      const ch = [];
      const data = d.data() || {};
      const next = walk(data, '', ch, rs);
      if (rs.length || ch.length) autres.push({ doc: '_config/' + d.id, corriges: ch.map(function (c) { return { path: c.path, avant: c.avant, apres: c.apres }; }), mentionsSarlRestantes: rs });
      if (ch.length) {
        const upd = {}, before = {};
        Object.keys(data).forEach(function (k) { if (JSON.stringify(next[k]) !== JSON.stringify(data[k]) && typeof data[k] === 'string') { upd[k] = next[k]; before[k] = data[k]; } });
        if (Object.keys(upd).length) aEcrire.push({ ref: d.ref, id: d.id, upd: upd, before: before });
      }
    });
    report.autresReglages = autres;
    if (apply) {
      trace.autresReglagesAvant = {};
      for (let i = 0; i < aEcrire.length; i++) {
        trace.autresReglagesAvant[aEcrire[i].id] = aEcrire[i].before;
        await aEcrire[i].ref.update(aEcrire[i].upd);
      }
    }

    if (apply) await db.collection('sas_migration_log').doc(nowIso.replace(/[:.]/g, '-')).set(trace);
    res.status(200).json(report);
  } catch (e) {
    console.error('[sas-migration]', e);
    res.status(500).json({ error: String((e && e.message) || e), partiel: report });
  }
};

module.exports.rename = rename;
