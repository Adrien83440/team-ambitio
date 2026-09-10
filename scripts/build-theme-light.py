#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build-theme-light.py — génère `theme-light-pages.css` à la racine du repo.

Pourquoi
--------
Le thème clair (`body.light-theme`, bascule dans la sidebar de nav.js) ne
redéfinissait que 9 variables CSS. Or les pages utilisent des centaines de
couleurs codées en dur pensées pour le fond sombre : `rgba(255,255,255,.4)`
pour un texte secondaire, `#0f0f1a` pour un fond de carte, `#fca5a5` pour un
accent… En clair, tout cela devient illisible.

Ce script lit le CSS réel de chaque page (blocs `<style>` inline), des feuilles
partagées et du CSS injecté par les widgets JS, puis émet pour chaque
déclaration problématique une règle de surcharge :

    body.light-theme[data-al-page="sales-crm"] .ld-sub { color: rgba(17,19,36,.6); }

Les surcharges des pages sont scopées par `data-al-page` (posé par nav.js),
celles des fichiers partagés sont globales. La spécificité est toujours
supérieure à la règle d'origine (préfixe `body.light-theme`), `!important`
est reporté tel quel, les `@media` sont conservés.

Usage
-----
    python3 scripts/build-theme-light.py           # écrit theme-light-pages.css
    python3 scripts/build-theme-light.py --check   # échoue si le fichier n'est pas à jour

