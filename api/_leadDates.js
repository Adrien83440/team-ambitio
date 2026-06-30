// ============================================================================
// api/_leadDates.js
// ----------------------------------------------------------------------------
// Helpers de dates "réelles" d'un lead, partagés par lead-optin.js et
// alteoform-submit.js pour DATER CORRECTEMENT les entrées engagementHistory[].
//
// Contexte : pour les leads importés de Bigin, `createdAt` = date du run
// d'import (serverTimestamp), PAS la vraie date d'entrée. La vraie date vit
// dans `importedCreatedAt` (création Bigin, ex "2025-09-23 23:43:43") et/ou
// `dateWebinaire` (ex "dimanche, 1 juin 2025"). Quand on archive un passage
// dans engagementHistory[], on tamponnait `archivedAt = now` → la timeline
// affichait la date d'archivage au lieu de la date réelle du passage.
//
// Décision Adrien : "date d'entrée réelle" = la PLUS ANCIENNE parmi
// dateWebinaire / importedCreatedAt / createdAt.
// ============================================================================

// Parse une date "souple" → millis epoch (ou null).
// Gère : Timestamp Admin ({toMillis}/{seconds}), number (s ou ms), ISO
// "YYYY-MM-DD[ HH:MM:SS]", et le format FR long "dimanche, 1 juin 2025".
function parseFlexMs(v) {
  if (v == null) return null;
  if (typeof v === 'object') {
    if (typeof v.toMillis === 'function') { try { return v.toMillis(); } catch (e) { return null; } }
    if (typeof v.seconds === 'number') return v.seconds * 1000 + (v.nanoseconds ? Math.floor(v.nanoseconds / 1e6) : 0);
    if (typeof v._seconds === 'number') return v._seconds * 1000 + (v._nanoseconds ? Math.floor(v._nanoseconds / 1e6) : 0);
    return null;
  }
  if (typeof v === 'number' && isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v !== 'string') return null;
  var s = v.trim();
  if (!s) return null;

  // ISO-ish "2025-09-23" / "2025-09-23 23:43:43" / "2025-09-23T23:43:43Z"
  var iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (iso) {
    var d = new Date(+iso[1], +iso[2] - 1, +iso[3], +(iso[4] || 0), +(iso[5] || 0), +(iso[6] || 0));
    return isNaN(d.getTime()) ? null : d.getTime();
  }

  // FR long "dimanche, 1 juin 2025" / "1 juin 2025" / "14 sept 2025"
  var fr = s.match(/(\d{1,2})\s+([A-Za-zàâäéèêëïîôöûüç]+)\.?\s+(\d{4})/);
  if (fr) {
    var table = [['janv', 0], ['févr', 1], ['fevr', 1], ['mars', 2], ['avri', 3], ['mai', 4],
                 ['juin', 5], ['juil', 6], ['aout', 7], ['août', 7], ['sept', 8],
                 ['octo', 9], ['nove', 10], ['déce', 11], ['dece', 11]];
    var mn = fr[2].toLowerCase();
    var idx = -1;
    for (var i = 0; i < table.length; i++) { if (mn.indexOf(table[i][0]) === 0) { idx = table[i][1]; break; } }
    if (idx >= 0) {
      var d2 = new Date(+fr[3], idx, +fr[1]);
      return isNaN(d2.getTime()) ? null : d2.getTime();
    }
  }

  var p = Date.parse(s);
  return isNaN(p) ? null : p;
}

function minDef() {
  var best = null;
  for (var i = 0; i < arguments.length; i++) { var m = arguments[i]; if (m != null && (best == null || m < best)) best = m; }
  return best;
}
function maxDef() {
  var best = null;
  for (var i = 0; i < arguments.length; i++) { var m = arguments[i]; if (m != null && (best == null || m > best)) best = m; }
  return best;
}

// Vraie date d'entrée d'un lead = la PLUS ANCIENNE parmi webinaire /
// création Bigin / createdAt. createdAt (= date d'import pour les leads
// Bigin) est plus récent que les deux autres quand ils existent, donc le
// `min` le laisse naturellement de côté ; il ne sert que de filet pour les
// leads organiques sans dateWebinaire ni importedCreatedAt.
function realEntryMs(d) {
  if (!d) return null;
  return minDef(parseFlexMs(d.dateWebinaire), parseFlexMs(d.importedCreatedAt), parseFlexMs(d.createdAt));
}

// Date de DÉBUT du passage qu'on s'apprête à archiver :
//  - s'il existe déjà un ré-engagement antérieur (lastOptinAt/lastBookingAt),
//    le passage archivé a commencé à cette date ;
//  - sinon c'est le passage d'origine → vraie date d'entrée du lead.
// Retourne une ISO string (cohérent avec archivedAt).
function passageStartIso(prev) {
  if (!prev) return new Date().toISOString();
  var recent = maxDef(parseFlexMs(prev.lastOptinAt), parseFlexMs(prev.lastBookingAt));
  var ms = recent != null ? recent : realEntryMs(prev);
  if (ms == null) ms = Date.now();
  try { return new Date(ms).toISOString(); } catch (e) { return new Date().toISOString(); }
}

module.exports = { parseFlexMs, realEntryMs, passageStartIso };
