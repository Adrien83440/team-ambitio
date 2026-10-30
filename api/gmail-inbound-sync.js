// ============================================================================
// api/gmail-inbound-sync.js — E-MAILS REÇUS DES PROSPECTS → FICHE + POPUP
// ----------------------------------------------------------------------------
// Toutes les 5 min (cron Vercel). Lit la boîte strategie@ (Gmail API, compte
// OAuth email_tokens/strategie, scope gmail.readonly) et rattache à la fiche
// lead chaque e-mail ÉCRIT PAR UN HUMAIN (prospect qui répond à une relance,
// à une confirmation de RDV…). Avant le 20/10/2026 ces réponses restaient
// dans Gmail et le setter / closer passait à côté (cas Gérard).
//
// Pour chaque e-mail retenu :
//   • leads.communications += { type:'email', direction:'inbound', … } —
//     visible dans l'Historique Leads Live et l'onglet E-mails de la fiche ;
//   • leads.timeline_history += « ✉️ E-mail reçu — objet » ;
//   • inbox_notifications (cloche + toast + son) pour la personne assignée,
//     une copie (`copyOf`) pour le closer du dernier RDV s'il est différent ;
//     les admins voient l'original. La veille « prospect sans réponse »
//     (lead-reply-watch) le surveille comme un SMS.
//
// SEULEMENT LES HUMAINS (règle Adrien 20/10/2026) — écartés :
//   • expéditeur sans fiche lead (ni directement, ni via le fil : réponse
//     d'une autre adresse à un e-mail qu'on avait envoyé à un prospect) ;
//   • nos propres adresses, Spam / Promotions / Réseaux sociaux / Forums ;
//   • robots : no-reply, mailer-daemon, notifications… ; en-têtes
//     Auto-Submitted, X-Autoreply, Precedence bulk/list, List-Id,
//     List-Unsubscribe, rapports de non-remise, invitations agenda ;
//   • réponses d'absence et accusés (objet ou début de texte reconnu) ;
//   • texte vide une fois la citation de notre e-mail retirée.
// Chaque décision est tracée dans email_inbound/{gmailMessageId} (écriture
// serveur seule), ce qui sert aussi d'anti-doublon.
//
// Premier passage : rattrapage des `lookbackDays` derniers jours (30 par
// défaut), SANS popup. Ensuite : popup seulement pour un e-mail de moins de
// 24 h (un cron arrêté longtemps ne déclenche pas une rafale).
//
// Flag : _config/gmail_inbound { enabled, account:'strategie', lookbackDays,
//        lastSyncMs, lastRunAt, lastError } — lastSyncMs posé par le cron.
//
// GET  Bearer <CRON_SECRET>                       → passe complète (si enabled)
// POST Bearer <ID token admin> { dryRun:true }    → ce qui serait rattaché /
//                                                   écarté, sans écriture
// POST Bearer <ID token admin> { action:'run' }   → passe complète
// ============================================================================

const { requireAdmin } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const { db, admin } = require('./_firebaseAdmin');
const { loadOauthConfig, loadAccountTokens, refreshAccessToken } = require('./_gmailSend');
const { findLeadDoc } = require('./_leadLookup');
const { estBloque } = require('./_blockedContacts');

const CFG_DOC = 'gmail_inbound';
const DEFAULT_ACCOUNT = 'strategie';
const DEFAULT_LOOKBACK_DAYS = 30;
const OVERLAP_MS = 15 * 60000;          // recouvrement entre deux passes
const NOTIFY_MAX_AGE_MS = 24 * 3600000;  // pas de popup pour un vieux message
const MAX_LIST = 500;
const MAX_PER_RUN = 120;
const CONTENT_MAX = 5000;
const DEPARTED = { guillaumes: 1 };
const OUR_DOMAINS = ['adrienemily.com', 'alteore.com'];

/* ── Dates ─────────────────────────────────────────────────────────────── */
function toMs(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v.toMillis === 'function') return v.toMillis();
  const t = Date.parse(v);
  return isNaN(t) ? 0 : t;
}
function frParis(ms) {
  return new Date(ms).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
}

