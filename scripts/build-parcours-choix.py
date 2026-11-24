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
        m=re.match(r'^\{\{(m_[a-z0-9_]+)\}\}$', l)
        if m:  # phrase miroir : ligne entière, retirée si vide (marqueurs lus par le moteur)
            parts.append('<!--M:'+m.group(1)+'--><p style="margin:0 0 16px;padding:10px 14px;background:#fffbeb;border-radius:10px;color:#92400e">{{'+m.group(1)+'}}</p><!--/M-->'); txt.append('{{'+m.group(1)+'}}'); continue
        m=re.match(r'^!\[(.*?)\]\((.+?)\)(?:\((https?://[^)]+)\))?$', l)
        if m:
            im='<img src="'+IMG+m.group(2)+'" alt="'+html.escape(m.group(1))+'" width="528" style="display:block;width:100%;max-width:528px;height:auto;border:0;border-radius:12px">'
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
for sec in re.split(r'\n## (?=\d\. )', s)[1:]:
    key=re.search(r'\(`([a-z]+)`\)', sec.split('\n',1)[0]).group(1)
    cit=re.search(r'\nCitation : « (.+?) »', sec).group(1)
    ems={}
    for m in re.finditer(r'\n\*\*(E\d[AB]?) : (.+?)\*\*\n\*Pré-en-tête : (.+?)\*\n((?:\n?>.*)+)', sec):
        quote=[re.sub(r'^> ?','',l) for l in m.group(4).split('\n') if l.startswith('>')]
        if m.group(1)=='E2':
            assert sum(('« '+cit) in l for l in quote)==1,(key,'citation')
            quote=[('>> « {{douleur_citation}}. »' if ('« '+cit) in l else l) for l in quote]
        body,txt=render(quote)
        ems[m.group(1)]={'subject':m.group(2).strip(),'preheader':m.group(3).strip(),'html':page(m.group(2).strip(),m.group(3).strip(),body),'text':txt+'\n\n--\nAdrien & Emily · adrienemily.com\nSe désinscrire : {{lien_desinscription}}\n'}
        w=len(re.findall(r'\w+',txt)); print(key,m.group(1),w,'mots')
    assert sorted(ems)==['E2','E3A','E3B','E4'],(key,sorted(ems))
    out[key]={'citation':cit,'emails':ems}
assert sorted(out)==['equipe','operationnel','plafond','rentabilite','vie']
if LOCAL:
    V=(sys.argv[2] if len(sys.argv)>2 else '/tmp/')+'/'
    ex={'m_marge':"Vous nous avez dit ne pas connaître précisément la marge de chacune de vos offres.",'m_sommeil':"Vous nous avez aussi dit qu'il vous arrive de mal dormir en pensant à la trésorerie des semaines à venir.",'m_duree':"Cela dure depuis plus de trois ans.",'m_rythme':"Et quand nous vous avons demandé comment vous viviez ce rythme, vous avez répondu : « C'est tendu, mais je tiens. »",'m_consignes':"Vous nous avez dit avoir l'impression de répéter les mêmes consignes, encore et encore.",'m_autonome':"Vous nous avez dit qu'un nouveau salarié ne devient pas autonome sans que vous le formiez vous-même.",'m_tente':"Vous avez déjà essayé de déléguer, avant de tout reprendre vous-même."}
    for k,e in [('rentabilite','E2'),('vie','E3B'),('equipe','E2')]:
        h=out[k]['emails'][e]['html'].replace('%FIRSTNAME%','Adrien')
        def rm(m):
            return m.group(2).replace('{{'+m.group(1)+'}}',ex[m.group(1)]) if m.group(1) in ex else ''
        h=re.sub(r'<!--M:(m_[a-z0-9_]+)-->(.*?)<!--/M-->',rm,h)
        open(V+k+'_'+e+'.html','w').write(h)
else:
    json.dump(out,open(ROOT+'api/_parcoursChoixData.json','w'),ensure_ascii=False,indent=1)
print('ok')
