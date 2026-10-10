// ============================================================================
// scripts/transfer-elodie-anthony.js — fin de mission d'Élodie (10/10/2026)
// ----------------------------------------------------------------------------
// Tout ce qu'Élodie porte passe à Anthony, sans qu'aucun lien ne change pour
// les prospects (décisions Adrien 10/10/2026 : 1 Anthony existe · 2a · 3a ·
// 4a · 5 · 6) :
//
//   A. Expert booking : la fiche booking_config d'Élodie (son personId) est
//      REPRISE par Anthony — nom, titre, firebaseUid. Les liens publics
//      (?type=…), les liens &person=, les reports et les RDV déjà pris
//      pointent sur ce personId : rien ne bouge côté prospect. L'agenda
//      principal (strategie@, sous-agenda dédié) et ses Meet restent en
//      place ; l'agenda Gmail perso d'Élodie, branché en secondaire, est
//      débranché (archivé dans extraConnectionsArchived). L'ancienne fiche
//      vide d'Anthony est détachée de son uid (jamais supprimée).
//   B. RDV à venir de cet expert : personName → Anthony (rappels « Avec : »).
//      Aucun nouveau RDV, aucune annulation, aucun email.
//   C. RDV passés de cet expert sans closeur enregistré : expertSlug='elodie'
//      pour que Close SB les laisse dans l'historique d'Élodie.
//   D. Leads assignedTo='elodie' → 'anthony', SAUF les clients gagnés
//      (closed_won_*) qui gardent Élodie comme closeuse historique.
//      archivedFromSlug='elodie' posé (même trace que l'outil Archiver).
//      setterSlug n'est jamais touché (verrou, et historique Set NB).
//   E. Liens setter de l'agenda (_types.list[].attributedSetterSlug) → anthony.
//   F. Routing des leads (_config/lead_routing) : elodie → anthony.
//   G. Paiements en cours (brouillon / mandat en attente / mandat actif)
//      créés par Élodie → createdBy Anthony, pour qu'il les voie et les
//      déclenche. Paiements actifs / terminés : inchangés (historique).
//   H. Relances IA actives (ai_followups) → Anthony.
//   I. Numéros (phone_numbers) assignés à Élodie → Anthony.
//   J. Équipe (_meta/team_members) : Élodie inactive + departed, ses
//      drapeaux de modules passent à Anthony.
//   K. users : Élodie archivée (même champs que l'outil Archiver), ses
//      numéros pro et ses droits (signatures, prélèvements) passent à Anthony.
//   L. Firebase Auth : compte d'Élodie DÉSACTIVÉ + sessions révoquées.
//   M. audit_log : une entrée récapitulative.
//
// Historique jamais réécrit : commissions/elodie, saisies/elodie,
// lead_actions/elodie, eod, closeData, setterSlug, subscriptions, persons.
//
// Lecture seule par défaut (dry-run). Écriture uniquement avec --apply,
// après validation du dry-run par Adrien (CLAUDE.md, règle 3).
//
//   GOOGLE_APPLICATION_CREDENTIALS=~/.secrets/ambitio-team-sa.json \
//     node scripts/transfer-elodie-anthony.js            # dry-run
//   ... node scripts/transfer-elodie-anthony.js --apply  # écriture
// ============================================================================
'use strict';
const R = require('./_firestore-rest.js');

const APPLY = process.argv.indexOf('--apply') >= 0;
const PROJECT = 'ambitio-team';
const BASE = 'https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents';
const FROM_SLUG = 'elodie';
const FROM_UID = 'IrL8bfOrUfMH2fEPFzuojPT8bQh1';
const WON_STAGES = { closed_won_setting: 1, closed_won_self: 1 };
const OPEN_PAYMENT = { draft: 1, pending_mandate: 1, mandate_active: 1 };
const MODULE_FLAGS = ['inLeadsModule', 'eligibleForLeads', 'selfBookingOwner', 'canPassCalls', 'signaturesAccess', 'dialerEnabled'];
const now = new Date();
const todayIso = new Date(now.getTime() + 2 * 3600 * 1000).toISOString().slice(0, 10); // Europe/Paris (CEST)