/* ── Gmail API ─────────────────────────────────────────────────────────── */
function gmailClient(accountKey) {
  let token = null, tokens = null, oauth = null;
  async function call(path) {
    if (!tokens) {
      tokens = await loadAccountTokens(accountKey);
      token = tokens.accessToken;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!token) {
        oauth = oauth || await loadOauthConfig();
        token = await refreshAccessToken(accountKey, tokens.refreshToken, oauth, {
          email: tokens.email, lastSuccessAt: tokens.lastSuccessAt,
        });
      }
      const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/' + path, {
        headers: { Authorization: 'Bearer ' + token },
      });
      if (r.status === 401 && attempt === 0) { token = null; continue; }
      const j = await r.json().catch(function () { return {}; });
      if (!r.ok) {
        const msg = (j && j.error && j.error.message) || ('HTTP ' + r.status);
        if (r.status === 403 && /scope|insufficient/i.test(msg)) {
          throw new Error('La boîte ' + accountKey + ' n\'a pas le droit de lecture Gmail : la reconnecter depuis Admin → Connexion Email (' + msg + ')');
        }
        throw new Error('Gmail ' + r.status + ' : ' + msg);
      }
      return j;
    }
    throw new Error('Gmail : accès refusé après rafraîchissement du jeton');
  }
  return { call: call, email: function () { return tokens && tokens.email; } };
}

async function listIds(gm, sinceMs) {
  const q = 'in:inbox -from:me -category:promotions -category:social -category:forums after:' + Math.floor(sinceMs / 1000);
  const ids = [];
  let pageToken = '';
  while (ids.length < MAX_LIST) {
    const j = await gm.call('messages?maxResults=100&q=' + encodeURIComponent(q) + (pageToken ? '&pageToken=' + pageToken : ''));
    (j.messages || []).forEach(function (m) { ids.push(m.id); });
    if (!j.nextPageToken) break;
    pageToken = j.nextPageToken;
  }
  return ids;
}

/* ── Lecture d'un message ──────────────────────────────────────────────── */
function headerMap(payload) {
  const h = {};
  ((payload && payload.headers) || []).forEach(function (x) {
    const k = String(x.name || '').toLowerCase();
    if (!(k in h)) h[k] = String(x.value || '');
  });
  return h;
}
function decodePart(part) {
  const data = part && part.body && part.body.data;
  if (!data) return '';
  const buf = Buffer.from(String(data).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const ct = headerMap(part)['content-type'] || part.mimeType || '';
  const m = /charset="?([^";\s]+)/i.exec(ct);
  const cs = (m ? m[1] : 'utf-8').toLowerCase();
  try { return new TextDecoder(cs === 'us-ascii' ? 'utf-8' : cs).decode(buf); } catch (e) { return buf.toString('utf8'); }
}
function walk(part, out) {
  if (!part) return;
  const mt = String(part.mimeType || '').toLowerCase();
  const disp = (headerMap(part)['content-disposition'] || '').toLowerCase();
  if (disp.indexOf('attachment') === 0) { out.attachments++; return; }
  if (mt === 'text/plain' && !out.plain) out.plain = decodePart(part);
  else if (mt === 'text/html' && !out.html) out.html = decodePart(part);
  else if (mt === 'text/calendar') out.calendar = true;
  else if (mt === 'multipart/report' || mt === 'message/delivery-status') out.report = true;
  else if (part.filename) out.attachments++;
  (part.parts || []).forEach(function (p) { walk(p, out); });
}
function htmlToText(html) {
  return String(html || '')
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<blockquote[\s\S]*$/i, '')          // citation Gmail / Apple Mail
    .replace(/<div class="gmail_quote[\s\S]*$/i, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, '\'').replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(+n); });
}

