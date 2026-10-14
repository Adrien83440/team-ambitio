#!/bin/zsh
# ============================================================================
# scripts/bp-deploiement.sh — DÉPLOIEMENT DU NOUVEAU BUSINESS PHÉNIX
# ----------------------------------------------------------------------------
# Enchaîne, dans l'ordre imposé par CLAUDE.md, tout ce qui part en production :
#   1. Règles Firestore (seul ajout : bloc _config/business_phenix — vérifié
#      le 14/10/2026 : la Console était identique au repo avant ce bloc)
#   2. Academy : merge de vague/business-phenix dans main + push (Vercel)
#   3. Alteore : push de main (Vercel)
#   4. Données : scripts/bp-mise-en-service.js --apply (contrat, config,
#      type de RDV audit business, site public, formations, cours Academy)
#
# Le bouton « 🚀 Démarrer » de Admin → Offres & formules n'est PAS actionné :
# c'est la mise en production finale, après vérification.
#
#   zsh scripts/bp-deploiement.sh
# ============================================================================
set -e
ALTEORE="$HOME/Documents/team-ambitio"
ACADEMY="$HOME/Documents/ae-academy-bp"

echo "━━ 0. Vérifications"
cd "$ALTEORE"
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || { echo "✗ team-ambitio n'est pas sur main"; exit 1; }
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "✗ team-ambitio : modifications non commitées"; exit 1; }
firebase use ambitio-team >/dev/null
echo "  projet Firebase : $(firebase use)"
node scripts/bp-mise-en-service.js > /tmp/bp-mise-en-service-dry.txt 2>&1 || { echo "✗ le dry-run de mise en service échoue :"; tail -20 /tmp/bp-mise-en-service-dry.txt; exit 1; }
echo "  dry-run de mise en service : OK"

echo "━━ 1. Règles Firestore"
firebase deploy --only firestore:rules --project ambitio-team

echo "━━ 2. Academy (merge vague/business-phenix → main, push)"
cd "$ACADEMY"
[ -z "$(git status --porcelain)" ] || { echo "✗ worktree Academy : modifications non commitées"; exit 1; }
git fetch origin
git push origin vague/business-phenix
git switch main 2>/dev/null || git switch -c main --track origin/main
git merge --ff-only origin/main
git merge --no-ff vague/business-phenix -m "Merge : Business Phénix nouveau format (programme business-phenix, 10 jalons, cours sans vidéo)"
node tests/parcours/run.mjs | tail -1
git push origin main
git switch vague/business-phenix

echo "━━ 3. Alteore (push main → Vercel)"
cd "$ALTEORE"
git push origin main

echo "  attente du déploiement Vercel (90 s)…"
sleep 90

echo "━━ 4. Données de mise en service"
node scripts/bp-mise-en-service.js --apply

echo ""
echo "✓ Déploiement terminé. Reste : vérifier, puis Admin → Offres & formules → 🚀 Démarrer."