Le fichier généré est committé : ne jamais l'éditer à la main, relancer le
script après toute modification de CSS dans une page.
"""

import os
import re
import sys
import glob
import colorsys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'theme-light-pages.css')

# Encre du thème clair (texte) — bleu nuit très désaturé.
INK = (17, 19, 36)
# Fond des overlays (voiles de modales) en clair.
VEIL = (24, 28, 52)

# Feuilles partagées : surcharges globales (non scopées par page).
SHARED_CSS = [
    'sales.css', 'sales-crm.css', 'sales-clients.css', 'sales-dialer.css',
    'alteore-ui.css', 'inbox-widget.css', 'voice-notes.css',
    'call-detail-modal.css', 'temoignages.css', 'admin-numbers.css',
    'brand.css',
]
# JS injectant du CSS via `el.textContent = `...``. nav.js est exclu : sa
# sidebar est traitée à la main dans theme-light.css.
SHARED_JS = [
    'dialer-bridge.js', 'inbox-widget.js', 'alteore-infos.js', 'rdv-outcome.js',
    'close-wizard.js', 'whatsapp-lead.js', 'client-deactivate-ui.js',
    'academy-widget.js', 'coaching-plan.js', 'sync-bridge.js',
    'call-detail-modal.js', 'voice-notes.js', 'temoignages-wall.js',
]
# Pages sans bascule de thème (pas de sidebar) — ignorées.
PAGE_EXCLUDE = {'login.html'}

BG_PROPS = ('background', 'background-color', 'background-image')
BORDER_PREFIXES = ('border', 'outline')
ACCENT_TOKENS = (
    'gold', 'green', 'blue', 'purple', 'red', 'red2', 'red3', 'orange', 'teal',
    'amber', 'accent', 'accent2', 'indigo', 'violet', 'cy', 'yellow',
    'nav-accent', 'csm-accent', 'csm-accent-2', 'csm-accent-dark',
    'blue-main', 'blue-light', 'blue-dark', 'an-teal', 'tw-blue', 'tw-violet',
    'wa-vert', 'bill-green', 'inv-green', 'pay-green',
)

# ─── Couleurs ───────────────────────────────────────────────────────────────

HEX_RE = r'#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b'
RGB_RE = r'rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*[0-9.]+\s*)?\)'
NAMED_RE = r'\b(?:white|black)\b'
COLOR_RE = re.compile('(' + HEX_RE + '|' + RGB_RE + '|' + NAMED_RE + ')')


def parse_color(s):
    """Retourne (r, g, b, a) ou None. a vaut 1.0 si absent."""
    s = s.strip().lower()
    if s == 'white':
        return (255, 255, 255, 1.0)
    if s == 'black':
        return (0, 0, 0, 1.0)
    if s.startswith('#'):
        h = s[1:]
        if len(h) in (3, 4):
            h = ''.join(c * 2 for c in h)
        if len(h) == 6:
            return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 1.0)
        if len(h) == 8:
            return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), int(h[6:8], 16) / 255.0)
        return None
    m = re.match(r'rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+)\s*)?\)', s)
    if m:
        a = float(m.group(4)) if m.group(4) is not None else 1.0
        return (int(m.group(1)), int(m.group(2)), int(m.group(3)), a)
    return None


def fmt_alpha(a):
    a = max(0.0, min(1.0, a))
    s = ('%.2f' % a).rstrip('0').rstrip('.')
    if s.startswith('0.'):
        s = s[1:]
    return s or '0'


def rgba(rgb, a):
    if a >= 0.995:
        return '#%02x%02x%02x' % rgb
    return 'rgba(%d,%d,%d,%s)' % (rgb[0], rgb[1], rgb[2], fmt_alpha(a))


def rel_lum(rgb):
    def ch(c):
        c = c / 255.0
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = rgb
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)


def contrast(rgb1, rgb2):
    l1, l2 = rel_lum(rgb1), rel_lum(rgb2)
    if l1 < l2:
        l1, l2 = l2, l1
    return (l1 + 0.05) / (l2 + 0.05)


def is_whiteish(c):
    r, g, b, _ = c
    return r >= 236 and g >= 236 and b >= 236


def is_dark_neutral(c):
    """Fond sombre « ardoise » : très peu saturé, très foncé."""
    r, g, b, a = c
    if a < 0.9:
        return False
    return max(r, g, b) <= 72 and (max(r, g, b) - min(r, g, b)) <= 44


def dark_tier(c):
    s = c[0] + c[1] + c[2]
    if s <= 40:
        return 'var(--bg)'
    if s <= 64:
        return 'var(--bg2)'
    if s <= 88:
        return 'var(--bg3)'
    return 'var(--bg4)'


def saturation(c):
    r, g, b = c[0] / 255.0, c[1] / 255.0, c[2] / 255.0
    return colorsys.rgb_to_hls(r, g, b)[2]


def darken_for_contrast(rgb, target=4.5, bg=(255, 255, 255)):
    """Abaisse la luminosité (HSL) jusqu'à obtenir le contraste voulu sur blanc."""
    r, g, b = rgb[0] / 255.0, rgb[1] / 255.0, rgb[2] / 255.0
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    # Les pastels (S≈1, L≈0.8) deviendraient des néons si l'on ne baissait que
    # la luminosité : on plafonne la saturation pour obtenir des teintes
    # franches mais posées (proches des « -600/-700 » de Tailwind).
    if s > 0.08:
        s = min(s, 0.74)
    for _ in range(60):
        rr, gg, bb = colorsys.hls_to_rgb(h, l, s)
        cand = (int(round(rr * 255)), int(round(gg * 255)), int(round(bb * 255)))
        if contrast(cand, bg) >= target or l <= 0.08:
            return cand
        l -= 0.015
    return cand


def text_alpha(a):
    """Alpha d'un texte blanc → alpha équivalent en encre (renforcé)."""
    return min(1.0, round(a * 1.05 + 0.18, 2))


# ─── Parseur CSS minimal (tolérant) ─────────────────────────────────────────

def strip_comments(css):
    return re.sub(r'/\*.*?\*/', '', css, flags=re.S)


def split_top(s, sep):
    """Découpe sur `sep` hors parenthèses / guillemets."""
    out, depth, cur, q = [], 0, [], None
    for ch in s:
        if q:
            cur.append(ch)
            if ch == q:
                q = None
            continue
        if ch in ('"', "'"):
            q = ch
            cur.append(ch)
            continue
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth = max(0, depth - 1)
        if ch == sep and depth == 0:
            out.append(''.join(cur))
            cur = []
        else:
            cur.append(ch)
    out.append(''.join(cur))
    return out


