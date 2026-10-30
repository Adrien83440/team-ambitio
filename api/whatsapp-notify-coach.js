// ============================================================================
// api/whatsapp-notify-coach.js — NOTIFIER LE COACH DE SON ATTRIBUTION
// ----------------------------------------------------------------------------
// POST /api/whatsapp-notify-coach
//   { clientId | leadId, coachId?, coachNom?, programme?, force? }
//   → 200 { ok, envoye, wamid, coach:{slug,nom,numero}, raison }
//
// DEUX POINTS D'ENTRÉE, UNE SEULE NOTIFICATION
// --------------------------------------------
// `clientId` vise une fiche `clients` — le chemin historique, depuis le plan
// d'action. `leadId` vise une fiche `leads` : c'est celui du parcours de close,
// où le coach est choisi AVANT que la fiche client n'existe. Sans lui, la carte
// coach du wizard écrirait dans le vide, puisque rien ne crée de document
// `clients` au moment du close.
//
// La trace anti-rejeu est posée sur le document d'origine, quel qu'il soit :
// deux enregistrements de suite ne produisent jamais deux messages.
//
// POURQUOI
// --------
// Jusqu'ici l'attribution d'un coach était orale : la closeuse demandait un nom
// dans le groupe interne, et le coach découvrait son client en ouvrant Alteore
// — ou ne le découvrait pas. Ce message ferme la boucle au moment exact où le
// coach est choisi dans le plan d'action.
//
// LE PONT ENTRE DEUX RÉFÉRENTIELS
// -------------------------------
// Le sélecteur du plan d'action lit `booking_config` (docs `__type === 'person'`)
// et n'en tire qu'un identifiant et un nom : AUCUN numéro de téléphone.
// Les numéros vivent ailleurs, dans `_meta/team_members`, champ `ringoverPhones`
// (Admin → Utilisateurs). Les deux référentiels ne partagent pas leurs clés :
// on les rapproche donc par le nom, en plusieurs passes, du plus sûr au plus
// permissif. Si aucune passe n'aboutit, on n'envoie RIEN et on le dit — deviner
// un destinataire serait pire que ne pas notifier.
//
// ⚠️ Un numéro Ringover n'est pas nécessairement un compte WhatsApp. Si le
// coach n'est pas sur WhatsApp, Meta répond une erreur explicite (131026) que
// le journal conserve. C'est visible, donc corrigeable.
// ============================================================================

const { verifyFirebaseAuth } = require('./_verifyFirebaseAuth');
const { notifierCoach } = require('./_coachNotify');
const parseBody = require('./_parseBody');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }

  /* Réservé à l'équipe connectée : ce endpoint écrit à un salarié. */
  let par = null;
  try {
    const auth = await verifyFirebaseAuth(req);
    par = (auth && auth.email) || 'equipe';
  } catch (e) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  const body = parseBody(req) || {};
  const clientId = String(body.clientId || '').trim();
  const leadId = String(body.leadId || '').trim();
  const coachId = String(body.coachId || '').trim();
  const coachNom = String(body.coachNom || '').trim();
  const programme = String(body.programme || '').trim();
  const force = body.force === true;
  if (!clientId && !leadId) {
    res.status(400).json({ ok: false, error: 'clientId_or_leadId_required' });
    return;
  }

  try {
    const r = await notifierCoach({ clientId, leadId, coachId, coachNom, programme, force, par });
    res.status(r.status).json(r.body);
  } catch (e) {
    console.error('[whatsapp-notify-coach]', e && e.stack ? e.stack : e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
