# Construit api/_parcoursChoixData.json (HTML + texte des e-mails par douleur)
# depuis docs/parcours-rdv/sequences-choix.md.
#   python3 scripts/build-parcours-choix.py            -> écrit le JSON
#   python3 scripts/build-parcours-choix.py local DIR  -> aperçus HTML dans DIR
import re, json, html, sys
import os
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))+'/'
s=open(ROOT+'docs/parcours-rdv/sequences-choix.md').read()
IMG='https://team.alteore.com/media/parcours/'
LOCAL=len(sys.argv)>1 and sys.argv[1]=='local'
if LOCAL: IMG='file://'+ROOT+'media/parcours/'
BOOK='{{lien_rdv}}'
import hashlib
def empreinte(nom):
    # Adresse propre à chaque version d'une image : une messagerie qui a gardé
    # en mémoire une image absente ou ancienne recharge la bonne.
    if LOCAL: return ''
    return '?v='+hashlib.md5(open(ROOT+'media/parcours/'+nom,'rb').read()).hexdigest()[:8]
def inline(t):
    t=html.escape(t, quote=False)
    return re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', t)
def plain(t): return re.sub(r'\*\*(.+?)\*\*', r'\1', t)
def render(lines):
    parts=[]; txt=[]; ul=[]; ol=[]
    def flush():
        nonlocal ul, ol
        if ul:
            parts.append('<ul style="margin:0 0 18px;padding-left:22px">'+''.join('<li style="margin:0 0 8px">'+inline(x)+'</li>' for x in ul)+'</ul>'); txt.append('\n'.join('- '+plain(x) for x in ul)); ul=[]
        if ol:
            parts.append('<ol style="margin:0 0 18px;padding-left:22px">'+''.join('<li style="margin:0 0 10px">'+inline(x)+'</li>' for x in ol)+'</ol>'); txt.append('\n'.join('%d. %s'%(k+1,plain(x)) for k,x in enumerate(ol))); ol=[]
    for l in lines:
        l=l.rstrip()
        if not l.strip(): flush(); continue
        if l.startswith('- '): ul.append(l[2:]); continue
        flush()
        if l=='{{ouverture}}':
            parts.append('<p style="margin:0 0 16px;color:#4b5563">{{ouverture}}</p>'); txt.append('{{ouverture}}'); continue
        if l=='{{choix}}':
            parts.append('{{choix_html}}'); txt.append('{{choix_texte}}'); continue
        if l=='{{recap}}':
            parts.append('{{recap_html}}'); txt.append('{{recap_texte}}'); continue
        m=re.match(r'^\{\{(m_[a-z0-9_]+)\}\}$', l)
        if m:  # phrase miroir : ligne entière, retirée si vide (marqueurs lus par le moteur)
            parts.append('<!--M:'+m.group(1)+'--><p style="margin:0 0 16px;padding:10px 14px;background:#fffbeb;border-radius:10px;color:#92400e">{{'+m.group(1)+'}}</p><!--/M-->'); txt.append('{{'+m.group(1)+'}}'); continue
        m=re.match(r'^!\[(.*?)\]\((.+?)\)(?:\((https?://[^)]+)\))?$', l)
        if m:
            im='<img src="'+IMG+m.group(2)+empreinte(m.group(2))+'" alt="'+html.escape(m.group(1))+'" width="528" style="display:block;width:100%;max-width:528px;height:auto;border:0;border-radius:12px">'
            if m.group(3): im='<a href="'+html.escape(m.group(3))+'" style="text-decoration:none">'+im+'</a>'; txt.append(m.group(1)+' : '+m.group(3))
            parts.append('<div style="margin:6px 0 22px">'+im+'</div>'); continue
        if l.startswith('>> '):
            c=l[3:]
            parts.append('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 20px"><tr><td style="background:#eff4ff;border-left:4px solid #2563eb;border-radius:0 10px 10px 0;padding:14px 18px;font-size:17px;line-height:1.55;font-weight:600;color:#1e3a8a">'+inline(c)+'</td></tr></table>'); txt.append('  '+plain(c)); continue
        m=re.match(r'^\[(A|B)\] (.+)$', l)
        if m:
            k=m.group(1).lower(); prim=(k=='a')
            st=('background:#2563eb;color:#ffffff;border:2px solid #2563eb' if prim else 'background:#ffffff;color:#2563eb;border:2px solid #2563eb')
            parts.append('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px"><tr><td><a href="{{lien_choix_'+k+'}}" style="display:block;'+st+';border-radius:12px;padding:15px 20px;font-size:16px;font-weight:700;text-decoration:none;text-align:center">'+html.escape(m.group(2), quote=False)+' →</a></td></tr></table>')
            txt.append('→ '+m.group(2)+' : {{lien_choix_'+k+'}}'); continue
        m=re.match(r'^\[\[ (.*?) \]\]$', l)
        if m:
            parts.append('<p style="margin:0 0 18px"><a href="'+BOOK+'" style="color:#2563eb;font-weight:600;text-decoration:underline">'+html.escape(m.group(1), quote=False)+' →</a></p>'); txt.append(m.group(1)+' : '+BOOK); continue
        m=re.match(r'^\[ (.*?) \](?:\((https?://[^)]+)\))?$', l)
        if m:
            url=m.group(2) or BOOK
            parts.append('<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 22px"><tr><td style="background:#2563eb;border-radius:10px"><a href="'+html.escape(url)+'" style="display:inline-block;padding:14px 26px;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none">'+html.escape(m.group(1), quote=False)+'</a></td></tr></table>'); txt.append(m.group(1)+' : '+url); continue
        if l=='Adrien & Emily':
            parts.append('<p style="margin:24px 0 0">À très vite,<br><strong>Adrien &amp; Emily</strong></p>'); txt.append('À très vite,\nAdrien & Emily'); continue
        if l.startswith('P.S. '):
            parts.append('<p style="margin:22px 0 0;padding-top:16px;border-top:1px solid #e5e7eb;font-size:15px;line-height:1.65;color:#4b5563"><strong style="color:#1f2937">P.S.</strong> '+inline(l[5:])+'</p>'); txt.append(plain(l)); continue
        if re.match(r'^\*\*[^*]+\*\*$', l):
            parts.append('<p style="margin:24px 0 10px;font-size:17px;font-weight:700;color:#111827">'+inline(l[2:-2])+'</p>'); txt.append(plain(l).upper()); continue
        parts.append('<p style="margin:0 0 16px">'+inline(l)+'</p>'); txt.append(plain(l))
    flush()
    return ''.join(parts), '\n\n'.join(txt)