def parse_rules(css):
    """Retourne une liste de (media_list, selector, [(prop, value, important)])."""
    css = strip_comments(css)
    rules = []
    n = len(css)
    i = 0

    def find_close(j):
        depth, q = 0, None
        while j < n:
            ch = css[j]
            if q:
                if ch == q:
                    q = None
            elif ch in ('"', "'"):
                q = ch
            elif ch == '{':
                depth += 1
            elif ch == '}':
                depth -= 1
                if depth == 0:
                    return j
            j += 1
        return n

    def walk(start, end, media):
        i = start
        while i < end:
            ch = css[i]
            if ch.isspace():
                i += 1
                continue
            if ch == '}':
                i += 1
                continue
            if ch == '@':
                # at-rule
                j = i
                q = None
                while j < end:
                    c = css[j]
                    if q:
                        if c == q:
                            q = None
                    elif c in ('"', "'"):
                        q = c
                    elif c in ('{', ';'):
                        break
                    j += 1
                prelude = css[i:j].strip()
                if j >= end or css[j] == ';':
                    i = j + 1
                    continue
                close = find_close(j)
                name = prelude.split(None, 1)[0].lower()
                if name in ('@media', '@supports', '@container', '@layer'):
                    walk(j + 1, close, media + [prelude])
                # @keyframes / @font-face / @page… : ignorés
                i = close + 1
                continue
            # rule
            j = i
            q = None
            while j < end:
                c = css[j]
                if q:
                    if c == q:
                        q = None
                elif c in ('"', "'"):
                    q = c
                elif c == '{':
                    break
                elif c == '}':
                    break
                j += 1
            if j >= end or css[j] == '}':
                i = j + 1
                continue
            selector = css[i:j].strip()
            close = find_close(j)
            body = css[j + 1:close]
            decls = []
            for d in split_top(body, ';'):
                if ':' not in d:
                    continue
                prop, _, val = d.partition(':')
                prop = prop.strip().lower()
                val = val.strip()
                if not prop or not val or prop.startswith('--'):
                    continue
                imp = False
                if re.search(r'!\s*important\s*$', val):
                    imp = True
                    val = re.sub(r'\s*!\s*important\s*$', '', val)
                decls.append((prop, val, imp))
            if selector and decls:
                rules.append((media, selector, decls))
            i = close + 1

    walk(0, n, [])
    return rules


# ─── Transformations ────────────────────────────────────────────────────────

def has_solid_accent_bg(decls):
    """Le bloc peint-il un fond saturé (bouton coloré, badge plein) ?"""
    for prop, val, _ in decls:
        if prop not in BG_PROPS:
            continue
        v = val.lower()
        if 'url(' in v:
            return True
        if 'gradient(' in v:
            for m in COLOR_RE.findall(v):
                c = parse_color(m)
                if c and not is_whiteish(c) and not is_dark_neutral(c) and c[:3] != (0, 0, 0) and saturation(c) > 0.2 and c[3] >= 0.55:
                    return True
            for name in re.findall(r'var\(\s*--([\w-]+)', v):
                if name in ACCENT_TOKENS:
                    return True
            continue
        mv = re.search(r'var\(\s*--([\w-]+)', v)
        if mv:
            name = mv.group(1)
            if name in ACCENT_TOKENS:
                return True
            if re.match(r'(ink|dark|black|navy|blue-dark|blue-main|slate)$', name):
                return True
            if re.search(r'(bg|soft|dim|glow|light|ghost|subtle|hover|border|card|elev|panel|line|surface|track|muted|text|ink)', name):
                continue
            return True
        c = parse_color(v)
        if c and not is_whiteish(c) and not is_dark_neutral(c) and c[:3] != (0, 0, 0):
            if c[3] >= 0.55 and saturation(c) > 0.2:
                return True
    return False


def has_accent_token_bg(decls):
    for prop, val, _ in decls:
        if prop in BG_PROPS:
            mv = re.match(r'\s*var\(\s*--([\w-]+)\s*\)\s*$', val)
            if mv and mv.group(1) in ACCENT_TOKENS:
                return True
    return False


