# Met à jour api/_acSequencesData.json (HTML + texte des e-mails par frein et
# « rendez-vous manqué ») depuis docs/parcours-rdv/sequences-freins.md.
# Les objets ne changent pas (ils identifient chaque e-mail).
#   python3 scripts/build-sequences-freins.py
import re, json, html, sys
import os
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))+'/'
DOC=ROOT+'docs/parcours-rdv/sequences-freins.md'
s=open(DOC).read()
BOOK='https://team.alteore.com/booking.html?type=call_strat_phenix_all&utm_source=activecampaign&utm_medium=email&utm_campaign='
def inline(t):
    t=html.escape(t, quote=False)
    t=re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', t)
    return t
def plain(t): return re.sub(r'\*\*(.+?)\*\*', r'\1', t)
def render(lines, tag):
    parts=[]; txt=[]; ul=[]; ol=[]
    def flush():
        nonlocal ul, ol
        if ul:
            parts.append('<ul style="margin:0 0 18px;padding-left:22px">'+''.join('<li style="margin:0 0 8px">'+inline(x)+'</li>' for x in ul)+'</ul>')
            txt.append('\n'.join('- '+plain(x) for x in ul)); ul=[]
        if ol:
            parts.append('<ol style="margin:0 0 18px;padding-left:22px">'+''.join('<li style="margin:0 0 10px">'+inline(x)+'</li>' for x in ol)+'</ol>')
            txt.append('\n'.join('%d. %s'%(k+1,plain(x)) for k,x in enumerate(ol))); ol=[]
    for l in lines:
        l=l.rstrip()
        if not l.strip(): flush(); continue
        if l.startswith('- '): ul.append(l[2:]); continue
        m=re.match(r'\d\. (.*)', l)
        if m: ol.append(m.group(1)); continue
        flush()
        if l.startswith('>> '):
            c=l[3:]
            parts.append('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 20px"><tr><td style="background:#eff4ff;border-left:4px solid #2563eb;border-radius:0 10px 10px 0;padding:14px 18px;font-size:17px;line-height:1.55;font-weight:600;color:#1e3a8a">'+inline(c)+'</td></tr></table>')
            txt.append('  '+plain(c)); continue
        mb=re.match(r'^\[\[ (.*?) \]\]$', l)
        if mb:
            parts.append('<p style="margin:0 0 18px"><a href="'+html.escape(BOOK+tag)+'" style="color:#2563eb;font-weight:600;text-decoration:underline">'+html.escape(mb.group(1), quote=False)+' →</a></p>')
            txt.append(mb.group(1)+' : '+BOOK+tag); continue
        mb=re.match(r'^\[ (.*?) \](?:\((https?://[^)]+)\))?$', l)
        if mb:
            lab=mb.group(1); url=mb.group(2) or (BOOK+tag)
            parts.append('<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 22px"><tr><td style="background:#2563eb;border-radius:10px"><a href="'+html.escape(url)+'" style="display:inline-block;padding:14px 26px;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none">'+html.escape(lab, quote=False)+'</a></td></tr></table>')
            txt.append(lab+' : '+url); continue
        if l=='Adrien & Emily':
            parts.append('<p style="margin:24px 0 0">À très vite,<br><strong>Adrien &amp; Emily</strong></p>'); txt.append('À très vite,\nAdrien & Emily'); continue
        if l.startswith('P.S. '):
            parts.append('<p style="margin:22px 0 0;padding-top:16px;border-top:1px solid #e5e7eb;font-size:15px;line-height:1.65;color:#4b5563"><strong style="color:#1f2937">P.S.</strong> '+inline(l[5:])+'</p>'); txt.append(plain(l)); continue
        if re.match(r'^\*\*[^*]+\*\*$', l):
            parts.append('<p style="margin:24px 0 10px;font-size:17px;font-weight:700;color:#111827">'+inline(l[2:-2])+'</p>'); txt.append(plain(l).upper() if len(l)<60 else plain(l)); continue
        parts.append('<p style="margin:0 0 16px">'+inline(l)+'</p>'); txt.append(plain(l))
    flush()
    return ''.join(parts), '\n\n'.join(txt)
