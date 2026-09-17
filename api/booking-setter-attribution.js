// ============================================================================
// api/booking-setter-attribution.js
// ----------------------------------------------------------------------------
// LIEN SETTER ATTRIBUÉ (17/09/2026)
//
// Endpoint public appelé par booking.html JUSTE AVANT la création d'un RDV sur
// une consultation marquée « Lien attribué à un setter » dans booking-admin
// (champ `attributedSetterSlug` du type, dans booking_config/_types).
//
// Cas d'usage : le setter écrit (DM Instagram) envoie SON lien au prospect qui
// ne veut pas donner ses coordonnées en direct. Le prospect réserve dans
// l'agenda de la closeuse ; le setter propriétaire du lien devient le setter
// IMMUABLE de la fiche (setterSlug / setterName / setterRole / setterAt),
// base de la commission Setting au close.
//
// URL  : POST https://team.alteore.com/api/booking-setter-attribution
// Auth : aucune — endpoint public (visiteur anonyme du booking)
//
// Body (JSON) :
//   {
//     typeId    : "rdv_elodie_steven_a1b",  // requis
//     personId  : "<doc expert>",           // optionnel — sert à assignedTo
//     prenom, nom, email, telephone, secteur, message,
//     leadId    : "<id>"                    // optionnel (?leadId= de l'URL)
//   }
//
// Réponse 200 :
//   { ok:true, attributed:false, reason:"..." }        → rien à faire
//   { ok:true, attributed:true,
//     leadId, created:bool,
//     setterSlug, setterName, setterUid,   // setter EFFECTIF de la fiche
//     linkSetterSlug,                      // propriétaire du lien
//     conflict:bool }                      // fiche déjà settée par un autre
//
// POURQUOI un endpoint (et pas la Cloud Function onBookingCreated)
// ----------------------------------------------------------------
// La fiche d'un RDV public est créée par onBookingCreated, qui ne pose aucun
// setter. Plutôt que de modifier la Cloud Function, on résout / crée la fiche
// ICI, puis booking.html inscrit le `leadId` retourné sur le booking : la
// Cloud Function prend alors sa branche « lead existant » (booking.leadId) et
// ne crée pas de doublon.
//
// SÉCURITÉ
// --------
// Le slug du setter n'est JAMAIS lu dans la requête : il vient de la config du
// type, relue côté serveur, puis validé contre le roster (_meta/team_members,
// rôle setting, membre actif). Un visiteur ne peut donc pas s'attribuer un
// lead en bricolant l'URL ou le body.
//
// WRITE-ONCE
// ----------
// L'Admin SDK contourne firestore.rules (setterUnchanged()). Le verrou est
// donc ré-appliqué ici, en transaction : un setterSlug déjà présent n'est
// jamais remplacé. Règle métier (Adrien, 17/09/2026) : LE PREMIER SETTER
// GAGNE. Si la fiche porte déjà un autre setter, on le renvoie comme setter
// effectif (booking.bookedBySlug le suivra) et on trace le passage par le
// lien dans la timeline.
//
// Fail-open : toute erreur → booking.html continue et crée le RDV quand même
// (bookedBySlug = propriétaire du lien). Leads Live rattrape ensuite le
// setter manquant sur la fiche (voir sales-leads.html, « rattrapage lien
// setter »).
// ============================================================================

const crypto = require('crypto');
const { admin, db } = require('./_firebaseAdmin');
const parseBody = require('./_parseBody');

const SETTER_ROLES = { setter: 1, setter_ecrit: 1, closer_setter: 1 };

function str(v, max) {
  return (v == null ? '' : String(v)).trim().slice(0, max || 300);
}

// 9 derniers digits — même clé que api/alteoform-submit.js et sales-leads.html.
function phoneNormalized(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/[^\d]/g, '');
  if (d.length < 6) return null;
  if (d.length >= 9) return d.slice(-9);
  return d;
}

// Téléphone canonique des leads : E.164 strict +33XXXXXXXXX. On ne convertit
// que les numéros français reconnaissables ; le reste est gardé tel quel
// (sans espaces) plutôt que d'inventer un indicatif.
function toE164(raw) {
  const s = String(raw || '').replace(/[^\d+]/g, '');
  if (!s) return '';
  if (/^\+33\d{9}$/.test(s)) return s;
  if (/^\+330\d{9}$/.test(s)) return '+33' + s.slice(4);
  if (/^0033\d{9}$/.test(s)) return '+33' + s.slice(4);
  if (/^33\d{9}$/.test(s)) return '+' + s;
  if (/^0\d{9}$/.test(s)) return '+33' + s.slice(1);
  if (/^[1-9]\d{8}$/.test(s)) return '+33' + s;
  return s;
}

