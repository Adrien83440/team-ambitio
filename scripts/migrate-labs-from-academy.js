// ============================================================================
// scripts/migrate-labs-from-academy.js — RAPATRIEMENT DES LABs D'ÉQUIPE
// ----------------------------------------------------------------------------
// Copie les formations internes d'AE Academy (projet Firebase
// `adrienemily-academy`, collection `courses`, documents `team: true`) vers
// team.alteore.com (projet `ambitio-team`, collection `formations`).
//
// Le modèle est le même des deux côtés (un document par formation, tout
// l'arbre modules → sous-modules → leçons embarqué), donc la copie est
// quasi littérale. Ce qui change :
//   • l'id devient un slug fixe : Setting LAB → setting-lab,
//     Closing LAB → closing-lab, Coachs LAB → coach-lab (sinon slug du nom) ;
//   • on retire ce qui n'a pas d'équivalent ici : bâtiment 3D, victoires,
//     copilote, route, thème, jalons, mini-apps (`lesson.app`), drip ;
//   • le statut est normalisé : Academy stocke « pub » (ancien format) ou
//     « published », et considère tout ce qui n'est pas « draft » comme publié —
//     on écrit « published » dans ces deux cas ;
//   • l'apparence (`theme` : bannière, texte d'accueil, widgets latéraux —
//     facture de fin de mois, identifiants, point hebdo…) est copiée telle
//     quelle, ainsi que le `tag` (« Pôle Closeur ») en `hint` ;
//   • les ids internes (modules, leçons) sont CONSERVÉS ;
//   • les URLs de médias (Drive, Storage d'Academy) restent telles quelles :
//     elles fonctionnent depuis n'importe quel domaine.
// La progression des membres n'est pas migrée (repart à zéro).
//
// AUCUNE SUPPRESSION : si la formation existe déjà côté Team, le script
// refuse d'écrire sans --overwrite, et avec --overwrite il archive d'abord
// l'ancien document dans formations/{id}/history/{timestamp}. Chaque
// exécution réelle laisse une trace dans audit_log.
//
// USAGE
//   export ACADEMY_SA_KEY=~/.secrets/adrienemily-academy-sa.json
//   export TEAM_SA_KEY=~/.secrets/ambitio-team-sa.json
//   node scripts/migrate-labs-from-academy.js               # lecture seule (défaut)
//   node scripts/migrate-labs-from-academy.js --execute     # écrit, après validation
//   node scripts/migrate-labs-from-academy.js --execute --overwrite   # remplace l'existant
//   node scripts/migrate-labs-from-academy.js --only=closing-lab      # une seule
//   node scripts/migrate-labs-from-academy.js --publish     # arrive publiée (défaut : brouillon)
//   node scripts/migrate-labs-from-academy.js --execute --theme-only
//       met à jour UNIQUEMENT l'apparence (bannière, accueil, widgets) des
//       formations déjà migrées, sans toucher aux modules ni au statut
//
// Les clés de service account restent hors du repo.
// ============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const admin = require('firebase-admin');

const EXECUTE   = process.argv.indexOf('--execute') >= 0;
const OVERWRITE = process.argv.indexOf('--overwrite') >= 0;
const PUBLISH   = process.argv.indexOf('--publish') >= 0;
const THEME_ONLY = process.argv.indexOf('--theme-only') >= 0;
const ONLY      = (process.argv.find((a) => a.indexOf('--only=') === 0) || '').slice(7);

