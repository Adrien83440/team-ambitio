// ============================================================================
// api/_activeCampaign.js — CLIENT ACTIVECAMPAIGN DIRECT (24/11/2026)
// ----------------------------------------------------------------------------
// Demande d'Adrien du 24/11/2026 : Team parle directement à ActiveCampaign,
// sans scénario Make au milieu. API v3.
//
// Identifiants : variables Vercel ACTIVECAMPAIGN_API_URL (ex.
// https://ambitiocorp.api-us1.com) et ACTIVECAMPAIGN_API_KEY (AC → Réglages →
// Développeur). Jamais dans le dépôt ni dans Firestore.
//
// Les tags sont désignés par leur NOM et résolus en identifiant au premier
// usage (cache du module) : renommer un tag dans AC casse l'appel de façon
// lisible (`tag_introuvable:<nom>`) au lieu d'agir sur le mauvais tag.
// Aucune fonction ne lance : chacune renvoie { ok, erreur }.
// ============================================================================
'use strict';

const _tags = {};

function conf() {
  const url = String(process.env.ACTIVECAMPAIGN_API_URL || 'https://ambitiocorp.api-us1.com').replace(/\/+$/, '');
  const key = String(process.env.ACTIVECAMPAIGN_API_KEY || '');
  return { url: url, key: key };
}

async function appel(methode, chemin, corps) {
  const c = conf();
  if (!c.key) return { ok: false, status: 0, erreur: 'ACTIVECAMPAIGN_API_KEY_absente' };
  try {
    const r = await fetch(c.url + '/api/3' + chemin, {
      method: methode,
      headers: { 'Api-Token': c.key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: corps ? JSON.stringify(corps) : undefined,
      // Jamais d'attente sans fin : le passage du parcours n'a que 60 s.
      signal: AbortSignal.timeout(12000),
    });
    let data = null;
    try { data = await r.json(); } catch (_) { data = null; }
    if (!r.ok) return { ok: false, status: r.status, data: data, erreur: 'ac_http_' + r.status };
    return { ok: true, status: r.status, data: data };
  } catch (e) {
    return { ok: false, status: 0, erreur: (e && e.message) || 'ac_reseau' };
  }
}

async function idTag(nom) {
  if (_tags[nom]) return _tags[nom];
  const r = await appel('GET', '/tags?search=' + encodeURIComponent(nom) + '&limit=100');
  if (!r.ok) return null;
  const t = ((r.data && r.data.tags) || []).find(function (x) { return x && x.tag === nom; });
  if (t) _tags[nom] = String(t.id);
  return t ? String(t.id) : null;
}

/* Contact par e-mail ; créé s'il n'existe pas (contact/sync ne touche pas
   aux autres champs d'un contact existant quand on n'envoie que l'e-mail). */
async function contact(email, extra) {
  const em = String(email || '').trim().toLowerCase();
  if (!em || !/@/.test(em)) return { ok: false, erreur: 'email_absent' };
  const g = await appel('GET', '/contacts?email=' + encodeURIComponent(em));
  if (!g.ok) return g;
  const c = ((g.data && g.data.contacts) || [])[0];
  if (c) return { ok: true, id: String(c.id), cree: false };
  const corps = { contact: Object.assign({ email: em }, extra || {}) };
  const s = await appel('POST', '/contact/sync', corps);
  if (!s.ok) return s;
  return { ok: true, id: String(s.data && s.data.contact && s.data.contact.id), cree: true };
}

async function ajouterTag(contactId, nom, opts) {
  let tid = await idTag(nom);
  // Étiquette d'information absente : créée à la demande (opts.creer).
  if (!tid && opts && opts.creer) {
    const c = await appel('POST', '/tags', { tag: { tag: nom, tagType: 'contact', description: 'Team (parcours RDV) : étiquette d\'information, ne déclenche rien.' } });
    if (c.ok && c.data && c.data.tag) { tid = String(c.data.tag.id); _tags[nom] = tid; }
  }
  if (!tid) return { ok: false, erreur: 'tag_introuvable:' + nom };
  const r = await appel('POST', '/contactTags', { contactTag: { contact: String(contactId), tag: tid } });
  return r.ok ? { ok: true } : r;
}

async function retirerTag(contactId, nom) {
  const tid = await idTag(nom);
  if (!tid) return { ok: false, erreur: 'tag_introuvable:' + nom };
  const l = await appel('GET', '/contacts/' + encodeURIComponent(contactId) + '/contactTags?limit=100');
  if (!l.ok) return l;
  const liens = ((l.data && l.data.contactTags) || []).filter(function (x) { return String(x.tag) === tid; });
  for (let i = 0; i < liens.length; i++) {
    const d = await appel('DELETE', '/contactTags/' + encodeURIComponent(liens[i].id));
    if (!d.ok && d.status !== 404) return d;
  }
  return { ok: true, retires: liens.length };
}

/* Sort le contact des automatisations listées (runs en cours seulement). */
async function sortirDesAutomatisations(contactId, ids) {
  const voulu = (ids || []).map(String);
  if (!voulu.length) return { ok: true, sortis: [] };
  const l = await appel('GET', '/contacts/' + encodeURIComponent(contactId) + '/contactAutomations?limit=100');
  if (!l.ok) return l;
  const runs = ((l.data && l.data.contactAutomations) || []).filter(function (x) {
    return voulu.indexOf(String(x.automation)) >= 0 && String(x.status) === '1';
  });
  const sortis = [];
  for (let i = 0; i < runs.length; i++) {
    const d = await appel('DELETE', '/contactAutomations/' + encodeURIComponent(runs[i].id));
    if (!d.ok && d.status !== 404) return d;
    sortis.push(String(runs[i].automation));
  }
  return { ok: true, sortis: sortis };
}

/* Fait entrer le contact dans une automatisation (la newsletter, à la fin
   d'une séquence d'après-RDV). Rien s'il y a déjà une entrée EN COURS. */
async function entrerAutomatisation(contactId, automationId) {
  const id = String(automationId || '');
  if (!id) return { ok: false, erreur: 'automatisation_absente' };
  const l = await appel('GET', '/contacts/' + encodeURIComponent(contactId) + '/contactAutomations?limit=100');
  if (!l.ok) return l;
  const enCours = ((l.data && l.data.contactAutomations) || []).some(function (x) { return String(x.automation) === id && String(x.status) === '1'; });
  if (enCours) return { ok: true, deja: true };
  const r = await appel('POST', '/contactAutomations', { contactAutomation: { contact: String(contactId), automation: id } });
  return r.ok ? { ok: true } : r;
}

/* Désinscription complète : statut « désinscrit » sur chaque liste où le
   contact est abonné (les automatisations et campagnes ne l'atteignent plus). */
async function desinscrire(contactId) {
  const l = await appel('GET', '/contacts/' + encodeURIComponent(contactId) + '/contactLists?limit=100');
  if (!l.ok) return l;
  const abonne = ((l.data && l.data.contactLists) || []).filter(function (x) { return String(x.status) === '1'; });
  let n = 0;
  for (let i = 0; i < abonne.length; i++) {
    const r = await appel('POST', '/contactLists', { contactList: { list: String(abonne[i].list), contact: String(contactId), status: 2 } });
    if (!r.ok) return Object.assign({ listes: n }, r);
    n++;
  }
  return { ok: true, listes: n };
}

module.exports = { entrerAutomatisation: entrerAutomatisation, desinscrire: desinscrire, appel: appel, idTag: idTag, contact: contact, ajouterTag: ajouterTag, retirerTag: retirerTag, sortirDesAutomatisations: sortirDesAutomatisations, conf: conf };