def map_text_color(val, accent_bg, chip_like=False):
    v = val.strip()
    if 'var(' in v or v.lower() in ('inherit', 'currentcolor', 'transparent', 'initial', 'unset'):
        return None
    c = parse_color(v)
    if not c or not COLOR_RE.fullmatch(v):
        return None
    r, g, b, a = c
    if is_whiteish(c):
        if accent_bg or (a >= 0.9 and chip_like):
            return None
        return rgba(INK, text_alpha(a))
    if is_dark_neutral(c) or (r, g, b) == (0, 0, 0):
        return None
    if accent_bg:
        return None
    rgb = (r, g, b)
    if contrast(rgb, (255, 255, 255)) >= 4.5:
        return None
    # Gris clairs (#e5e7eb, #cbd5e1, #94a3b8…) : texte principal/secondaire du
    # sombre → encre translucide graduée selon la clarté, pas un gris moyen.
    hh, ll, ss = colorsys.rgb_to_hls(r / 255.0, g / 255.0, b / 255.0)
    if ss < 0.3 and ll > 0.55:
        alpha = 0.55 + (ll - 0.55) * (0.4 / 0.45)
        return rgba(INK, round(min(0.95, alpha) * (1.0 if a >= 0.45 else a), 2))
    # Couleur d'accent pastel : assombrie jusqu'à un contraste 4.5:1 sur blanc.
    dark = darken_for_contrast(rgb)
    return rgba(dark, 1.0 if a >= 0.45 else a)


def map_bg(val):
    v = val.strip()
    low = v.lower()
    if 'url(' in low or 'var(' in low:
        return None
    if 'gradient(' in low:
        changed = False

        def sub(m):
            nonlocal changed
            c = parse_color(m.group(1))
            if not c:
                return m.group(0)
            if is_whiteish(c) and c[3] <= 0.35:
                changed = True
                return 'rgba(255,255,255,%s)' % ('.55' if c[3] <= 0.12 else '.75')
            if is_dark_neutral(c):
                changed = True
                return dark_tier(c)
            if c[:3] == (0, 0, 0) and c[3] < 0.9:
                changed = True
                return rgba(INK, round(c[3] * 0.3, 3))
            return m.group(0)
        out = COLOR_RE.sub(sub, v)
        return out if changed else None
    c = parse_color(v)
    if not c or not COLOR_RE.fullmatch(v):
        return None
    r, g, b, a = c
    if is_whiteish(c):
        # Panneau / survol « subtil » du sombre (blanc à 3-12 %) : en clair une
        # encre à 2 % serait invisible → on en fait une surface de verre blanc,
        # lisible sur le fond maillé comme sur une carte.
        if a <= 0.12:
            return 'rgba(255,255,255,.55)'
        if a <= 0.35:
            return 'rgba(255,255,255,.75)'
        return None
    if is_dark_neutral(c):
        return dark_tier(c)
    if (r, g, b) == (0, 0, 0):
        if a >= 0.35:
            return rgba(VEIL, round(a * 0.62, 3))
        return rgba(INK, round(a * 0.3, 3))
    return None


def map_border(val):
    v = val.strip()
    if 'var(' in v and not COLOR_RE.search(v):
        return None
    changed = False

    def sub(m):
        nonlocal changed
        c = parse_color(m.group(1))
        if not c:
            return m.group(0)
        if is_whiteish(c):
            changed = True
            a = c[3]
            return rgba(INK, min(0.32, max(0.12, round(a * 1.5, 3))) if a < 0.9 else 0.2)
        if is_dark_neutral(c):
            changed = True
            return 'var(--border)'
        if c[:3] == (0, 0, 0) and c[3] < 0.9:
            changed = True
            return rgba(INK, round(c[3] * 0.5, 3))
        return m.group(0)
    out = COLOR_RE.sub(sub, v)
    return out if changed else None


def map_shadow(val):
    v = val.strip()
    changed = False

    def sub(m):
        nonlocal changed
        c = parse_color(m.group(1))
        if not c:
            return m.group(0)
        if c[:3] == (0, 0, 0) and c[3] < 1.0:
            changed = True
            return rgba(VEIL, round(c[3] * 0.32, 3))
        if is_dark_neutral(c) and c[3] < 1.0:
            changed = True
            return rgba(VEIL, round(c[3] * 0.32, 3))
        return m.group(0)
    out = COLOR_RE.sub(sub, v)
    return out if changed else None