/* Retire la citation de notre e-mail, la signature mobile, et normalise. */
function stripQuote(text) {
  let t = String(text || '').replace(/\r\n?/g, '\n');
  const cuts = [
    /\n[ \t]*(Le|On)\s[^\n]{0,250}?(\n[^\n]{0,120})?\s(a\s+écrit|wrote)\s*:/i,
    /\n[ \t]*-{2,}\s*(Original Message|Message d'origine|Forwarded message|Message transféré)/i,
    /\n[ \t]*_{10,}/,
    /\n[ \t]*(De|From)\s*:[^\n]*\n[ \t]*(Envoyé|Sent|Date|À|To|Objet|Subject)\s*:/i,
    /\n-- ?\n/,
  ];
  cuts.forEach(function (re) {
    const m = re.exec('\n' + t);
    if (m) t = t.slice(0, Math.max(0, m.index - 1));
  });
  t = t.split('\n')
    .filter(function (l) { return !/^\s*>/.test(l); })
    .filter(function (l) { return !/^\s*(Envoyé de mon|Sent from my|Télécharger Outlook|Get Outlook for)\b/i.test(l); })
    .join('\n');
  return t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function parseAddress(raw) {
  const s = String(raw || '');
  const m = /<([^>]+)>/.exec(s);
  const email = (m ? m[1] : s).trim().replace(/^"|"$/g, '').toLowerCase();
  const name = m ? s.slice(0, m.index).trim().replace(/^"|"$/g, '') : '';
  return { email: email, name: name };
}
function addressList(raw) {
  return String(raw || '').split(',').map(parseAddress).filter(function (a) { return a.email.indexOf('@') > 0; });
}
function isOurs(email, accountEmail) {
  const e = String(email || '').toLowerCase();
  if (accountEmail && e === String(accountEmail).toLowerCase()) return true;
  return OUR_DOMAINS.some(function (d) { return e.slice(-(d.length + 1)) === '@' + d; });
}

/* ── Filtre « humain uniquement » ──────────────────────────────────────── */
const ROBOT_LOCAL = /^(no[-_.]?reply|noreply|do[-_.]?not[-_.]?reply|donotreply|ne[-_.]?pas[-_.]?repondre|nepasrepondre|mailer[-_.]?daemon|postmaster|bounces?|notifications?|notify|alerts?|newsletters?|news|marketing|automated|automail|robot|daemon|calendar[-_.]?notification|invitations?)([-_.+].*)?$/i;
const ROBOT_DOMAINS = ['calendly.com', 'facebookmail.com', 'linkedin.com', 'gocardless.com', 'qonto.com', 'stripe.com', 'zoom.us', 'ringover.com', 'twilio.com', 'make.com', 'google.com', 'mailchimp.com', 'sendinblue.com', 'brevo.com', 'hubspot.com'];
const AUTO_SUBJECT = /^\s*(r[ée]ponse automatique|automatic reply|auto[- ]?reply|autoreply|auto[- ]?response|out of (the )?office|je suis absent|message d'absence|absence du bureau|undeliverable|undelivered|delivery status notification|mail delivery (failed|subsystem)|returned mail|non remis|message non remis|accus[ée] de r[ée]ception|read ?:|lu ?:|invitation (accept[ée]e|refus[ée]e|mise à jour)|updated invitation|accepted ?:|accept[ée]e? ?:|declined ?:|refus[ée]e? ?:|tentatively accepted|provisoirement accept[ée]e?)/i;
const AUTO_BODY = /(je suis (actuellement )?(absent|en cong[ée]s|en d[ée]placement)|i am (currently )?(out of (the )?office|away)|ceci est une r[ée]ponse automatique|r[ée]ponse automatique|this is an auto(mated|matic) (reply|message|response)|message (g[ée]n[ée]r[ée] )?automatique|merci de ne pas r[ée]pondre|please do not reply)/i;

function robotReason(h, labels, from, subject, parts) {
  const L = labels || [];
  if (L.indexOf('SPAM') >= 0 || L.indexOf('TRASH') >= 0) return 'spam';
  if (L.indexOf('SENT') >= 0 || L.indexOf('DRAFT') >= 0) return 'envoye_par_nous';
  if (['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS'].some(function (c) { return L.indexOf(c) >= 0; })) return 'categorie_gmail';
  const local = from.email.split('@')[0] || '';
  const domain = from.email.split('@')[1] || '';
  if (ROBOT_LOCAL.test(local)) return 'adresse_robot';
  if (ROBOT_DOMAINS.some(function (d) { return domain === d || domain.slice(-(d.length + 1)) === '.' + d; })) return 'plateforme';
  const auto = String(h['auto-submitted'] || '').trim().toLowerCase();
  if (auto && auto !== 'no') return 'auto_submitted';
  if (h['x-autoreply'] || h['x-autorespond'] || h['x-autoresponder'] || h['x-failed-recipients']) return 'auto_reply';
  if (/^(bulk|junk|list|auto_reply)$/i.test(String(h['precedence'] || '').trim())) return 'precedence';
  if (h['list-id'] || h['list-unsubscribe']) return 'liste_diffusion';
  if (String(h['return-path'] || '').trim() === '<>') return 'non_remis';
  if (/multipart\/report/i.test(h['content-type'] || '') || parts.report) return 'non_remis';
  if (parts.calendar) return 'invitation_agenda';
  if (AUTO_SUBJECT.test(subject)) return 'objet_automatique';
  return null;
}

/* ── Équipe, propriétaires ─────────────────────────────────────────────── */
async function teamMembers() {
  try {
    const s = await db.collection('_meta').doc('team_members').get();
    const raw = s.exists ? (s.data() || {}).members : null;
    if (Array.isArray(raw)) return raw.filter(Boolean);
    return Object.keys(raw || {}).map(function (k) { return Object.assign({ slug: k }, raw[k]); });
  } catch (e) { return []; }
}
function isActive(m) { return m && m.active !== false && !m.archivedAt && !DEPARTED[m.slug]; }
function isSalesMember(m) { return m && !/coach|csm/i.test(String(m.role || '')); }

// Closeur du RDV le plus récent — même ordre que team-pilotage.js bookingCloser.
async function closerOf(leadId, members) {
  const s = await db.collection('bookings').where('leadId', '==', leadId).limit(20).get().catch(function () { return null; });
  if (!s || s.empty) return null;
  const bs = [];
  s.forEach(function (d) {
    const b = d.data() || {};
    if (b.status === 'cancelled' || b.status === 'replanifie') return;
    bs.push(b);
  });
  bs.sort(function (a, b) { return (String(b.date || '') + String(b.time || '')).localeCompare(String(a.date || '') + String(a.time || '')); });
  const b = bs[0];
  if (!b) return null;
  const bySlug = function (sl) { return sl ? members.find(function (m) { return m && m.slug === sl; }) : null; };
  const cd = b.closeData || {};
  let m = bySlug(cd.closerSlug) || bySlug(b.expertSlug);
  if (!m && b.personId) {
    const p = await db.collection('booking_config').doc(String(b.personId)).get().catch(function () { return null; });
    const uid = p && p.exists ? (p.data() || {}).firebaseUid : null;
    if (uid) m = members.find(function (x) { return x && String(x.firebaseUid || '') === String(uid); });
    if (!m) m = bySlug(b.personId);
  }
  return m && isActive(m) && isSalesMember(m) && m.firebaseUid ? m : null;
}

/* ── Rattachement à une fiche ──────────────────────────────────────────── */
async function leadForMessage(gm, msg, from, accountEmail) {
  const direct = await findLeadDoc(null, from.email, null);
  if (direct) return { doc: direct, via: 'expediteur' };
  // Réponse d'une autre adresse dans un fil où l'on avait écrit à un prospect.
  if (!msg.threadId) return null;
  const th = await gm.call('threads/' + msg.threadId + '?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc');
  const seen = {};
  for (const m of (th.messages || [])) {
    if (m.id === msg.id) continue;
    const h = headerMap(m.payload);
    if (!isOurs(parseAddress(h['from']).email, accountEmail)) continue;
    for (const a of addressList(h['to']).concat(addressList(h['cc']))) {
      if (seen[a.email] || isOurs(a.email, accountEmail)) continue;
      seen[a.email] = 1;
      const d = await findLeadDoc(null, a.email, null);
      if (d) return { doc: d, via: 'fil' };
    }
  }
  return null;
}

/* ── Passe ─────────────────────────────────────────────────────────────── */
async function run(opts) {
  const dry = !!(opts && opts.dryRun);
  const startedAt = Date.now();
  const cfgRef = db.collection('_config').doc(CFG_DOC);
  const cfgSnap = await cfgRef.get();
  const cfg = cfgSnap.exists ? (cfgSnap.data() || {}) : {};
  if (cfg.enabled !== true && !dry) return { skipped: 'disabled' };

  const accountKey = cfg.account || DEFAULT_ACCOUNT;
  const lookbackDays = Number(cfg.lookbackDays) > 0 ? Number(cfg.lookbackDays) : DEFAULT_LOOKBACK_DAYS;
  const firstRun = !toMs(cfg.lastSyncMs);
  const sinceMs = firstRun ? startedAt - lookbackDays * 86400000 : toMs(cfg.lastSyncMs) - OVERLAP_MS;

  const gm = gmailClient(accountKey);
  let ids;
  try {
    ids = await listIds(gm, sinceMs);
  } catch (e) {
    if (!dry) await cfgRef.set({ lastError: e.message, lastErrorAt: new Date() }, { merge: true });
    throw e;
  }
  const accountEmail = gm.email() || (accountKey + '@adrienemily.com');

  // Anti-doublon : messages déjà traités.
  const known = {};
  for (let i = 0; i < ids.length; i += 200) {
    const refs = ids.slice(i, i + 200).map(function (id) { return db.collection('email_inbound').doc(id); });
    if (!refs.length) continue;
    const snaps = await db.getAll.apply(db, refs);
    snaps.forEach(function (s) { if (s.exists) known[s.id] = 1; });
  }
  const todo = ids.filter(function (id) { return !known[id]; });
  const batch = todo.slice(0, MAX_PER_RUN);
  const members = await teamMembers();

  const attached = [], rejected = [], errors = [];
  for (const id of batch) {
    try {
      const msg = await gm.call('messages/' + id + '?format=full');
      const h = headerMap(msg.payload);
      const from = parseAddress(h['from']);
      const subject = String(h['subject'] || '').trim();
      const atMs = Number(msg.internalDate) || startedAt;
      const parts = { plain: '', html: '', attachments: 0, calendar: false, report: false };
      walk(msg.payload, parts);
      const trace = {
        account: accountKey, from: from.email, fromName: from.name || null, subject: subject.slice(0, 300),
        receivedAt: new Date(atMs), threadId: msg.threadId || null, processedAt: new Date(),
      };

      let reason = isOurs(from.email, accountEmail) ? 'nos_adresses' : robotReason(h, msg.labelIds, from, subject, parts);
      if (!reason && await estBloque({ email: from.email })) reason = 'blacklist';
      let text = '';
      if (!reason) {
        text = stripQuote(parts.plain || htmlToText(parts.html));
        if (AUTO_BODY.test(text.slice(0, 500))) reason = 'texte_automatique';
        else if (!text && !parts.attachments) reason = 'vide';
      }
      let found = null;
      if (!reason) {
        found = await leadForMessage(gm, msg, from, accountEmail);
        if (!found) reason = 'expediteur_inconnu';
      }
      if (reason) {
        rejected.push({ id: id, from: from.email, subject: subject.slice(0, 80), reason: reason });
        if (!dry) await db.collection('email_inbound').doc(id).set(Object.assign({ status: 'ignored', reason: reason }, trace));
        continue;
      }

      const leadId = found.doc.id;
      const l = found.doc.data() || {};
      const nom = l.nom || l.fullName || [l.prenom, l.nomFamille].filter(Boolean).join(' ') || from.name || from.email;
      const notify = !firstRun && (startedAt - atMs) < NOTIFY_MAX_AGE_MS;
      const content = (text || '(pièce jointe sans texte)').slice(0, CONTENT_MAX) +
        (parts.attachments ? '\n\n📎 ' + parts.attachments + ' pièce' + (parts.attachments > 1 ? 's jointes' : ' jointe') + ' (voir la boîte ' + accountEmail + ')' : '');
      attached.push({ id: id, leadId: leadId, nom: nom, from: from.email, via: found.via, subject: subject.slice(0, 80), popup: notify, apercu: content.slice(0, 160) });
      if (dry) continue;

      // Écrit d'abord sur la fiche (sauf si un passage interrompu l'a déjà fait).
      const already = (Array.isArray(l.communications) ? l.communications : []).some(function (c) { return c && c.gmailMessageId === id; });
      if (!already) {
        const iso = new Date(atMs).toISOString();
        const upd = {
          communications: admin.firestore.FieldValue.arrayUnion({
            type: 'email', direction: 'inbound', subject: subject || '(sans objet)', content: content,
            emailFrom: from.email, emailFromName: from.name || null, emailTo: accountEmail,
            source: 'gmail-' + accountKey, date: iso, createdAt: iso,
            gmailMessageId: id, gmailThreadId: msg.threadId || null,
          }),
          timeline_history: admin.firestore.FieldValue.arrayUnion({
            text: '✉️ E-mail reçu — ' + (subject || '(sans objet)').slice(0, 100) + (found.via === 'fil' ? ' [de ' + from.email + ']' : ''),
            date: frParis(atMs), color: '#60a5fa',
          }),
        };
        if (notify) {
          upd.lastContactAt = new Date(atMs);
          upd.lastContactType = 'email';
          upd.updatedAt = admin.firestore.FieldValue.serverTimestamp();
        }
        await found.doc.ref.update(upd);
      }

      if (notify) {
        const owner = l.assignedTo ? members.find(function (m) { return m && m.slug === l.assignedTo; }) : null;
        const ownerOk = owner && isActive(owner) && owner.firebaseUid ? owner : null;
        const closer = await closerOf(leadId, members);
        const base = {
          type: 'email', direction: 'inbound',
          leadId: leadId, leadName: nom,
          fromEmail: from.email, fromNumber: null, toNumber: null,
          subject: subject.slice(0, 200) || null,
          preview: ((subject ? subject + ' — ' : '') + text.replace(/\s+/g, ' ')).slice(0, 200),
          deepLinkUrl: 'sales-leads.html?leadId=' + encodeURIComponent(leadId),
          source: 'gmail', providerMessageSid: id,
          readBy: {}, createdAt: new Date(atMs),
        };
        await db.collection('inbox_notifications').doc('mail_' + id).set(Object.assign({}, base, {
          ownerUid: ownerOk ? String(ownerOk.firebaseUid) : null, ownerSlug: l.assignedTo || null,
        }), { merge: true });
        if (closer && (!ownerOk || String(closer.firebaseUid) !== String(ownerOk.firebaseUid))) {
          // Copie pour le closer : invisible des admins (déjà l'original) et
          // ignorée par la veille sans réponse (un seul message compté).
          await db.collection('inbox_notifications').doc('mail_' + id + '_closer').set(Object.assign({}, base, {
            ownerUid: String(closer.firebaseUid), ownerSlug: closer.slug || null, copyOf: 'mail_' + id,
          }), { merge: true });
        }
      }
      await db.collection('email_inbound').doc(id).set(Object.assign({
        status: 'attached', leadId: leadId, via: found.via, notified: notify,
      }, trace));
    } catch (e) {
      console.warn('[gmail-inbound-sync] message', id, e.message);
      errors.push({ id: id, error: e.message });
    }
  }

  const complete = todo.length <= MAX_PER_RUN && ids.length < MAX_LIST && !errors.length;
  if (!dry) {
    const upd = { lastRunAt: new Date(), lastError: errors.length ? errors[0].error : null };
    if (complete) upd.lastSyncMs = startedAt;
    await cfgRef.set(upd, { merge: true });
  }
  return {
    dryRun: dry, compte: accountEmail, premierPassage: firstRun, depuis: new Date(sinceMs).toISOString(),
    trouves: ids.length, dejaTraites: ids.length - todo.length, traites: batch.length, reste: todo.length - batch.length,
    rattaches: attached.length, ecartes: rejected.length, erreurs: errors,
    detailRattaches: attached, detailEcartes: rejected,
  };
}

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') {
    const secret = process.env.CRON_SECRET;
    const authHeader = req.headers['authorization'] || '';
    if (!secret || (authHeader !== 'Bearer ' + secret && req.headers['x-api-key'] !== secret)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try { res.status(200).json(Object.assign({ ok: true }, await run({}))); } catch (e) { console.error('[gmail-inbound-sync]', e); res.status(200).json({ ok: false, error: e.message }); }
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const body = parseBody(req) || {};
  try {
    const out = await run({ dryRun: body.action !== 'run' || body.dryRun === true });
    res.status(200).json(Object.assign({ ok: true }, out));
  } catch (e) {
    console.error('[gmail-inbound-sync]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
};