function expand(p) { return p && p[0] === '~' ? path.join(os.homedir(), p.slice(1)) : p; }
function loadKey(envName) {
  const p = expand(process.env[envName]);
  if (!p) { console.error('Variable ' + envName + ' manquante (chemin de la clé de service account).'); process.exit(1); }
  if (!fs.existsSync(p)) { console.error('Fichier introuvable : ' + p); process.exit(1); }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const academyKey = loadKey('ACADEMY_SA_KEY');
const teamKey    = loadKey('TEAM_SA_KEY');
if (teamKey.project_id !== 'ambitio-team') {
  console.error('TEAM_SA_KEY ne cible pas ambitio-team (' + teamKey.project_id + '). Arrêt.');
  process.exit(1);
}

const academyApp = admin.initializeApp({ credential: admin.credential.cert(academyKey) }, 'academy');
const teamApp    = admin.initializeApp({ credential: admin.credential.cert(teamKey) }, 'team');
const src = academyApp.firestore();
const dst = teamApp.firestore();

/* ─── Correspondance nom → id fixe ────────────────────────────────────── */
function slugify(name) {
  return String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'formation';
}
function targetIdFor(name) {
  const n = String(name || '').toLowerCase();
  if (/setting/.test(n)) return 'setting-lab';
  if (/closing|closeur/.test(n)) return 'closing-lab';
  if (/coach/.test(n)) return 'coach-lab';
  return slugify(name);
}
const ICONS = { 'setting-lab': '📞', 'closing-lab': '🎯', 'coach-lab': '🎓' };

/* ─── Apparence (theme) : même forme que FormationsCore.normalizeTheme ─── */
const CTA_COLORS = ['ink', 'gold', 'ember', 'green', 'blue', 'white'];
const HEX_TO_NAME = {
  '#dc5b34': 'ember', '#b8431f': 'ember', '#b0822a': 'gold', '#be9447': 'gold', '#e9c877': 'gold',
  '#1f9d57': 'green', '#3fa463': 'green', '#2f7fd1': 'blue', '#2d7cf0': 'blue',
  '#3a2540': 'ink', '#2a1b2e': 'ink', '#f4f1ec': 'white', '#ffffff': 'white',
};
function ctaColorName(v) {
  if (!v) return 'ink';
  if (CTA_COLORS.indexOf(v) >= 0) return v;
  return HEX_TO_NAME[String(v).toLowerCase()] || 'ink';
}
function cleanTheme(t) {
  const th = t || {};
  const h = th.hero || {};
  return {
    hero: {
      title: h.title || '',
      tagline: typeof h.tagline === 'string' ? h.tagline : (h.subtitle || ''),
      image: h.image || '',
      overlay: typeof h.overlay === 'number' ? h.overlay : 0.45,
      ctaText: h.ctaText || '',
    },
    welcome: typeof th.welcome === 'string' ? th.welcome : '',
    sidebar: (th.sidebar || []).map((b) => {
      const ctaText = b.ctaText || b.btnLabel || '';
      return {
        id: b.id || ('w' + Math.random().toString(36).slice(2, 10)),
        title: b.title || '',
        showImage: typeof b.showImage === 'boolean' ? b.showImage : !!b.image,
        image: b.image || '',
        body: typeof b.body === 'string' ? b.body : (b.text || ''),
        showCta: typeof b.showCta === 'boolean' ? b.showCta : !!ctaText,
        ctaText,
        ctaUrl: b.ctaUrl || b.btnUrl || '',
        ctaNewTab: typeof b.ctaNewTab === 'boolean' ? b.ctaNewTab : true,
        ctaColor: ctaColorName(b.ctaColor || b.btnColor),
        ctaTextColor: typeof b.ctaTextColor === 'string' ? b.ctaTextColor : '',
        ctaWidth: b.ctaWidth === 'full' ? 'full' : 'auto',
        enabled: typeof b.enabled === 'boolean' ? b.enabled : true,
      };
    }),
  };
}

/* ─── Transformation d'un cours Academy en formation Team ─────────────── */
const stats = { modules: 0, subs: 0, lessons: 0, binders: 0, apps: 0, drip: 0, tools: 0, drafts: 0 };

function cleanLesson(l) {
  const out = {
    kind: 'lesson',
    id: l.id,
    title: l.title || '',
    status: l.status === 'draft' ? 'draft' : 'published',
    video: l.video || '',
    image: l.image || '',
    audio: l.audio || '',
    body: l.body || '',
    duration: l.duration || '',
    thumbnail: l.thumbnail || '',
    resources: (l.resources || []).map((r) => ({ title: r.title || '', url: r.url || '' })),
  };
  if (l.description) out.description = l.description;
  if (l.app) stats.apps += 1;
  if (l.dripDays) stats.drip += 1;
  if (l.isTool) stats.tools += 1;
  if (out.status === 'draft') stats.drafts += 1;
  stats.lessons += 1;
  return out;
}
function cleanBinder(b) {
  stats.binders += 1;
  return {
    kind: 'binder',
    id: b.id,
    title: b.title || '',
    status: b.status === 'draft' ? 'draft' : 'published',
    intro: b.intro || '',
    sections: (b.sections || []).map((s) => ({
      id: s.id, title: s.title || '',
      files: (s.files || []).map((f) => ({ id: f.id, title: f.title || '', url: f.url || '', note: f.note || '' })),
    })),
  };
}
function cleanChild(c) {
  if (!c) return null;
  if (c.kind === 'sub') {
    stats.subs += 1;
    const out = { kind: 'sub', id: c.id, title: c.title || '', lessons: (c.lessons || []).map((l) => (l.kind === 'binder' ? cleanBinder(l) : cleanLesson(l))) };
    if (c.description) out.description = c.description;
    if (c.thumbnail) out.thumbnail = c.thumbnail;
    return out;
  }
  if (c.kind === 'binder') return cleanBinder(c);
  return cleanLesson(c);
}
function cleanModules(modules) {
  return (modules || []).map((m) => {
    stats.modules += 1;
    const out = { id: m.id, title: m.title || '', status: m.status === 'draft' ? 'draft' : 'published', children: (m.children || []).map(cleanChild).filter(Boolean) };
    if (m.description) out.description = m.description;
    if (m.thumbnail) out.thumbnail = m.thumbnail;
    return out;
  });
}

function describe(modules) {
  const lines = [];
  modules.forEach((m) => {
    lines.push('  ▸ [' + (m.status === 'draft' ? 'brouillon' : 'publié') + '] ' + m.title + '  (' + m.children.length + ' éléments)');
    m.children.forEach((c) => {
      if (c.kind === 'sub') {
        lines.push('      ◦ sous-module « ' + c.title + ' » — ' + c.lessons.length + ' leçons');
      } else {
        lines.push('      · ' + (c.kind === 'binder' ? '📎 ' : '') + c.title + (c.status === 'draft' ? '  (brouillon)' : ''));
      }
    });
  });
  return lines.join('\n');
}

/* ─── Main ────────────────────────────────────────────────────────────── */
(async () => {
  console.log((EXECUTE ? '▶ EXÉCUTION' : '👁  LECTURE SEULE') + ' — Academy → Team (formations)\n');

  const snap = await src.collection('courses').where('team', '==', true).get();
  if (snap.empty) { console.log('Aucun cours team:true côté Academy.'); process.exit(0); }

  const plan = [];
  for (const d of snap.docs) {
    const c = d.data() || {};
    const id = targetIdFor(c.name);
    if (ONLY && ONLY !== id) continue;
    Object.keys(stats).forEach((k) => { stats[k] = 0; });
    const modules = cleanModules(c.modules);
    const sizeBytes = Buffer.byteLength(JSON.stringify(modules), 'utf8');
    const existing = await dst.collection('formations').doc(id).get();
    const theme = cleanTheme(c.theme);
    plan.push({ srcId: d.id, id, name: c.name, status: c.status, modules, theme, hint: c.tag || '', sizeBytes, existing: existing.exists, existingData: existing.exists ? existing.data() : null, stats: Object.assign({}, stats) });
  }

  if (!plan.length) { console.log('Rien à faire (filtre --only=' + ONLY + ').'); process.exit(0); }

  plan.forEach((p) => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Academy courses/' + p.srcId + '  « ' + p.name + ' »  (' + (p.status || 'draft') + ')');
    console.log('   →  Team formations/' + p.id + (p.existing ? '   ⚠ EXISTE DÉJÀ' + (OVERWRITE ? ' (sera archivé puis remplacé)' : ' (refusé sans --overwrite)') : '   (nouveau)'));
    console.log('   ' + p.stats.modules + ' modules · ' + p.stats.subs + ' sous-modules · ' + p.stats.lessons + ' leçons (' + p.stats.drafts + ' brouillons) · ' + p.stats.binders + ' classeurs · ' + Math.round(p.sizeBytes / 1024) + ' Ko');
    if (p.stats.apps || p.stats.drip || p.stats.tools) {
      console.log('   ignoré : ' + p.stats.apps + ' mini-apps, ' + p.stats.drip + ' drips, ' + p.stats.tools + ' leçons-outils (gardées comme leçons simples)');
    }
    if (p.sizeBytes > 900 * 1024) console.log('   ⚠ proche de la limite de 1 Mo par document Firestore');
    const wOn = p.theme.sidebar.filter((w) => w.enabled).length;
    console.log('   apparence : bannière « ' + (p.theme.hero.title || '—') + ' »' + (p.theme.hero.image ? ' avec image' : '') + ' · ' + wOn + ' widget(s) latéraux' + (p.theme.welcome ? ' · texte d\'accueil' : '') + (p.hint ? ' · ' + p.hint : ''));
    p.theme.sidebar.forEach((w) => console.log('      ▪ ' + (w.enabled ? '' : '(désactivé) ') + w.title + (w.showCta && w.ctaText ? '  → [' + w.ctaText + '] ' + w.ctaUrl : '')));
    console.log(describe(p.modules));
  });
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (!EXECUTE) {
    console.log('\nLecture seule : rien n\'a été écrit. Relance avec --execute pour appliquer.');
    process.exit(0);
  }

  let written = 0, skipped = 0;
  for (const p of plan) {
    const ref = dst.collection('formations').doc(p.id);
    if (THEME_ONLY) {
      if (!p.existing) { console.log('⏭  ' + p.id + ' n\'existe pas encore côté Team — lance d\'abord la migration complète.'); skipped += 1; continue; }
      await ref.update({ theme: p.theme, hint: p.hint, updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: 'migrate-labs-from-academy --theme-only' });
      written += 1;
      console.log('✅ formations/' + p.id + ' : apparence mise à jour (' + p.theme.sidebar.length + ' widgets).');
      continue;
    }
    if (p.existing && !OVERWRITE) { console.log('⏭  ' + p.id + ' existe déjà — ignoré (utilise --overwrite).'); skipped += 1; continue; }
    if (p.existing) {
      const ts = Date.now();
      await ref.collection('history').doc(String(ts)).set(Object.assign({}, p.existingData, { _archivedAt: admin.firestore.FieldValue.serverTimestamp(), _reason: 'migrate-labs-from-academy --overwrite' }));
      console.log('🗄  ' + p.id + ' : ancien document archivé dans history/' + ts);
    }
    const now = admin.firestore.FieldValue.serverTimestamp();
    const doc = {
      name: p.name || p.id,
      type: 'Espace équipe',
      team: true,
      status: PUBLISH ? 'published' : 'draft',
      order: plan.indexOf(p) + 1,
      icon: ICONS[p.id] || '🎓',
      description: '',
      hint: p.hint,
      theme: p.theme,
      modules: p.modules,
      createdAt: p.existing && p.existingData.createdAt ? p.existingData.createdAt : now,
      updatedAt: now,
      updatedBy: 'migrate-labs-from-academy',
      _migratedFrom: { project: academyKey.project_id, courseId: p.srcId, at: now, academyStatus: p.status || 'draft' },
    };
    await ref.set(doc);
    await dst.collection('audit_log').add({
      type: 'formations_migration',
      formationId: p.id,
      source: { project: academyKey.project_id, courseId: p.srcId },
      counts: p.stats,
      overwrite: !!p.existing,
      by: 'scripts/migrate-labs-from-academy.js',
      createdAt: now,
    });
    written += 1;
    console.log('✅ formations/' + p.id + ' écrit (' + (PUBLISH ? 'publié' : 'brouillon') + ').');
  }
  console.log('\nTerminé : ' + written + ' écrit(s), ' + skipped + ' ignoré(s).');
  if (written && !PUBLISH) console.log('Les formations arrivent en BROUILLON : publie-les depuis formations-admin.html une fois vérifiées.');
  process.exit(0);
})().catch((e) => { console.error('Erreur :', e); process.exit(1); });