// Variantes historiques du champ `telephone` — filet pour les vieilles fiches
// sans phoneNormalized (même logique que findLead() de la Cloud Function).
function telVariants(raw) {
  const e164 = toE164(raw);
  const out = {};
  const clean = String(raw || '').replace(/\s+/g, '');
  if (clean) out[clean] = 1;
  if (/^\+33\d{9}$/.test(e164)) {
    const base = '0' + e164.slice(3);
    out[e164] = 1;
    out[base] = 1;
    out['33' + e164.slice(3)] = 1;
    out[base.replace(/(\d{2})(?=\d)/g, '$1 ')] = 1;
    out[base.replace(/(\d{2})(?=\d)/g, '$1.')] = 1;
  }
  return Object.keys(out);
}

function dateNowFR() {
  return new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
}

// Le champ members peut être un OBJET (slug→membre) ou un ARRAY ; on se fie
// toujours au `slug` interne (même convention que nav.js).
async function loadRoster() {
  const snap = await db.collection('_meta').doc('team_members').get();
  const members = snap.exists ? (snap.data() || {}).members : null;
  const list = [];
  if (Array.isArray(members)) {
    members.forEach((m) => { if (m && m.slug) list.push(m); });
  } else if (members && typeof members === 'object') {
    Object.keys(members).forEach((k) => {
      const m = members[k];
      if (m && typeof m === 'object') list.push(Object.assign({}, m, { slug: m.slug || k }));
    });
  }
  return list;
}

function memberName(m) {
  return m.fullName || m.displayName || m.name || m.slug;
}

function pickAlive(snap) {
  if (snap.empty) return null;
  for (const d of snap.docs) {
    if (d.data()._merged !== true) return d;
  }
  return null;
}