def is_chip_like(sel, decls):
    """Pastille / avatar / bloc d'agenda coloré par style inline : le texte
    blanc doit rester blanc même si le bloc CSS ne déclare aucun fond."""
    if re.search(r'(av\b|avatar|badge|swatch|fill|chip|pill|dot|tag)', sel):
        return True
    props = {p for p, _, _ in decls}
    if 'border-radius' in props and 'width' in props and 'height' in props:
        return True
    if 'border-radius' in props and 'padding' in props and 'position' in props:
        return True
    return False


def transform(decls, sel=''):
    """Retourne la liste des déclarations de surcharge pour un bloc."""
    out = []
    accent_bg = has_solid_accent_bg(decls)
    accent_token_bg = has_accent_token_bg(decls)
    chip_like = is_chip_like(sel, decls)
    for prop, val, imp in decls:
        if '__I__' in val:
            continue
        new = None
        if prop in ('color', 'fill', 'stroke', '-webkit-text-fill-color', 'caret-color'):
            new = map_text_color(val, accent_bg, chip_like)
            if new is None and accent_token_bg and prop == 'color':
                c = parse_color(val.strip())
                mv = re.match(r'\s*var\(\s*--(bg\d?|bg-elev|bg-card|dark\d?|an-bg)\s*\)\s*$', val)
                if (c and (is_dark_neutral(c) or c[:3] == (0, 0, 0))) or mv:
                    new = '#ffffff'
        elif prop in BG_PROPS:
            new = map_bg(val)
        elif prop.startswith(BORDER_PREFIXES) and 'radius' not in prop and 'width' not in prop and 'style' not in prop and 'image' not in prop:
            new = map_border(val)
        elif prop in ('box-shadow', 'text-shadow'):
            new = map_shadow(val)
        if new is not None and new != val:
            out.append((prop, new, imp))
    return out


# ─── Liquid glass ───────────────────────────────────────────────────────────

SURFACE_TOKEN_RE = re.compile(r'^\s*var\(\s*--(bg2|bg3|bg-elev|bg-card|card|panel|tw-bg2|tw-bg3|an-bg-elev|an-bg-elev-2|wa-panneau|wa-liste)\s*(?:,[^)]*)?\)\s*$')
GLASS_BLUR = 'blur(22px) saturate(1.6)'
# Calque plat (pas de dégradé : un reflet oblique donnait un effet « buée »)
# qui ramène la carte à ~94 % de blanc tout en laissant `background:` des
# états (hover, ouvert) reprendre la main puisqu'il réinitialise l'image.
GLASS_CARD_IMAGE = 'linear-gradient(165deg,rgba(255,255,255,.42),rgba(255,255,255,.12) 45%,rgba(255,255,255,.28))'
# « Bulle » liquid glass : rim blanc intérieur (bord éclairé), anneau sombre
# extérieur fin (détourage), ombre de contact + ombre portée diffuse.
GLASS_CARD_SHADOW = ('inset 0 1px 0 rgba(255,255,255,.95),inset 0 0 0 1px rgba(255,255,255,.45),'
                     '0 0 0 1px rgba(17,19,36,.12),0 2px 6px rgba(24,28,52,.08),0 18px 40px -14px rgba(24,28,52,.30)')
GLASS_CARD_BORDER = 'rgba(255,255,255,.85)'


def radius_px(val):
    m = re.match(r'\s*([0-9.]+)px', val)
    if m:
        return float(m.group(1))
    # Rayons en token (--radius, --radius2, --tw-r, --an-radius…) : 10 à 18px
    # dans toutes les pages → assimilés à une carte.
    if re.match(r'\s*var\(\s*--(radius2?|tw-r2?|an-radius|r2?)\s*\)', val):
        return 14.0
    return None