def page(titre, pre, body):
    return ('<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>'+html.escape(titre)+'</title></head>'
     '<body style="margin:0;padding:0;background:#f3f4f8"><div style="display:none;max-height:0;overflow:hidden;opacity:0">'+html.escape(pre)+'</div>'
     '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f8;padding:28px 12px"><tr><td align="center">'
     '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;font-family:Helvetica,Arial,sans-serif">'
     '<tr><td style="background:#1e3a8a;background-image:linear-gradient(135deg,#1e3a8a 0%,#3b82f6 100%);border-radius:18px 18px 0 0;padding:22px 36px"><div style="font-size:12px;font-weight:700;color:#c7d2fe;letter-spacing:2.5px;text-transform:uppercase">Adrien &amp; Emily</div></td></tr>'
     '<tr><td style="background:#ffffff;padding:32px 36px 30px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb"><div style="font-size:16px;line-height:1.7;color:#1f2937">'+body+'</div></td></tr>'
     '<tr><td style="background:#f9fafb;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 18px 18px;padding:18px 36px;text-align:center"><div style="font-size:12px;color:#9ca3af;line-height:1.6">Adrien &amp; Emily · Accompagnement des dirigeants · <a href="https://www.adrienemily.com" style="color:#3b82f6;text-decoration:none">adrienemily.com</a><br><a href="{{lien_desinscription}}" style="color:#9ca3af">Se désinscrire</a></div></td></tr>'
     '</table></td></tr></table></body></html>')
