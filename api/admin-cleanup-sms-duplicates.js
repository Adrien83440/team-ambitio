// api/admin-cleanup-sms-duplicates.js
// TEMPORAIRE — Nettoie les doublons de SMS dans leads/{id}.communications[].
//
// Contexte : avant la mise en place de l'idempotence dans ringover-sms-inbound.js,
// un même SMS entrant pouvait être écrit plusieurs fois (double webhook Ringover
// et/ou scénario Make résiduel), avec parfois un préfixe « Message: » et des
// formats de date différents — d'où des fils de discussion avec doublons et un
// ordre incohérent (cf. inbox / sales-contact).
//
// Ce script, pour chaque lead :
//   1. retire le préfixe « Message: » des communications de type sms ;
//   2. déduplique les SMS :
//        - clé primaire = providerMessageId (quand présent) ;
//        - sinon clé de repli = direction + contenu nettoyé + date à la minute ;
//   3. re-trie communications[] par date croissante (ISO ou autre format géré).
//
// SÉCURITÉ :
//   - POST + admin uniquement.
//   - dryRun = true PAR DÉFAUT : aucune écriture tant que le body ne contient
//     pas explicitement { "dryRun": false }.
//   - Rapport détaillé par lead (avant/après, doublons supprimés, préfixes
//     nettoyés) renvoyé dans la réponse.
//
// Usage (console navigateur, en tant qu'admin) :
//   fetch('/api/admin-cleanup-sms-duplicates', { method:'POST',
//     headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
//     body: JSON.stringify({ dryRun: true }) }).then(r=>r.json()).then(console.log)

const { db, admin } = require('./_firebaseAdmin');
const { requireAuth } = require('./_verifyFirebaseAuth');

// Même nettoyage que dans ringover-sms-inbound.js (cohérence).
function cleanSmsText(raw) {
  if (!raw) return '';
  return String(raw).replace(/^\s*message\s*:\s*/i, '').trim();
}

// Convertit une date de communication (ISO string, "dd/mm/yyyy hh:mm", Firestore
// Timestamp, Date) en millisecondes pour le tri. Retourne 0 si non interprétable
// (ces entrées seront placées en tête, ordre stable).
function commDateToMs(c) {
  if (!c) return 0;
  const v = c.date || c.createdAt;
  if (!v) return 0;
  // Firestore Timestamp
  if (typeof v === 'object' && typeof v.toMillis === 'function') {
    try { return v.toMillis(); } catch (e) { return 0; }
  }
  if (typeof v === 'object' && typeof v._seconds === 'number') {
    return v._seconds * 1000;
  }
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') {
    // ISO
    const iso = Date.parse(v);
    if (!isNaN(iso)) return iso;
    // Format FR "dd/mm/yyyy hh:mm"
    const m = v.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
    if (m) {
      const d = new Date(
        parseInt(m[3], 10), parseInt(m[2], 10) - 1, parseInt(m[1], 10),
        parseInt(m[4], 10), parseInt(m[5], 10)
      );
      return d.getTime();
    }
  }
  return 0;
}

// Clé de regroupement à la minute (pour le repli sans providerMessageId).
function minuteKey(ms) {
  if (!ms) return '0';
  return String(Math.floor(ms / 60000));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (auth.role !== 'admin') return res.status(403).json({ error: 'admin only' });

  // dryRun par défaut TRUE : il faut explicitement { dryRun: false } pour écrire.
  const dryRun = !(req.body && req.body.dryRun === false);
  const limit = (req.body && Number(req.body.limit)) || 2000;

  const report = {
    dryRun,
    leadsScanned: 0,
    leadsWithSms: 0,
    leadsModified: 0,
    totalDuplicatesRemoved: 0,
    totalPrefixesCleaned: 0,
    details: [],
  };

  try {
    // On récupère les leads ayant déjà eu un contact SMS en priorité, mais pour
    // rester simple et exhaustif on parcourt les leads par paquet.
    const snap = await db.collection('leads').limit(limit).get();
    report.leadsScanned = snap.size;

    for (const doc of snap.docs) {
      const data = doc.data();
      const comms = Array.isArray(data.communications) ? data.communications : [];
      if (!comms.length) continue;

      const smsComms = comms.filter(c => c && c.type === 'sms');
      if (!smsComms.length) continue;
      report.leadsWithSms++;

      let prefixesCleaned = 0;
      let duplicatesRemoved = 0;

      // 1) Nettoyage du préfixe sur les SMS (sur une copie).
      const cleaned = comms.map(c => {
        if (c && c.type === 'sms' && typeof c.content === 'string') {
          const nc = cleanSmsText(c.content);
          if (nc !== c.content) prefixesCleaned++;
          return Object.assign({}, c, { content: nc });
        }
        return c;
      });

      // 2) Déduplication des SMS uniquement (les non-sms sont conservés tels quels).
      const seen = new Set();
      const deduped = [];
      for (const c of cleaned) {
        if (!c || c.type !== 'sms') { deduped.push(c); continue; }
        const pid = c.providerMessageId ? String(c.providerMessageId) : '';
        let key;
        if (pid) {
          key = 'pid:' + pid;
        } else {
          const dir = (c.direction || '').toLowerCase();
          const ms = commDateToMs(c);
          key = 'rep:' + dir + ':' + minuteKey(ms) + ':' + (c.content || '');
        }
        if (seen.has(key)) { duplicatesRemoved++; continue; }
        seen.add(key);
        deduped.push(c);
      }

      // 3) Re-tri par date croissante (tri stable : on garde l'ordre relatif
      //    des entrées de même timestamp).
      const withIdx = deduped.map((c, i) => ({ c, i }));
      withIdx.sort((a, b) => {
        const da = commDateToMs(a.c);
        const db_ = commDateToMs(b.c);
        if (da !== db_) return da - db_;
        return a.i - b.i;
      });
      const finalComms = withIdx.map(x => x.c);

      const changed = (prefixesCleaned > 0) || (duplicatesRemoved > 0) ||
        JSON.stringify(finalComms) !== JSON.stringify(comms);

      if (changed) {
        report.leadsModified++;
        report.totalDuplicatesRemoved += duplicatesRemoved;
        report.totalPrefixesCleaned += prefixesCleaned;
        report.details.push({
          leadId: doc.id,
          name: data.nom || data.fullName || null,
          telephone: data.telephone || null,
          smsBefore: smsComms.length,
          smsAfter: finalComms.filter(c => c && c.type === 'sms').length,
          duplicatesRemoved,
          prefixesCleaned,
        });

        if (!dryRun) {
          await doc.ref.update({
            communications: finalComms,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      }
    }

    // En dry-run, on limite la taille du détail renvoyé pour rester lisible.
    if (dryRun && report.details.length > 100) {
      report.detailsTruncated = report.details.length;
      report.details = report.details.slice(0, 100);
    }

    res.json({ ok: true, ...report });
  } catch (err) {
    console.error('[cleanup-sms-duplicates] FATAL:', err.message);
    res.status(500).json({ ok: false, error: err.message, partialReport: report });
  }
};