def glass_decls(decls, sel=''):
    """Chrome fixe/sticky → verre flouté ; cartes (fond token + rayon ≥ 12px
    + padding) → reflet dégradé, hairline blanche et ombre douce. Seules des
    propriétés de peinture sont émises, jamais de layout."""
    props = {p: v for p, v, _ in decls}
    out = []
    low = sel.lower()
    if '::before' in low or '::after' in low or ':before' in low or ':after' in low:
        return out
    if low in ('body', 'html') or low.startswith('body:') or low.startswith('html:'):
        return out
    pos = props.get('position', '').strip().lower()
    if pos in ('fixed', 'sticky'):
        out.append(('-webkit-backdrop-filter', GLASS_BLUR, False))
        out.append(('backdrop-filter', GLASS_BLUR, False))
        return out
    bg = props.get('background', props.get('background-color', ''))
    if not SURFACE_TOKEN_RE.match(bg):
        return out
    r = radius_px(props.get('border-radius', ''))
    if r is None or r < 12 or r > 24 or 'padding' not in props:
        return out
    if re.search(r'(chip|pill|badge|tag|btn|button|input|select|toggle|switch|av\b|avatar)', sel):
        return out
    out.append(('background-image', GLASS_CARD_IMAGE, False))
    out.append(('border-color', GLASS_CARD_BORDER, False))
    out.append(('box-shadow', GLASS_CARD_SHADOW, False))
    return out


# ─── Sélecteurs ─────────────────────────────────────────────────────────────

def scope_selector(sel, scope):
    """Préfixe un sélecteur avec le scope light SANS augmenter sa spécificité
    (`:where()` pèse zéro) : la surcharge gagne sur la règle d'origine par
    ordre de chargement seulement, et continue de perdre face aux états plus
    spécifiques de la page (`.card:hover`, `.card.is-open`…), exactement
    comme la règle qu'elle remplace. `scope` est le contenu du body, ex.
    `.light-theme[data-al-page="x"]`."""
    parts = [p.strip() for p in split_top(sel, ',')]
    out = []
    for p in parts:
        if not p:
            continue
        low = p.lower()
        if low in (':root', 'html') or low.startswith('html ') or low.startswith('html,') or low.startswith('html>') or low.startswith('html:'):
            continue
        if 'light-theme' in low:
            continue
        if low == 'body' or low.startswith('body ') or low.startswith('body.') or low.startswith('body>') or low.startswith('body:') or low.startswith('body['):
            out.append('body:where(' + scope + ')' + p[4:])
            continue
        out.append(':where(body' + scope + ') ' + p)
    return ', '.join(out)


def emit(rules, scope, stats):
    lines = []
    for media, sel, decls in rules:
        if '__I__' in sel:
            continue
        mapped = transform(decls, sel)
        mapped += glass_decls(decls, sel)
        if not mapped:
            continue
        if not selector_is_sane(sel):
            continue
        s = scope_selector(sel, scope)
        if not s:
            continue
        body = ' '.join('%s:%s%s;' % (p, v, ' !important' if imp else '') for p, v, imp in mapped)
        rule = '%s{%s}' % (s, body)
        for m in reversed(media):
            rule = '%s{%s}' % (m, rule)
        lines.append(rule)
        stats[0] += 1
    return lines


# ─── Extraction des sources ─────────────────────────────────────────────────

STYLE_TAG_RE = re.compile(r'<style[^>]*>(.*?)</style>', re.S | re.I)
JS_TPL_RE = re.compile(r'textContent\s*=\s*`(.*?)`', re.S)


def read(path):
    with open(path, encoding='utf-8', errors='ignore') as f:
        return f.read()


SCRIPT_TAG_RE = re.compile(r'<script\b[^>]*>.*?</script>', re.S | re.I)


def page_css(html):
    # Les <style> construits dans du JS (gabarits de rendu public) sont des
    # chaînes concaténées, pas du CSS : on retire d'abord les <script>.
    html = SCRIPT_TAG_RE.sub('', html)
    return '\n'.join(STYLE_TAG_RE.findall(html))


SELECTOR_OK_RE = re.compile(r'^[\w\s.#:>+~*\[\]="\'()^$|,%-]+$')