out={}
FREINS={}
for sec in re.split(r'\n## (?=\d\. )', s)[1:]:
    if sec.startswith('0. '):
        for m in re.finditer(r'\n\*\*\[([a-z_]+)\] (E1|E5) : (.+?)\*\*\n\*Pré-en-tête : (.+?)\*\n((?:\n?>.*)+)', sec):
            quote=[re.sub(r'^> ?','',l) for l in m.group(5).split('\n') if l.startswith('>')]
            body,txt=render(quote)
            FREINS.setdefault(m.group(1),{})[m.group(2)]={'subject':m.group(3).strip(),'preheader':m.group(4).strip(),'html':page(m.group(3).strip(),m.group(4).strip(),body),'text':txt+'\n\n--\nAdrien & Emily · adrienemily.com\nSe désinscrire : {{lien_desinscription}}\n'}
            print(m.group(1),m.group(2),len(re.findall(r'\w+',txt)),'mots')
        continue
    key=re.search(r'\(`([a-z]+)`\)', sec.split('\n',1)[0]).group(1)
    cit=re.search(r'\nCitation : « (.+?) »', sec).group(1)
    heros=re.search(r'\nHéros : (.+)', sec).group(1).strip()
    ems={}
    PIED='\n\n--\nAdrien & Emily · adrienemily.com\nSe désinscrire : {{lien_desinscription}}\n'
    # Paragraphe final de l'étape 4, selon la dernière réponse (C4N = sans réponse).
    fins={}
    for m in re.finditer(r'\n\*\*(C4[A-CN])\*\*\n(?:\*Bouton : (.+?)\*\n)?((?:\n?>.*)+)', sec):
        fins[m.group(1)]={'bouton':(m.group(2) or '').strip() or None,'lignes':[re.sub(r'^> ?','',l) for l in m.group(3).split('\n') if l.startswith('>')]}
    assert sorted(fins)==['C4A','C4B','C4C','C4N'],(key,sorted(fins))
    assert all(fins[c]['bouton'] for c in ('C4A','C4B','C4C')) and not fins['C4N']['bouton'],(key,'boutons C4')
    def email(code,sujet,pre,bouton,question,quote,etape):
        body,txt=render(quote)
        return {'etape':etape,'bouton':bouton,'question':question,'subject':sujet,'preheader':pre,'html':page(sujet,pre,body),'text':txt+PIED}
    for m in re.finditer(r'\n\*\*(C\d[A-C]?) : (.+?)\*\*\n\*Pré-en-tête : (.+?)\*\n(?:\*Bouton : (.+?)\*\n)?(?:\*Question : (.+?)\*\n)?((?:\n?>.*)+)', sec):
        code=m.group(1); sujet=m.group(2).strip(); pre=m.group(3).strip()
        bouton=(m.group(4) or '').strip() or None; question=(m.group(5) or '').strip() or None
        quote=[re.sub(r'^> ?','',l) for l in m.group(6).split('\n') if l.startswith('>')]
        assert sum(l=='{{choix}}' for l in quote)==1,(key,code,'choix')
        if code=='C1':
            assert sum(('« '+cit) in l for l in quote)==1,(key,'citation')
            quote=[('>> « {{douleur_citation}}. »' if ('« '+cit) in l else l) for l in quote]
            assert question and not bouton and '{{ouverture}}' not in quote,(key,code)
            ems[code]=email(code,sujet,pre,None,question,quote,1)
        elif code=='C4':
            # Un seul texte, décliné par dernière réponse : C4A, C4B, C4C, C4N.
            assert sum(l=='{{recap}}' for l in quote)<=1 and sum(l=='{{fin}}' for l in quote)==1 and not question and not bouton,(key,code)
            for f in sorted(fins):
                q2=[]
                for l in quote: q2.extend(fins[f]['lignes'] if l=='{{fin}}' else [l])
                ems[f]=email(f,sujet,pre,fins[f]['bouton'],None,q2,4)
        else:
            assert re.match(r'^C[23][A-C]$',code) and bouton and question and sum(l=='{{ouverture}}' for l in quote)==1,(key,code)
            ems[code]=email(code,sujet,pre,bouton,question,quote,int(code[1]))
        print(key,code,len(re.findall(r'\w+',ems.get(code,ems.get('C4N'))['text'])),'mots')
    assert sorted(ems)==['C1','C2A','C2B','C2C','C3A','C3B','C3C','C4A','C4B','C4C','C4N'],(key,sorted(ems))
    # Le graphe : les trois réponses proposées à la fin de chaque texte, et la
    # suite envoyée sans clic (`defaut`).
    ems['C1']['suite']=['C2A','C2B','C2C']; ems['C1']['defaut']='C2A'
    for c in ('C2A','C2B','C2C'): ems[c]['suite']=['C3A','C3B','C3C']; ems[c]['defaut']='C3A'
    for c in ('C3A','C3B','C3C'): ems[c]['suite']=['C4A','C4B','C4C']; ems[c]['defaut']='C4N'
    for c in ('C4A','C4B','C4C','C4N'): ems[c]['suite']=[]; ems[c]['defaut']=None
    b9=[ems[c]['bouton'] for c in ems if ems[c]['bouton']]
    assert len(b9)==9 and all(len(x)<=75 for x in b9),(key,[x for x in b9 if len(x)>75])
    out[key]={'citation':cit,'heros':heros,'de':("d'" if heros[0] in 'AEIOUYÉH' else 'de ')+heros,'chapitres':ems}
assert sorted(out)==['equipe','operationnel','plafond','rentabilite','vie']
assert sorted(FREINS)==['frein_decision','frein_general','frein_preuves','frein_priorite','frein_timing','frein_tresorerie'] and all(sorted(v)==['E1','E5'] for v in FREINS.values()),FREINS.keys()
if LOCAL:
    pass
else:
    json.dump({'douleurs':out,'freins':FREINS},open(ROOT+'api/_parcoursChoixData.json','w'),ensure_ascii=False,indent=1)
print('ok')