let nWrites = 0;
const warnings = [];
function warn(s) { warnings.push(s); console.log('  ⚠ ' + s); }

async function patch(path, fields, label) {
  const keys = Object.keys(fields);
  console.log('    ' + (APPLY ? '✏️  ' : '→ ') + path + (label ? '  (' + label + ')' : '') + ' ' + JSON.stringify(fields));
  nWrites++;
  if (APPLY) await R.patchDoc(path, fields, keys);
}

// ── Accès brut (types Firestore préservés) ─────────────────────────────────
// _firestore-rest décode les timestamps en chaînes : réécrire un tableau ou une
// map décodée changerait leur type. Les documents à structure imbriquée
// (team_members, _types, lead_routing) sont donc lus et réécrits en brut.
async function getRaw(path) {
  const t = await R.token();
  try { return await R.request('GET', BASE + '/' + path, { Authorization: 'Bearer ' + t }); }
  catch (e) { if (/HTTP 404/.test(String(e.message))) return null; throw e; }
}
async function patchRaw(path, rawFields, fieldPaths, label) {
  console.log('    ' + (APPLY ? '✏️  ' : '→ ') + path + ' [' + fieldPaths.join(', ') + ']' + (label ? '  (' + label + ')' : ''));
  nWrites++;
  if (!APPLY) return;
  const t = await R.token();
  const mask = fieldPaths.map(function (p) { return 'updateMask.fieldPaths=' + encodeURIComponent(p); }).join('&');
  await R.request('PATCH', BASE + '/' + path + '?' + mask + '&currentDocument.exists=true',
    { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, { fields: rawFields });
}
function rawStr(v) { return v && 'stringValue' in v ? v.stringValue : null; }
function rawBool(v) { return !!(v && v.booleanValue === true); }

async function q(collectionId, filters) {
  const where = !filters || !filters.length ? undefined
    : (filters.length === 1 ? filters[0] : { compositeFilter: { op: 'AND', filters: filters } });
  const sq = { from: [{ collectionId: collectionId }] };
  if (where) sq.where = where;
  return R.runQuery(sq);
}

(async function main() {
  console.log(APPLY ? '=== APPLY — écriture ===' : '=== DRY-RUN — aucune écriture ===');
  console.log('Date de référence (Paris) : ' + todayIso);

  // ── Roster ────────────────────────────────────────────────────────────────
  const tmRaw = await getRaw('_meta/team_members');
  if (!tmRaw || !tmRaw.fields || !tmRaw.fields.members) throw new Error('_meta/team_members.members introuvable');
  // members : tableau OU map selon l'historique du document — clés communes
  // (index du tableau ou clé de la map) pour le décodé et le brut.
  const tmMembers = tmRaw.fields.members;
  const tmMap = {};
  if (tmMembers.arrayValue) (tmMembers.arrayValue.values || []).forEach(function (v, i) { tmMap[String(i)] = v; });
  else if (tmMembers.mapValue) Object.assign(tmMap, tmMembers.mapValue.fields || {});
  else throw new Error('_meta/team_members.members : format inconnu');
  const tm = await R.getDoc('_meta/team_members');
  const members = Object.assign({}, tm.data.members);

  const fromKey = Object.keys(members).find(function (k) { return members[k] && members[k].slug === FROM_SLUG; });
  if (!fromKey) throw new Error('membre « ' + FROM_SLUG + ' » absent du roster');
  const from = members[fromKey];
  if (from.firebaseUid && from.firebaseUid !== FROM_UID) throw new Error('firebaseUid inattendu pour elodie : ' + from.firebaseUid);

  const cands = Object.keys(members).filter(function (k) {
    const m = members[k] || {};
    const hay = [m.slug, m.fullName, m.displayName, m.shortName].join(' ').toLowerCase();
    return /anth?ony/.test(hay);
  });
  if (cands.length !== 1) throw new Error(cands.length + ' membre(s) « Anthony » dans le roster (' + cands.join(', ') + ') : il en faut exactement un.');
  const toKey = cands[0];
  const to = members[toKey];
  const TO_SLUG = to.slug;
  const TO_UID = to.firebaseUid;
  const TO_NAME = to.fullName || to.displayName || to.shortName || TO_SLUG;
  console.log('\nSource : ' + (from.fullName || FROM_SLUG) + ' — slug ' + FROM_SLUG + ', uid ' + FROM_UID + ', rôle ' + from.role);
  console.log('Cible  : ' + TO_NAME + ' — slug ' + TO_SLUG + ', uid ' + (TO_UID || '∅') + ', rôle ' + to.role + ', actif ' + (to.active !== false) + ', email ' + (to.email || '∅'));
  if (!TO_UID) throw new Error('Anthony n\'a pas de firebaseUid dans le roster : compte Auth non relié, arrêt.');
  if (to.role !== 'closer' && to.role !== 'closer_setter') warn('rôle d\'Anthony = « ' + to.role + ' » : il ne sera pas reconnu comme closer (Close SB, commissions closing). Attendu : closer ou closer_setter.');
  if (!to.contract) warn('Anthony n\'a pas de contrat dans le roster : ses commissions suivront le barème historique (contrat Full Cycle d\'Élodie). À saisir dans Admin → Utilisateurs si différent.');
  if (to.active === false || to.archivedAt) warn('Anthony est marqué inactif / archivé dans le roster : il sera réactivé (J).');
  const toUser = await R.getDoc('users/' + TO_UID);
  const fromUser = await R.getDoc('users/' + FROM_UID);
  if (!toUser) throw new Error('users/' + TO_UID + ' introuvable');

  // ── A. Expert booking ─────────────────────────────────────────────────────
  console.log('\n── A. Fiche expert booking (booking_config) reprise par Anthony');
  const experts = await q('booking_config', [R.ff('firebaseUid', 'EQUAL', FROM_UID)]);
  const toExperts = (await q('booking_config', [R.ff('firebaseUid', 'EQUAL', TO_UID)])).filter(function (e) { return e.id !== FROM_SLUG; });
  if (experts.length !== 1) throw new Error(experts.length + ' fiche(s) expert reliée(s) à Élodie : il en faut exactement une.');
  const PID = experts[0].id;
  const ex = experts[0].data;
  console.log('  personId ' + PID + ' — « ' + ex.name + ' », types : ' + JSON.stringify(ex.types || []));
  const tok = await R.getDoc('calendar_tokens/' + PID);
  const evCal = (ex.calendarList || []).find(function (c) { return c && c.createEvents === true; });
  const tokEmail = tok ? (tok.data.email || tok.data.googleEmail || ex.calendarEmail || '') : '';
  console.log('  · agenda Google principal : ' + (tok ? (tokEmail || '(email non stocké)') : 'AUCUN') +
    ' · calendrier des événements : ' + (evCal ? (evCal.name || evCal.id) : 'primary') + '  (inchangé)');
  if (tokEmail && /elodie/i.test(tokEmail)) warn('l\'agenda principal de la fiche est le compte Google d\'Élodie (' + tokEmail + ') : Anthony doit reconnecter le sien dans Booking → Experts.');
  // Ce que le prospect voit sur la page de réservation : nom + titre.
  const exFields = { name: TO_NAME, firebaseUid: TO_UID, transferredFromSlug: FROM_SLUG, transferredAt: now };
  if (ex.role && /experte/i.test(ex.role)) exFields.role = ex.role.replace(/Experte/g, 'Expert').replace(/experte/g, 'expert');
  // Email de notification : seulement s'il est personnel à Élodie (une boîte
  // partagée comme strategie@ reste en place).
  ['personalEmail', 'email'].forEach(function (k) {
    if (!ex[k] || !/elodie/i.test(ex[k])) return;
    if (to.email) exFields[k] = to.email;
    else warn(k + ' de la fiche expert (' + ex[k] + ') non remplacé : Anthony n\'a pas d\'email dans le roster.');
  });
  ['personalEmail', 'phone', 'bio'].forEach(function (k) {
    if (ex[k] && !(k in exFields)) console.log('  · ' + k + ' = ' + JSON.stringify(ex[k]).slice(0, 100) + '  (inchangé, non visible des prospects)');
  });
  await patch('booking_config/' + PID, exFields);

  // Agendas secondaires personnels d'Élodie (son Gmail bloquerait les créneaux
  // d'Anthony) : retirés de extraConnections, conservés dans
  // extraConnectionsArchived. Les jetons calendar_extra_tokens restent en base.
  const exRaw = await getRaw('booking_config/' + PID);
  const ecArr = exRaw.fields.extraConnections && exRaw.fields.extraConnections.arrayValue;
  const ecVals = (ecArr && ecArr.values) || [];
  const keep = [], drop = [];
  ecVals.forEach(function (v) {
    const em = rawStr(v.mapValue && v.mapValue.fields && v.mapValue.fields.email) || '';
    (/elodie/i.test(em) ? drop : keep).push(v);
    if (/elodie/i.test(em)) console.log('  · agenda secondaire débranché : ' + em);
  });
  if (drop.length) {
    const prev = (exRaw.fields.extraConnectionsArchived && exRaw.fields.extraConnectionsArchived.arrayValue && exRaw.fields.extraConnectionsArchived.arrayValue.values) || [];
    await patchRaw('booking_config/' + PID, {
      extraConnections: { arrayValue: { values: keep } },
      extraConnectionsArchived: { arrayValue: { values: prev.concat(drop) } }
    }, ['extraConnections', 'extraConnectionsArchived']);
  }

  // Ancienne fiche expert d'Anthony : détachée de son compte (sinon deux fiches
  // pour le même uid), jamais supprimée. Refus si elle porte des RDV ou des types.
  for (const te of toExperts) {
    const nbk = (await q('bookings', [R.ff('personId', 'EQUAL', te.id)])).length;
    const nty = (te.data.types || []).length;
    console.log('  · ancienne fiche d\'Anthony ' + te.id + ' : ' + nty + ' type(s), ' + nbk + ' RDV');
    if (nbk || nty) { warn('fiche ' + te.id + ' non détachée (elle porte des RDV ou des types) : à arbitrer à la main.'); continue; }
    console.log('    ' + (APPLY ? '✏️  ' : '→ ') + 'booking_config/' + te.id + ' firebaseUid retiré, supersededBy=' + PID);
    nWrites++;
    if (APPLY) await R.patchDoc('booking_config/' + te.id, { supersededBy: PID, unlinkedUid: TO_UID }, ['firebaseUid', 'supersededBy', 'unlinkedUid']);
  }

  // ── B / C. RDV ────────────────────────────────────────────────────────────
  console.log('\n── B. RDV à venir de cet expert → personName « ' + TO_NAME + ' »');
  const bks = await q('bookings', [R.ff('personId', 'EQUAL', PID)]);
  let nB = 0, nC = 0;
  const future = [], past = [];
  bks.forEach(function (b) { (String(b.data.date || '') >= todayIso ? future : past).push(b); });
  future.sort(function (a, b) { return String(a.data.date + a.data.time).localeCompare(String(b.data.date + b.data.time)); });
  let lastRdv = null;
  for (const b of future) {
    const d = b.data;
    const st = d.status || '';
    if (st !== 'confirmed' && st !== 'pending') continue;
    const p = d.prospect || {};
    console.log('  ' + d.date + ' ' + (d.time || '') + ' · ' + ((p.prenom || '') + ' ' + (p.nom || '')).trim() + ' · ' + (d.typeLabel || d.type || '') + ' · ' + st + (d.calendarEventId ? ' · événement Google ✔' : ' · pas d\'événement Google'));
    lastRdv = d.date + ' ' + (d.time || '');
    await patch('bookings/' + b.id, { personName: TO_NAME });
    nB++;
  }
  console.log('  → ' + nB + ' RDV à venir' + (lastRdv ? ' · dernier RDV pris avec Élodie : ' + lastRdv : ''));

  console.log('\n── C. RDV passés sans closeur → expertSlug « elodie » (historique Close SB)');
  for (const b of past) {
    const d = b.data;
    if (d.expertSlug || (d.closeData && d.closeData.closerSlug)) continue;
    nC++;
    if (APPLY) await R.patchDoc('bookings/' + b.id, { expertSlug: FROM_SLUG }, ['expertSlug']);
    nWrites++;
  }
  console.log('  ' + (APPLY ? '✏️  ' : '→ ') + nC + ' RDV passés marqués (sur ' + past.length + ' RDV passés de cet expert)');

  // ── D. Leads ──────────────────────────────────────────────────────────────
  console.log('\n── D. Leads assignedTo=elodie → ' + TO_SLUG + ' (clients gagnés exclus)');
  const leads = await q('leads', [R.ff('assignedTo', 'EQUAL', FROM_SLUG)]);
  const byStage = {};
  let nD = 0, nKeep = 0;
  for (const l of leads) {
    const d = l.data;
    const stage = d.stage || '(vide)';
    if (d._merged === true) continue;
    if (WON_STAGES[stage]) { nKeep++; continue; }
    byStage[stage] = (byStage[stage] || 0) + 1;
    nD++;
    if (APPLY) await R.patchDoc('leads/' + l.id, { assignedTo: TO_SLUG, archivedFromSlug: FROM_SLUG, updatedAt: now }, ['assignedTo', 'archivedFromSlug', 'updatedAt']);
    nWrites++;
  }
  Object.keys(byStage).sort().forEach(function (s) { console.log('  · ' + s + ' : ' + byStage[s]); });
  console.log('  ' + (APPLY ? '✏️  ' : '→ ') + nD + ' leads transférés · ' + nKeep + ' clients gagnés laissés à Élodie');

  // ── E. Liens setter de l'agenda ───────────────────────────────────────────
  console.log('\n── E. Liens setter (booking_config/_types)');
  const typesRaw = await getRaw('booking_config/_types');
  const tList = typesRaw && typesRaw.fields && typesRaw.fields.list && typesRaw.fields.list.arrayValue;
  let nE = 0;
  if (tList && tList.values) {
    tList.values.forEach(function (v) {
      const f = v.mapValue && v.mapValue.fields;
      if (!f || rawStr(f.attributedSetterSlug) !== FROM_SLUG) return;
      console.log('  · ' + (rawStr(f.id) || '?') + ' « ' + (rawStr(f.label) || rawStr(f.name) || '') + ' » → ' + TO_SLUG + ' (identifiant du lien inchangé)');
      f.attributedSetterSlug = { stringValue: TO_SLUG };
      if (f.attributedSetterName) f.attributedSetterName = { stringValue: TO_NAME };
      nE++;
    });
    if (nE) await patchRaw('booking_config/_types', { list: typesRaw.fields.list }, ['list'], nE + ' lien(s)');
  }
  if (!nE) console.log('  · aucun');

  // ── F. Routing ────────────────────────────────────────────────────────────
  console.log('\n── F. Routing des leads (_config/lead_routing)');
  const lrRaw = await getRaw('_config/lead_routing');
  const lrMask = [];
  if (lrRaw && lrRaw.fields) {
    ['leads', 'selfBooking'].forEach(function (kind) {
      const r = lrRaw.fields[kind] && lrRaw.fields[kind].mapValue && lrRaw.fields[kind].mapValue.fields;
      if (!r) return;
      let changed = false;
      if (rawStr(r.single) === FROM_SLUG) { r.single = { stringValue: TO_SLUG }; changed = true; }
      if (r.members && r.members.arrayValue && r.members.arrayValue.values) {
        const vals = r.members.arrayValue.values;
        const had = vals.some(function (x) { return rawStr(x) === FROM_SLUG; });
        if (had) {
          const out = [];
          vals.forEach(function (x) {
            const s = rawStr(x) === FROM_SLUG ? TO_SLUG : rawStr(x);
            if (out.indexOf(s) < 0) out.push(s);
          });
          r.members = { arrayValue: { values: out.map(function (s) { return { stringValue: s }; }) } };
          changed = true;
        }
      }
      const w = r.weights && r.weights.mapValue && r.weights.mapValue.fields;
      if (w && w[FROM_SLUG]) {
        const num = function (x) { return x ? Number(x.integerValue != null ? x.integerValue : (x.doubleValue || 0)) : 0; };
        const sum = num(w[FROM_SLUG]) + num(w[TO_SLUG]);
        w[TO_SLUG] = { integerValue: String(Math.round(sum)) };
        delete w[FROM_SLUG];
        changed = true;
      }
      if (changed) {
        console.log('  · ' + kind + ' (mode ' + (rawStr(r.mode) || '?') + ') : elodie → ' + TO_SLUG);
        lrMask.push(kind);
      }
    });
  }
  if (lrMask.length) await patchRaw('_config/lead_routing', lrRaw.fields, lrMask);
  else console.log('  · Élodie absente des règles (ou aucune règle enregistrée)');

  // ── G. Paiements en cours ─────────────────────────────────────────────────
  console.log('\n── G. Paiements en cours créés par Élodie → createdBy Anthony');
  const pays = await q('payments', [R.ff('createdBy', 'EQUAL', FROM_UID)]);
  let nG = 0;
  const payStat = {};
  for (const p of pays) {
    const st = p.data.status || 'draft';
    payStat[st] = (payStat[st] || 0) + 1;
    if (!OPEN_PAYMENT[st]) continue;
    console.log('  ' + (p.data.leadName || p.id) + ' · ' + st + ' · ' + (p.data.totalAmount || '') + ' €');
    await patch('payments/' + p.id, { createdBy: TO_UID, createdByTransferredFrom: FROM_UID, transferredAt: now });
    nG++;
  }
  console.log('  ' + nG + ' transféré(s) · répartition de ses paiements : ' + JSON.stringify(payStat));

  // ── H. Relances IA ────────────────────────────────────────────────────────
  console.log('\n── H. Relances IA actives');
  const fus = await q('ai_followups', [R.ff('closerUid', 'EQUAL', FROM_UID)]);
  let nH = 0;
  for (const f of fus) {
    if (f.data.status !== 'active') continue;
    await patch('ai_followups/' + f.id, { closerUid: TO_UID, closerName: TO_NAME }, f.data.leadName || '');
    nH++;
  }
  if (!nH) console.log('  · aucune');

  // ── I. Numéros ────────────────────────────────────────────────────────────
  console.log('\n── I. Numéros (phone_numbers)');
  const telco = await R.getDoc('_config/telco_credentials');
  const roUsers = (telco && telco.data.ringover && telco.data.ringover.users) || {};
  const toRo = roUsers[TO_UID] || null;
  console.log('  · Ringover d\'Anthony dans _config/telco_credentials : ' + (toRo ? 'userId ' + toRo.userId + (toRo.fromNumber ? ', numéro ' + toRo.fromNumber : '') : 'ABSENT'));
  if (!toRo) warn('Anthony n\'a pas de clé Ringover dans _config/telco_credentials.ringover.users : il ne pourra pas appeler depuis le dialer tant qu\'elle n\'est pas saisie.');
  const nums = {};
  (await q('phone_numbers', [R.ff('assignedTo', 'EQUAL', FROM_UID)])).forEach(function (n) { nums[n.id] = n; });
  (await q('phone_numbers', [{ fieldFilter: { field: { fieldPath: 'assignedUserIds' }, op: 'ARRAY_CONTAINS', value: R.enc(FROM_UID) } }])).forEach(function (n) { nums[n.id] = n; });
  let nI = 0;
  for (const id of Object.keys(nums)) {
    const d = nums[id].data;
    const f = {};
    if (d.assignedTo === FROM_UID) {
      f.assignedTo = TO_UID;
      f.assignedToSlug = TO_SLUG;
      if (d.assignedToRole) f.assignedToRole = to.role;
      if (toRo && toRo.userId && d.ringoverUserId) f.ringoverUserId = String(toRo.userId);
      else if (d.ringoverUserId) warn('phone_numbers/' + id + ' garde ringoverUserId ' + d.ringoverUserId + ' (celui d\'Élodie) : à corriger quand le numéro aura été réattribué dans Ringover.');
    }
    if (Array.isArray(d.assignedUserIds) && d.assignedUserIds.indexOf(FROM_UID) >= 0) {
      const out = [];
      d.assignedUserIds.forEach(function (u) { const x = u === FROM_UID ? TO_UID : u; if (out.indexOf(x) < 0) out.push(x); });
      f.assignedUserIds = out;
    }
    console.log('  ' + (d.phoneNumber || id) + ' (' + (d.provider || '?') + ')');
    await patch('phone_numbers/' + id, f);
    nI++;
  }
  if (!nI) console.log('  · aucun');

  // ── J. Équipe ─────────────────────────────────────────────────────────────
  console.log('\n── J. Équipe (_meta/team_members)');
  const fromRaw = tmMap[fromKey].mapValue.fields;
  const toRaw = tmMap[toKey].mapValue.fields;
  const jMask = [];
  // Tableau : le champ members est réécrit en entier (valeurs brutes, types
  // préservés). Map : seuls les sous-champs touchés sont listés.
  const isArr = !!tmMembers.arrayValue;
  function setRaw(key, fields, k, v) { fields[k] = v; if (!isArr) jMask.push('members.`' + key + '`.' + k); }
  const moved = [];
  MODULE_FLAGS.forEach(function (k) {
    if (rawBool(fromRaw[k]) && !rawBool(toRaw[k])) { setRaw(toKey, toRaw, k, { booleanValue: true }); moved.push(k); }
  });
  if (to.active === false) setRaw(toKey, toRaw, 'active', { booleanValue: true });
  if (toRaw.archivedAt) { delete toRaw.archivedAt; if (!isArr) jMask.push('members.`' + toKey + '`.archivedAt'); }
  setRaw(fromKey, fromRaw, 'active', { booleanValue: false });
  setRaw(fromKey, fromRaw, 'departed', { booleanValue: true });
  setRaw(fromKey, fromRaw, 'archivedAt', { stringValue: now.toISOString() });
  setRaw(fromKey, fromRaw, 'archivedToSlug', { stringValue: TO_SLUG });
  MODULE_FLAGS.forEach(function (k) { if (rawBool(fromRaw[k])) setRaw(fromKey, fromRaw, k, { booleanValue: false }); });
  console.log('  · Élodie : active=false, departed=true, drapeaux coupés');
  console.log('  · Anthony reçoit : ' + (moved.length ? moved.join(', ') : '(aucun drapeau supplémentaire)'));
  await patchRaw('_meta/team_members', { members: tmMembers }, isArr ? ['members'] : jMask);

  // ── K. users ──────────────────────────────────────────────────────────────
  console.log('\n── K. Comptes users');
  const fu = (fromUser && fromUser.data) || {};
  const tu = toUser.data;
  const kTo = {};
  if (Array.isArray(fu.workPhones) && fu.workPhones.length) {
    const out = (tu.workPhones || []).slice();
    fu.workPhones.forEach(function (p) { if (out.indexOf(p) < 0) out.push(p); });
    kTo.workPhones = out;
  }
  if (fu.signaturesAccess === true && tu.signaturesAccess !== true) kTo.signaturesAccess = true;
  if (fu.paymentsTrigger === true && tu.paymentsTrigger !== true) kTo.paymentsTrigger = true;
  if (Object.keys(kTo).length) await patch('users/' + TO_UID, kTo, 'Anthony');
  else console.log('  · Anthony : rien à ajouter');
  if (fromUser) {
    await patch('users/' + FROM_UID, {
      status: 'archived', archivedAt: now, archivedBy: 'script:transfer-elodie-anthony',
      archivedFromSlug: FROM_SLUG, archivedToSlug: TO_SLUG, archiveTransferCount: nD,
      archiveIncludedClosed: false, workPhonesBeforeArchive: fu.workPhones || [], workPhones: []
    }, 'Élodie');
  } else warn('users/' + FROM_UID + ' introuvable');

  // ── L. Firebase Auth ──────────────────────────────────────────────────────
  console.log('\n── L. Firebase Auth — désactivation du compte d\'Élodie');
  const itBase = 'https://identitytoolkit.googleapis.com/v1/projects/' + PROJECT;
  const itTok = await R.tokenFor('https://www.googleapis.com/auth/cloud-platform');
  const look = await R.request('POST', itBase + '/accounts:lookup',
    { Authorization: 'Bearer ' + itTok, 'Content-Type': 'application/json' }, { localId: [FROM_UID] });
  const acc = look && look.users && look.users[0];
  if (!acc) warn('compte Auth ' + FROM_UID + ' introuvable');
  else {
    console.log('  · ' + acc.email + ' — actuellement ' + (acc.disabled ? 'désactivé' : 'actif'));
    console.log('    ' + (APPLY ? '✏️  ' : '→ ') + 'disableUser=true + révocation des sessions');
    nWrites++;
    if (APPLY) {
      await R.request('POST', itBase + '/accounts:update',
        { Authorization: 'Bearer ' + itTok, 'Content-Type': 'application/json' },
        { localId: FROM_UID, disableUser: true, validSince: String(Math.floor(Date.now() / 1000)) });
    }
  }

  // ── M. Audit ──────────────────────────────────────────────────────────────
  console.log('\n── M. audit_log');
  const auditId = 'transfer_elodie_anthony_' + now.toISOString().slice(0, 10);
  const audit = {
    action: 'archive_user', via: 'script:transfer-elodie-anthony', targetUid: FROM_UID, targetName: from.fullName || FROM_SLUG,
    fromSlug: FROM_SLUG, toSlug: TO_SLUG, toUid: TO_UID, at: now, bookingPersonId: PID,
    counts: { bookingsUpcoming: nB, bookingsPastStamped: nC, leads: nD, leadsWonKept: nKeep, setterLinks: nE, payments: nG, aiFollowups: nH, phoneNumbers: nI },
    includeClosed: false
  };
  console.log('    ' + (APPLY ? '✏️  ' : '→ ') + 'audit_log/' + auditId + ' ' + JSON.stringify(audit.counts));
  if (APPLY) await R.createDoc('audit_log/' + auditId, audit);

  // ── Récap ─────────────────────────────────────────────────────────────────
  console.log('\n=== ' + (APPLY ? 'ÉCRIT' : 'SERAIT ÉCRIT') + ' : ' + nWrites + ' opération(s) ===');
  if (warnings.length) { console.log('\nPoints d\'attention :'); warnings.forEach(function (w) { console.log('  ⚠ ' + w); }); }
  console.log('\nÀ faire à la main ensuite :');
  console.log('  1. Google Agenda (' + (tokEmail || 'compte de la fiche') + ') : partager « ' + (evCal ? (evCal.name || evCal.id) : 'primary') + ' » avec Anthony');
  console.log('     (droit « Apporter des modifications »). Les RDV et liens Meet y restent, rien à reconnecter.');
  console.log('  2. Booking → Experts → « ' + TO_NAME + ' » : vérifier les horaires (ceux d\'Élodie) et, si Anthony le souhaite,');
  console.log('     brancher son agenda perso en agenda secondaire pour bloquer ses indisponibilités.');
  console.log('  3. Ringover : réattribuer le numéro d\'Élodie à Anthony, puis saisir sa clé dans _config/telco_credentials.');
})().catch(function (e) { console.error('\n❌ ' + e.message); process.exit(1); });