def selector_is_sane(sel):
    """Un sélecteur douteux (guillemet orphelin, fragment JS) casserait le
    parse de tout le reste de la feuille : on le refuse."""
    if not SELECTOR_OK_RE.match(sel):
        return False
    if sel.count('"') % 2 or sel.count("'") % 2:
        return False
    if sel.count('(') != sel.count(')') or sel.count('[') != sel.count(']'):
        return False
    return True


JS_CONCAT_RE = re.compile(r"var\s+css\s*=\s*''\s*\+\s*((?:'(?:[^'\\]|\\.)*'\s*\+\s*)*'(?:[^'\\]|\\.)*')\s*;", re.S)


def js_css(js):
    blocks = []
    # CSS en chaînes simples concaténées (style ES5 : var css = '' + '…' + '…';)
    for b in JS_CONCAT_RE.findall(js):
        frags = re.findall(r"'((?:[^'\\]|\\.)*)'", b)
        blocks.append(''.join(frags).replace("\\'", "'"))
    for b in JS_TPL_RE.findall(js):
        # Un bloc CSS-in-JS peut contenir des interpolations : neutralisées.
        b = re.sub(r'\$\{[^}]*\}', '__I__', b)
        # Balises <style> imbriquées dans un innerHTML
        inner = STYLE_TAG_RE.findall(b)
        if inner:
            blocks.extend(inner)
            continue
        if '{' in b and ':' in b and ('<' not in b or b.count('{') > 3):
            blocks.append(b)
    return '\n'.join(blocks)


def inline_style_rules(files):
    """Attributs style="…" avec des blancs codés en dur (HTML statique et
    gabarits JS) : surcharges par sélecteur d'attribut, !important obligatoire."""
    seen = set()
    lines = []
    for f in files:
        s = read(f)
        for st in re.findall(r'style\s*=\s*"([^"]*)"', s) + re.findall(r"style\s*=\s*'([^']*)'", s):
            for m in re.finditer(r'(color|background|background-color)\s*:\s*((?:rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*[0-9.]+\s*\))|#fff\b|#ffffff\b|white)', st):
                prop, lit = m.group(1), m.group(2)
                key = m.group(0)
                if key in seen:
                    continue
                seen.add(key)
                c = parse_color(lit)
                if not c:
                    continue
                if prop == 'color':
                    val = rgba(INK, text_alpha(c[3]))
                    # Texte blanc sur fond coloré inline (bouton, pastille) : on
                    # ne touche pas. Tout fond explicite hors blanc translucide
                    # est considéré comme coloré.
                    guard = ''.join(':not([style*="%s"])' % g for g in (
                        'background:#', 'background: #', 'background-color:#', 'background-color: #',
                        'background:linear', 'background: linear', 'background:radial', 'background: radial',
                        'background:var(', 'background: var(', 'background-color:var(', 'background-color: var(',
                        'background:rgb', 'background: rgb', 'background-color:rgb', 'background-color: rgb',
                        'background:hsl', 'background: hsl',
                    ))
                    lines.append('body.light-theme [style*="%s"]%s{color:%s !important;}' % (key, guard, val))
                else:
                    if c[3] > 0.35:
                        continue
                    val = 'rgba(255,255,255,%s)' % ('.55' if c[3] <= 0.12 else '.75')
                    lines.append('body.light-theme [style*="%s"]{%s:%s !important;}' % (key, prop, val))
    return sorted(lines)


