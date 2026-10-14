// ============================================================================
// api/aide-admin.js — AIDE TEAM : administration (page aide-admin.html)
// ----------------------------------------------------------------------------
// Admins uniquement. Fiches pratiques, questions sans réponse, conversations,
// liens utiles et réglages de l'assistant (voir api/_aide.js).
// Rien n'est jamais supprimé : une fiche s'archive, une fiche de départ
// modifiée peut revenir à sa version d'origine (useSeed, contenu conservé).
//
// POST Bearer <ID token admin> { action, … }
//   overview                           → { fiches, categories, config, seedIds, stats }
//   questions { status? }              → { questions }
//   question_update { id, status, ficheId? }
//   save_fiche { fiche }               → { id }
//   archive { id, archived }
//   reset_seed { id }
//   conversations { flagged? }         → { conversations } (sans les messages)
//   conversation { id }                → { conversation }
//   save_config { config }
//   upload_image { mediaType, data }   → { id }
// ============================================================================

const { requireAdmin } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const { db } = require('./_firebaseAdmin');
const { cap } = require('./_ai');
const A = require('./_aide');

const MAX_IMG = 900 * 1024; // base64 — sous la limite de 1 Mo par document

function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'fiche';
}

function cleanGuide(g) {
  return (Array.isArray(g) ? g : []).slice(0, 15).map(function (x) {
    return { page: cap(String((x && x.page) || '').replace(/\.html$/, '').replace(/[^a-z0-9_-]/gi, ''), 60), sel: cap(String((x && x.sel) || ''), 300), text: cap(String((x && x.text) || ''), 400) };
  }).filter(function (x) { return x.text; });
}

function whoName(auth) {
  const u = auth.userData || {};
  return u.name || u.displayName || auth.email || auth.uid;
}