def page(titre, pre, body):
    return ('<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>'+html.escape(titre)+'</title></head>'
     '<body style="margin:0;padding:0;background:#f3f4f8">'
     '<div style="display:none;max-height:0;overflow:hidden;opacity:0">'+html.escape(pre)+'</div>'
     '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f8;padding:28px 12px"><tr><td align="center">'
     '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;font-family:Helvetica,Arial,sans-serif">'
     '<tr><td style="background:#1e3a8a;background-image:linear-gradient(135deg,#1e3a8a 0%,#3b82f6 100%);border-radius:18px 18px 0 0;padding:22px 36px"><div style="font-size:12px;font-weight:700;color:#c7d2fe;letter-spacing:2.5px;text-transform:uppercase">Adrien &amp; Emily</div></td></tr>'
     '<tr><td style="background:#ffffff;padding:32px 36px 30px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb"><div style="font-size:16px;line-height:1.7;color:#1f2937">'+body+'</div></td></tr>'
     '<tr><td style="background:#f9fafb;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 18px 18px;padding:18px 36px;text-align:center"><div style="font-size:12px;color:#9ca3af;line-height:1.6">Adrien &amp; Emily · Accompagnement des dirigeants · <a href="https://www.adrienemily.com" style="color:#3b82f6;text-decoration:none">adrienemily.com</a><br><a href="%UNSUBSCRIBELINK%" style="color:#9ca3af">Se désinscrire</a></div></td></tr>'
     '</table></td></tr></table></body></html>')
secs=re.split(r'\n## (?=\d\. )', s)
out={}
for sec in secs[1:]:
    tag=re.search(r'\(`([a-z_]+)`\)', sec.split('\n',1)[0]).group(1)
    emails=re.split(r'\n\*\*E(\d) \(J\+\d+\)', sec); lst=[]
    for k in range(1,len(emails),2):
        n=int(emails[k]); chunk=emails[k+1]
        mm=re.match(r'\s*:\s*(.+?)\*\*', chunk)
        if not mm:
            ref=re.search(r'reprend \*\*E(\d)', chunk); lst.append({'n':n,'ref':int(ref.group(1))}); continue
        pm=re.search(r'\n\*Pré-en-tête : (.+?)\*\n', chunk)
        quote=[re.sub(r'^> ?','',l) for l in chunk.split('\n') if l.startswith('>')]
        lst.append({'n':n,'subject':mm.group(1).strip(),'preheader':pm.group(1) if pm else '','quote':quote})
    out[tag]=lst
for tag,lst in out.items():
    for k,e in enumerate(lst):
        if 'ref' in e:
            src=[x for x in out['frein_priorite'] if x['n']==e['ref']][0]; lst[k]=dict(src,n=e['n'])
P=ROOT+'api/_acSequencesData.json'
data=json.load(open(P)); n=0
for m in data:
    e=[x for x in out[m['tag']] if x['n']==m['n']]
    assert len(e)==1,(m['tag'],m['n'])
    e=e[0]
    assert e['subject']==m['subject'],(m['tag'],m['n'],e['subject'],m['subject'])
    body,txt=render(e['quote'],m['tag'])
    m['preheader']=e['preheader']; m['html']=page(e['subject'],e['preheader'],body)
    m['text']=txt+'\n\n--\nAdrien & Emily · adrienemily.com\nSe désinscrire : %UNSUBSCRIBELINK%\n'
    n+=1
    words=len(re.findall(r'\w+',txt)); 
    if words<90 or words>270: print('longueur',m['tag'],m['n'],words)
assert n==32 and sum(len(v) for v in out.values())==32
json.dump(data,open(P,'w'),ensure_ascii=False,indent=1)
print('ok',n)
