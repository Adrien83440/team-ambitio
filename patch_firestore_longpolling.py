#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
===========================================================================
  PATCH FIRESTORE - auto-detection du long-polling (toutes les pages compat)
===========================================================================

CE QUE FAIT CE SCRIPT
  Il parcourt les pages .html du dossier et ajoute UN reglage de connexion
  Firestore (experimentalAutoDetectLongPolling) juste apres l'initialisation
  de Firebase. Ce reglage fait basculer Firestore sur un transport robuste
  des qu'il detecte un souci de connexion.

POURQUOI
  Sous Safari (et certains reseaux filtrants), la connexion temps reel de
  Firestore (WebChannel) peut rester bloquee a l'etablissement au premier
  chargement -> une page reste figee (ex : Leads Live bloque sur
  "Chargement des leads...") jusqu'a un ou deux rechargements. Ce reglage
  elimine ce blocage.

COMMENT L'UTILISER (rien de complique)
  1. Place CE fichier .py dans le dossier de ton projet (celui qui contient
     booking.html, sales-leads.html, etc.).
  2. Ouvre le Terminal, place-toi dans ce dossier, puis lance :
         python3 patch_firestore_longpolling.py
  3. Le script affiche la liste des pages corrigees. Pousse sur GitHub.

  (Optionnel : python3 patch_firestore_longpolling.py /chemin/du/dossier)

SANS DANGER
  - Idempotent : relancable autant de fois que voulu (les pages deja faites
    sont laissees telles quelles).
  - Ne touche QUE les pages "compat" (SDK v8/v9) qui initialisent Firebase via
    firebase.initializeApp. Les pages "modernes" (v10, import ESM) sont
    laissees telles quelles : cette version de Firebase active deja ce
    comportement par defaut.
  - Le reglage est insere juste APRES initializeApp et seulement si le SDK
    Firestore est charge avant -> jamais d'effet de bord.
"""

import sys
import os
import glob
import io

MARKER = "experimentalAutoDetectLongPolling"
INIT_KW = "firebase.initializeApp"
# SDK Firestore "compat" : v9 = firebase-firestore-compat.js, v8 = firebase-firestore.js
FS_SDK_CANDIDATES = ("firebase-firestore-compat.js", "firebase-firestore.js")

INJECT = (
    " /* Firestore: auto-detect long-polling (corrige les blocages de connexion"
    " intermittents sous Safari) */ try { firebase.firestore().settings({"
    " experimentalAutoDetectLongPolling: true }); } catch (e) { if (window.console)"
    " console.warn('[firestore] settings non appliques:', e && e.message); }"
)


def find_init_statement_end(src):
    """Position juste apres le ';' (ou la ')') qui termine le PREMIER
    firebase.initializeApp(...). Scanner conscient des chaines pour ne pas se
    faire piéger par une parenthese dans une valeur. Retourne -1 si introuvable."""
    idx = src.find(INIT_KW)
    if idx == -1:
        return -1, -1
    p = src.find("(", idx)
    if p == -1:
        return -1, -1
    depth = 0
    i = p
    n = len(src)
    in_str = None
    while i < n:
        c = src[i]
        if in_str:
            if c == "\\":
                i += 2
                continue
            if c == in_str:
                in_str = None
            i += 1
            continue
        if c in ('"', "'", "`"):
            in_str = c
            i += 1
            continue
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                end = i + 1
                if end < n and src[end] == ";":
                    end += 1
                return idx, end
        i += 1
    return idx, -1


def classify_and_patch(path):
    with io.open(path, "r", encoding="utf-8") as f:
        src = f.read()

    has_compat_init = INIT_KW in src
    has_modular = ("initializeApp" in src) and ("firebasejs" in src) and not has_compat_init

    if not has_compat_init:
        if has_modular:
            return ("moderne", path)        # v10 ESM : deja par defaut, on ne touche pas
        return ("sans-base", path)          # pas de Firebase du tout

    if MARKER in src:
        return ("deja-fait", path)

    # Garde : un SDK Firestore compat doit etre charge AVANT l'init.
    init_pos = src.find(INIT_KW)
    sdk_pos = min([src.find(s) for s in FS_SDK_CANDIDATES if s in src] or [-1])
    if sdk_pos == -1 or sdk_pos > init_pos:
        return ("a-verifier", path)         # disposition inattendue : on n'applique pas a l'aveugle

    idx, end = find_init_statement_end(src)
    if end == -1:
        return ("a-verifier", path)

    patched = src[:end] + INJECT + src[end:]
    assert patched.count(MARKER) == 1, "le reglage doit apparaitre une seule fois"
    assert patched.find(MARKER) > sdk_pos, "le reglage doit etre apres le SDK Firestore"

    with io.open(path, "w", encoding="utf-8") as f:
        f.write(patched)
    return ("patched", path)


def main():
    target = sys.argv[1] if len(sys.argv) > 1 else "."
    if not os.path.isdir(target):
        print("[!] Dossier introuvable : %s" % target)
        sys.exit(2)

    self_name = os.path.basename(os.path.abspath(__file__))
    files = sorted(glob.glob(os.path.join(target, "*.html")))

    buckets = {"patched": [], "deja-fait": [], "moderne": [], "sans-base": [], "a-verifier": []}
    for path in files:
        if os.path.basename(path) == self_name:
            continue
        status, p = classify_and_patch(path)
        buckets[status].append(os.path.basename(p))

    print("=" * 66)
    print("  PATCH FIRESTORE LONG-POLLING")
    print("=" * 66)
    print("\n[OK] %d page(s) corrigee(s) :" % len(buckets["patched"]))
    for n in buckets["patched"]:
        print("     + " + n)
    if buckets["deja-fait"]:
        print("\n[=] %d deja corrigee(s) (laissees telles quelles) :" % len(buckets["deja-fait"]))
        for n in buckets["deja-fait"]:
            print("     . " + n)
    if buckets["moderne"]:
        print("\n[i] %d page(s) MODERNE(S) v10 - non concernees (auto-detect deja par defaut) :" % len(buckets["moderne"]))
        for n in buckets["moderne"]:
            print("     ~ " + n)
    if buckets["a-verifier"]:
        print("\n[!] %d page(s) A VERIFIER manuellement (disposition inattendue, NON modifiees) :" % len(buckets["a-verifier"]))
        for n in buckets["a-verifier"]:
            print("     ? " + n)
    if buckets["sans-base"]:
        print("\n[-] %d page(s) sans base de donnees (ignorees) :" % len(buckets["sans-base"]))
        for n in buckets["sans-base"]:
            print("     - " + n)
    print("\n" + "=" * 66)
    if buckets["patched"]:
        print("Termine. Pousse les fichiers modifies sur GitHub -> Vercel deploiera.")
    else:
        print("Rien a faire : tout etait deja a jour.")
    print("=" * 66)


if __name__ == "__main__":
    main()