module.exports = async function (req, res) {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const body = parseBody(req);
  const action = String(body.action || '');

  try {
    if (action === 'overview') {
      const [cfg, fiches] = await Promise.all([A.getConfig(true), A.getAllFiches(true)]);
      const since = Date.now() - 7 * 86400000;
      let convWeek = 0, openQ = 0;
      try { convWeek = (await db.collection('aide_conversations').where('updatedAt', '>=', since).count().get()).data().count; } catch (e) { /* stats best-effort */ }
      try { openQ = (await db.collection('aide_questions').where('status', '==', 'open').count().get()).data().count; } catch (e) { /* idem */ }
      res.status(200).json({
        ok: true, fiches: A.sortFiches(fiches), categories: A.CATEGORIES, config: cfg, seedIds: A.SEED_IDS,
        stats: { conversations7j: convWeek, questionsOuvertes: openQ },
      });
      return;
    }

    if (action === 'questions') {
      const st = ['open', 'done', 'ignored'].indexOf(body.status) >= 0 ? body.status : null;
      let q = db.collection('aide_questions');
      if (st) q = q.where('status', '==', st);
      const s = await q.limit(300).get();
      const list = [];
      s.forEach(function (d) { list.push(Object.assign({ id: d.id }, d.data())); });
      list.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
      res.status(200).json({ ok: true, questions: list });
      return;
    }

    if (action === 'question_update') {
      const id = String(body.id || '');
      const st = ['open', 'done', 'ignored'].indexOf(body.status) >= 0 ? body.status : 'done';
      if (!id) { res.status(400).json({ ok: false, error: 'id_required' }); return; }
      const upd = { status: st, handledAt: Date.now(), handledBy: auth.uid, handledByName: whoName(auth) };
      if (body.ficheId) upd.ficheId = String(body.ficheId).slice(0, 80);
      await db.collection('aide_questions').doc(id).set(upd, { merge: true });
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'save_fiche') {
      const f = body.fiche || {};
      const title = cap(String(f.title || '').trim(), 160);
      if (!title) { res.status(400).json({ ok: false, error: 'title_required', message: 'Le titre est obligatoire.' }); return; }
      let id = String(f.id || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 80);
      if (!id) {
        id = slugify(title);
        const exists = (await db.collection('aide_articles').doc(id).get()).exists || A.SEED_IDS.indexOf(id) >= 0;
        if (exists) id = id + '-' + Math.random().toString(36).slice(2, 6);
      }
      const doc = {
        title: title,
        cat: A.CATEGORIES.indexOf(f.cat) >= 0 ? f.cat : 'Dépannage',
        body: cap(String(f.body || ''), 12000),
        tags: cap(String(f.tags || ''), 500),
        pages: (Array.isArray(f.pages) ? f.pages : String(f.pages || '').split(',')).map(function (p) { return String(p).trim().replace(/\.html$/, '').replace(/[^a-z0-9_-]/gi, ''); }).filter(Boolean).slice(0, 12),
        adminOnly: f.adminOnly === true,
        guide: cleanGuide(f.guide),
        images: (Array.isArray(f.images) ? f.images : []).map(function (x) { return String(x).replace(/[^A-Za-z0-9_-]/g, ''); }).filter(Boolean).slice(0, 6),
        status: f.status === 'draft' ? 'draft' : 'published',
        archived: f.archived === true,
        useSeed: false,
        updatedAt: Date.now(), updatedBy: auth.uid, updatedByName: whoName(auth),
      };
      const ref = db.collection('aide_articles').doc(id);
      const prev = await ref.get();
      if (!prev.exists) { doc.createdAt = Date.now(); doc.createdBy = auth.uid; doc.fromSeed = A.SEED_IDS.indexOf(id) >= 0; }
      await ref.set(doc, { merge: true });
      A.invalidate();
      res.status(200).json({ ok: true, id: id });
      return;
    }

    if (action === 'archive') {
      const id = String(body.id || '').replace(/[^a-z0-9_-]/gi, '');
      if (!id) { res.status(400).json({ ok: false, error: 'id_required' }); return; }
      const ref = db.collection('aide_articles').doc(id);
      const s = await ref.get();
      const upd = { archived: body.archived !== false, archivedAt: Date.now(), archivedBy: auth.uid };
      // Fiche de départ jamais modifiée : on n'enregistre que l'archivage.
      if (!s.exists && A.SEED_IDS.indexOf(id) >= 0) upd.useSeed = true;
      await ref.set(upd, { merge: true });
      A.invalidate();
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'reset_seed') {
      const id = String(body.id || '').replace(/[^a-z0-9_-]/gi, '');
      if (A.SEED_IDS.indexOf(id) < 0) { res.status(400).json({ ok: false, error: 'not_seed', message: 'Cette fiche n\'a pas de version d\'origine.' }); return; }
      // Le contenu modifié reste dans le document (historique), il est juste ignoré.
      await db.collection('aide_articles').doc(id).set({ useSeed: true, archived: false, resetAt: Date.now(), resetBy: auth.uid }, { merge: true });
      A.invalidate();
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'conversations') {
      let q = db.collection('aide_conversations').orderBy('updatedAt', 'desc').limit(150);
      const s = await q.get();
      const list = [];
      s.forEach(function (d) {
        const x = d.data() || {};
        if (body.flagged && !x.hasUnanswered && !x.hasDown) return;
        list.push({ id: d.id, uid: x.uid, name: x.name, role: x.role, page: x.page, startedAt: x.startedAt, updatedAt: x.updatedAt, count: x.count || 0, lastQuestion: x.lastQuestion || '', hasUnanswered: !!x.hasUnanswered, hasDown: !!x.hasDown });
      });
      res.status(200).json({ ok: true, conversations: list });
      return;
    }

    if (action === 'conversation') {
      const id = String(body.id || '').replace(/[^A-Za-z0-9_-]/g, '');
      const s = await db.collection('aide_conversations').doc(id).get();
      if (!s.exists) { res.status(404).json({ ok: false, error: 'not_found' }); return; }
      res.status(200).json({ ok: true, conversation: Object.assign({ id: s.id }, s.data()) });
      return;
    }

    if (action === 'save_config') {
      const c = body.config || {};
      const upd = { updatedAt: Date.now(), updatedBy: auth.uid };
      if (typeof c.enabled === 'boolean') upd.enabled = c.enabled;
      if (c.dailyLimit !== undefined) upd.dailyLimit = Math.max(0, Math.min(500, Math.round(Number(c.dailyLimit) || 0)));
      if (c.contact !== undefined) upd.contact = cap(String(c.contact || '').trim(), 80) || A.DEFAULT_CONFIG.contact;
      if (c.welcome !== undefined) upd.welcome = cap(String(c.welcome || ''), 600);
      if (Array.isArray(c.links)) {
        const seen = {};
        upd.links = c.links.map(function (l) {
          return { key: String((l && l.key) || '').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40), label: cap(String((l && l.label) || ''), 160), url: cap(String((l && l.url) || '').trim(), 600), note: cap(String((l && l.note) || ''), 300) };
        }).filter(function (l) {
          if (!l.key || seen[l.key]) return false;
          if (l.url && !/^https?:\/\//i.test(l.url)) return false;
          seen[l.key] = true; return true;
        }).slice(0, 40);
      }
      await db.collection('_config').doc('aide').set(upd, { merge: true });
      A.invalidate();
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'upload_image') {
      const mt = String(body.mediaType || '');
      const data = String(body.data || '');
      if (['image/jpeg', 'image/png', 'image/webp'].indexOf(mt) < 0) { res.status(400).json({ ok: false, error: 'type', message: 'Format JPEG, PNG ou WebP uniquement.' }); return; }
      if (!data || data.length > MAX_IMG) { res.status(400).json({ ok: false, error: 'size', message: 'Image trop lourde après compression (900 Ko max).' }); return; }
      const ref = await db.collection('aide_images').add({ mediaType: mt, data: data, at: Date.now(), by: auth.uid });
      res.status(200).json({ ok: true, id: ref.id });
      return;
    }

    res.status(400).json({ ok: false, error: 'unknown_action' });
  } catch (e) {
    console.error('[aide-admin]', e);
    res.status(200).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};