async function findLeadDoc(leadId, emailRaw, telRaw) {
  if (leadId) {
    const direct = await db.collection('leads').doc(leadId).get();
    if (direct.exists && direct.data()._merged !== true) return direct;
  }
  const emailLc = emailRaw.toLowerCase();
  const emails = emailRaw && emailRaw !== emailLc ? [emailLc, emailRaw] : [emailLc];
  for (const e of emails) {
    if (!e) continue;
    const sn = await db.collection('leads').where('email', '==', e).limit(5).get();
    const hit = pickAlive(sn);
    if (hit) return hit;
  }
  const phoneNorm = phoneNormalized(telRaw);
  if (phoneNorm && phoneNorm.length === 9) {
    const sn = await db.collection('leads').where('phoneNormalized', '==', phoneNorm).limit(5).get();
    const hit = pickAlive(sn);
    if (hit) return hit;
    for (const v of telVariants(telRaw)) {
      const sn2 = await db.collection('leads').where('telephone', '==', v).limit(5).get();
      const hit2 = pickAlive(sn2);
      if (hit2) return hit2;
    }
  }
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const body = parseBody(req) || {};
  const typeId = str(body.typeId, 80);
  const personId = str(body.personId, 80);
  const leadIdIn = str(body.leadId, 120).replace(/\//g, '');
  const prenom = str(body.prenom, 80);
  const nom = str(body.nom, 80);
  const emailRaw = str(body.email, 200);
  const telRaw = str(body.telephone, 40);
  const secteur = str(body.secteur, 200);
  const message = str(body.message, 2000);

  if (!typeId) {
    res.status(400).json({ error: 'typeId_required' });
    return;
  }
  if (!emailRaw && !phoneNormalized(telRaw) && !leadIdIn) {
    // Aucun moyen d'identifier le prospect : on ne crée pas une fiche fantôme.
    res.status(200).json({ ok: true, attributed: false, reason: 'no_contact' });
    return;
  }

  try {
    // ── 1. Le setter vient de la CONFIG DU TYPE, jamais de la requête ───────
    const typesSnap = await db.collection('booking_config').doc('_types').get();
    const types = typesSnap.exists ? ((typesSnap.data() || {}).list || []) : [];
    const type = types.filter((t) => t && t.id === typeId)[0] || null;
    const linkSlug = type ? str(type.attributedSetterSlug, 80) : '';
    if (!type || !linkSlug) {
      res.status(200).json({ ok: true, attributed: false, reason: 'type_not_attributed' });
      return;
    }
    if (type.isCoaching === true) {
      res.status(200).json({ ok: true, attributed: false, reason: 'coaching_type' });
      return;
    }

    // ── 2. Validation contre le roster ──────────────────────────────────────
    const roster = await loadRoster();
    const bySlug = {};
    roster.forEach((m) => { bySlug[m.slug] = m; });
    const linkMember = bySlug[linkSlug] || null;
    if (!linkMember || !SETTER_ROLES[String(linkMember.role || '')]
        || linkMember.active === false || linkMember.departed === true) {
      console.warn('[booking-setter-attribution] setter du lien invalide :', linkSlug, 'type', typeId);
      res.status(200).json({ ok: true, attributed: false, reason: 'setter_invalid' });
      return;
    }
    const linkName = memberName(linkMember);
    const linkRole = String(linkMember.role);
    const typeLabel = str(type.label, 120) || typeId;

    // ── 3. assignedTo = l'experte du RDV, résolue par firebaseUid ───────────
    let hostSlug = '';
    if (personId) {
      try {
        const pSnap = await db.collection('booking_config').doc(personId).get();
        const p = pSnap.exists ? (pSnap.data() || {}) : {};
        if (p.__type === 'person' && p.firebaseUid) {
          const host = roster.filter((m) => m.firebaseUid === p.firebaseUid || m.uid === p.firebaseUid)[0];
          if (host && host.active !== false && host.departed !== true) hostSlug = host.slug;
        }
      } catch (e) {
        console.warn('[booking-setter-attribution] experte non résolue :', e && e.message);
      }
    }

    const dateFR = dateNowFR();
    const FV = admin.firestore.FieldValue;

    // ── 4. Fiche existante → pose write-once du setter ──────────────────────
    const existing = await findLeadDoc(leadIdIn, emailRaw, telRaw);
    if (existing) {
      const out = await db.runTransaction(async (tx) => {
        const fresh = await tx.get(existing.ref);
        const d = fresh.data() || {};
        const cur = str(d.setterSlug, 80);
        if (!cur) {
          tx.update(existing.ref, {
            setterSlug: linkSlug,
            setterName: linkName,
            setterRole: linkRole,
            setterAt: FV.serverTimestamp(),
            setterVia: 'booking_link',
            setterLinkTypeId: typeId,
            updatedAt: FV.serverTimestamp(),
            timeline_history: FV.arrayUnion({
              text: '🎯 Setting par ' + linkName + ' · RDV pris via son lien (' + typeLabel + ')',
              date: dateFR, color: '#fb923c'
            })
          });
          return { slug: linkSlug, conflict: false };
        }
        if (cur === linkSlug) return { slug: linkSlug, conflict: false };
        // Premier setter gagne : on ne touche à rien, on trace seulement.
        tx.update(existing.ref, {
          updatedAt: FV.serverTimestamp(),
          timeline_history: FV.arrayUnion({
            text: '🔗 RDV pris via le lien de ' + linkName + ' (' + typeLabel + ') — setter d\'origine conservé',
            date: dateFR, color: '#9ca3af'
          })
        });
        return { slug: cur, conflict: true };
      });

      const eff = bySlug[out.slug] || null;
      res.status(200).json({
        ok: true, attributed: true, created: false,
        leadId: existing.id,
        setterSlug: out.slug,
        setterName: eff ? memberName(eff) : out.slug,
        setterUid: eff ? (eff.firebaseUid || eff.uid || '') : '',
        linkSetterSlug: linkSlug,
        conflict: out.conflict
      });
      return;
    }

    // ── 5. Pas de fiche → création, setter posé à la naissance ──────────────
    // ID déterministe (contact) : une double soumission retombe sur la même
    // fiche au lieu d'en créer une seconde.
    const emailLc = emailRaw.toLowerCase();
    const phoneNorm = phoneNormalized(telRaw);
    const key = emailLc || phoneNorm;
    const newId = 'sl_' + crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 20);
    let fullName = (prenom + ' ' + nom).trim();
    if (!fullName) fullName = emailLc || telRaw || 'Sans nom';

    const lead = {
      nom: fullName,
      email: emailLc,
      telephone: toE164(telRaw),
      phoneNormalized: phoneNorm,
      secteur: secteur,
      message: message,
      type: 'self_booking',
      source: 'setter_link',
      sourceDetail: typeLabel,
      utm: 'Lien setter · ' + linkName,
      stage: 'set',
      status: 'rdv_pose',
      assignedTo: hostSlug,
      setterSlug: linkSlug,
      setterName: linkName,
      setterRole: linkRole,
      setterAt: FV.serverTimestamp(),
      setterVia: 'booking_link',
      setterLinkTypeId: typeId,
      notesHistory: [],
      timeline_history: [{
        text: '✨ Lead créé via le lien de ' + linkName + ' (' + typeLabel + ') · 🎯 Setting par ' + linkName,
        date: dateFR, color: '#fb923c'
      }],
      createdAt: FV.serverTimestamp(),
      updatedAt: FV.serverTimestamp()
    };

    const ref = db.collection('leads').doc(newId);
    let created = true;
    try {
      await ref.create(lead);
    } catch (e) {
      // ALREADY_EXISTS (code 6) : double soumission — la fiche est déjà là.
      if (e && (e.code === 6 || /already exists/i.test(String(e.message)))) created = false;
      else throw e;
    }

    res.status(200).json({
      ok: true, attributed: true, created: created,
      leadId: newId,
      setterSlug: linkSlug,
      setterName: linkName,
      setterUid: linkMember.firebaseUid || linkMember.uid || '',
      linkSetterSlug: linkSlug,
      conflict: false
    });
  } catch (e) {
    console.error('[booking-setter-attribution] unexpected error:', e);
    // Fail-open : booking.html crée le RDV quand même.
    res.status(200).json({ ok: true, attributed: false, reason: 'internal_error' });
  }
};

module.exports.__test = { phoneNormalized, toE164, telVariants };