def pastel_inline_rules(files):
    """Couleurs d'accent posées en inline par le JS (`style="color:' + obj.color`) :
    on ne peut pas suivre la construction, mais on connaît la palette — tout
    hex littéral du code trop clair pour du texte sur blanc reçoit une règle
    d'attribut `[style*="color:#hex"]` avec sa version assombrie."""
    hexes = set()
    for f in files:
        for m in re.findall(r"['\"]#([0-9a-fA-F]{6})['\"]", read(f)):
            hexes.add(m.lower())
    # Pas de garde sur `background:rgba(` : en inline c'est toujours une
    # teinte translucide (`statusObj.bg`), jamais un fond plein.
    guard = ''.join(':not([style*="%s"])' % g for g in (
        'background:#', 'background: #', 'background-color:#', 'background-color: #',
        'background:linear', 'background: linear', 'background:var(', 'background: var(',
    ))
    lines = []
    for h in sorted(hexes):
        c = parse_color('#' + h)
        if is_whiteish(c) or is_dark_neutral(c) or contrast(c[:3], (255, 255, 255)) >= 4.5:
            continue
        hh, ll, ss = colorsys.rgb_to_hls(c[0] / 255.0, c[1] / 255.0, c[2] / 255.0)
        if ss < 0.3 and ll > 0.55:
            new = rgba(INK, round(0.55 + (ll - 0.55) * (0.4 / 0.45), 2))
        else:
            new = rgba(darken_for_contrast(c[:3]), 1.0)
        for form in ('color:#' + h, 'color: #' + h):
            lines.append('body.light-theme [style*="%s"]%s{color:%s !important;}' % (form, guard, new))
        # Fond de la MÊME couleur suffixée d'un alpha (`background:#hex1a`) :
        # forcément une teinte → même texte assombri.
        lines.append('body.light-theme [style*="color:#%s"][style*="background:#%s"]{color:%s !important;}' % (h, h, new))
    return lines


def main():
    check = '--check' in sys.argv
    os.chdir(ROOT)
    out = []
    out.append('/* ═══════════════════════════════════════════════════════════════════════')
    out.append('   theme-light-pages.css — FICHIER GÉNÉRÉ, NE PAS ÉDITER À LA MAIN.')
    out.append('   Source : scripts/build-theme-light.py (relancer après toute modif CSS).')
    out.append('   Surcharges du thème clair pour les couleurs codées en dur des pages.')
    out.append('   ═══════════════════════════════════════════════════════════════════════ */')

    total = [0]
    pages = sorted(f for f in glob.glob('*.html') if f not in PAGE_EXCLUDE and 'nav.js' in read(f))

    out.append('\n/* ── Feuilles partagées (globales) ── */')
    for f in SHARED_CSS:
        if not os.path.exists(f):
            continue
        rules = parse_rules(read(f))
        st = [0]
        lines = emit(rules, '.light-theme', st)
        if lines:
            out.append('/* %s (%d) */' % (f, st[0]))
            out.extend(lines)
        total[0] += st[0]

    out.append('\n/* ── CSS injecté par les widgets JS (global) ── */')
    for f in SHARED_JS:
        if not os.path.exists(f):
            continue
        css = js_css(read(f))
        if not css.strip():
            continue
        rules = parse_rules(css)
        st = [0]
        lines = emit(rules, '.light-theme', st)
        if lines:
            out.append('/* %s (%d) */' % (f, st[0]))
            out.extend(lines)
        total[0] += st[0]

    out.append('\n/* ── Pages (scopées par data-al-page) ── */')
    for f in pages:
        name = f[:-5]
        css = page_css(read(f))
        if not css.strip():
            continue
        rules = parse_rules(css)
        st = [0]
        lines = emit(rules, '.light-theme[data-al-page="%s"]' % name, st)
        if lines:
            out.append('/* %s (%d) */' % (f, st[0]))
            out.extend(lines)
        total[0] += st[0]

    out.append('\n/* ── Styles inline (HTML statique + gabarits JS) ── */')
    inline = inline_style_rules(pages + sorted(glob.glob('*.js')))
    out.extend(inline)
    total[0] += len(inline)

    out.append('\n/* ── Palette d\'accents pastels posée en inline par le JS ── */')
    pastel = pastel_inline_rules(pages + sorted(glob.glob('*.js')))
    out.extend(pastel)
    total[0] += len(pastel)

    result = '\n'.join(out) + '\n'
    if check:
        cur = read(OUT) if os.path.exists(OUT) else ''
        if cur != result:
            print('theme-light-pages.css n\'est pas à jour — relancer scripts/build-theme-light.py')
            sys.exit(1)
        print('theme-light-pages.css à jour (%d règles)' % total[0])
        return
    with open(OUT, 'w', encoding='utf-8') as fh:
        fh.write(result)
    print('theme-light-pages.css : %d règles, %d pages, %.0f Ko' % (total[0], len(pages), len(result) / 1024.0))


if __name__ == '__main__':
    main()
