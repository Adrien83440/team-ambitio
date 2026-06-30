/* ═══════════════════════════════════════════
   CRM Pipeline v3 — Ambitio Corp
   sales-crm-app.js
   ═══════════════════════════════════════════ */
var db = firebase.firestore();

/* ═══ CONFIG ═══ */
var STAGES=[
  {key:'lead',label:'Lead',color:'#34d399',section:'Prospection'},
  {key:'nrp1',label:'NRP 1',color:'#f59e0b',section:'Prospection'},
  {key:'nrp2',label:'NRP 2',color:'#e67e22',section:'Prospection'},
  {key:'nrp3',label:'NRP 3',color:'#ef4444',section:'Prospection'},
  {key:'all_nrp',label:'All NRP',color:'#6b7280',section:'Prospection'},
  {key:'faux_numero',label:'Faux numéro',color:'#64748b',section:'Prospection'},
  {key:'poubelle',label:'Poubelle',color:'#374151',section:'Prospection'},
  {key:'disqualification',label:'Disqualification',color:'#6b7280',section:'Prospection'},
  {key:'follow_up_pm',label:'Follow Up (PM)',color:'#60a5fa',section:'Prospection'},
  {key:'set',label:'SET',color:'#a78bfa',section:'Prospection'},
  {key:'rdv_self_booking',label:'RDV Self Booking',color:'#fbbf24',section:'Prospection'},
  {key:'rdv_confirmes',label:'RDV confirmés',color:'#34d399',section:'Closing'},
  {key:'rdv_annules_prospect',label:'RDV annulés Prospect',color:'#ef4444',section:'Closing'},
  {key:'rdv_annules_equipe',label:'RDV annulés Équipe',color:'#f87171',section:'Closing'},
  {key:'no_show_self',label:'No Show Self Booking',color:'#f59e0b',section:'Closing'},
  {key:'no_show_setting',label:'No Show Setting',color:'#e67e22',section:'Closing'},
  {key:'partenariats',label:'Partenariats',color:'#8b5cf6',section:'Closing'},
  {key:'closed_won_setting',label:'Closed Won Setting',color:'#10b981',section:'Closing'},
  {key:'closed_won_self',label:'Closed Won Self B.',color:'#059669',section:'Closing'},
  {key:'closed_lost',label:'Closed Lost',color:'#ef4444',section:'Closing'},
  {key:'follow_up_closing',label:'Follow-Up',color:'#60a5fa',section:'Closing'},
  {key:'disqualifie_closing',label:'Disqualifié',color:'#6b7280',section:'Closing'}
];
var SM={};STAGES.forEach(function(s){SM[s.key]=s;});
var LT={vsl_elite:'VSL',self_booking:'Self Booking',webinaire:'Webinaire'};
var TB={vsl_elite:'vsl',self_booking:'self',webinaire:'other'};
var S2S={lead:'nouveau',nrp1:'nrp1',nrp2:'nrp2',nrp3:'nrp3',all_nrp:'all_nrp',faux_numero:'faux_numero',poubelle:'poubelle',disqualification:'disqualifie',follow_up_pm:'follow_up_pm',set:'set',rdv_self_booking:'rdv_self_booking',rdv_confirmes:'rdv_pose',rdv_annules_prospect:'pas_interesse',rdv_annules_equipe:'pas_interesse',no_show_self:'pas_interesse',no_show_setting:'pas_interesse',partenariats:'rdv_pose',closed_won_setting:'rdv_pose',closed_won_self:'rdv_pose',closed_lost:'pas_interesse',follow_up_closing:'appele',disqualifie_closing:'disqualifie'};

var CRIT_FIELDS=[
  {key:'stage',label:'Étape',type:'select',opts:STAGES.map(function(s){return{v:s.key,l:s.label};})},
  {key:'assignedTo',label:'Gestionnaire (Setter)',type:'select',opts:[]/* rempli dynamiquement par rebuildTeamDependentConfig() */},
  {key:'type',label:'Origine du Prospect',type:'select',opts:[{v:'vsl_elite',l:'VSL'},{v:'self_booking',l:'Self Booking'},{v:'webinaire',l:'Webinaire'}]},
  {key:'nom',label:'Nom',type:'text'},
  {key:'email',label:'Email',type:'text'},
  {key:'telephone',label:'Portable',type:'text'},
  {key:'utm',label:'Source / UTM',type:'text'},
  {key:'secteur',label:'Secteur',type:'text'},
  {key:'status',label:'Statut Leads Live',type:'text'}
];
var CRIT_OPS_TEXT=[{v:'contains',l:'Contient'},{v:'eq',l:'Est'},{v:'neq',l:"N'est pas"},{v:'empty',l:'Est vide'},{v:'notempty',l:"N'est pas vide"}];
var CRIT_OPS_SELECT=[{v:'eq',l:'Est'},{v:'neq',l:"N'est pas"}];

/* ═══ TEAM MEMBERS HELPERS ═══
   Source de vérité : window.TEAM_MEMBERS_LIST (chargé via nav.js).
   Ces helpers évitent les hardcodes 'guillaume'/'elodie' dans le reste du fichier. */
function tmList(){return window.TEAM_MEMBERS_LIST||[];}
function tmActive(){return window.TEAM_MEMBERS_ACTIVE||[];}
function tmGet(slug){
  if(!slug)return null;
  if(window.TEAM_MEMBERS&&window.TEAM_MEMBERS[slug])return window.TEAM_MEMBERS[slug];
  return null;
}
function tmName(slug){var m=tmGet(slug);return m?(m.shortName||m.displayName||slug):(slug||'');}
function tmFullName(slug){var m=tmGet(slug);return m?(m.displayName||m.shortName||slug):(slug||'');}
function tmColor(slug){var m=tmGet(slug);return m?(m.color||'#6b7280'):'#6b7280';}
function tmIsActive(slug){var m=tmGet(slug);return m?(m.active!==false):false;}

/* Helper hex → "r,g,b" pour styles inline */
function hexToRgbCrm(hex){
  var s=(hex||'').replace('#','');
  if(s.length===3)s=s[0]+s[0]+s[1]+s[1]+s[2]+s[2];
  if(s.length!==6)return '107,114,128';
  var n=parseInt(s,16);
  return ((n>>16)&255)+','+((n>>8)&255)+','+(n&255);
}

/* Génère les <option> d'un dropdown d'assignation. fullName=true affiche
   displayName, false affiche shortName. Inclut les inactifs en grisé. */
function buildAssignOptionsCrm(currentSlug,fullName){
  var html='';
  var list=tmList();
  var actives=list.filter(function(m){return m.active!==false;});
  var inactives=list.filter(function(m){return m.active===false;});
  for(var i=0;i<actives.length;i++){
    var m=actives[i];
    var label=fullName?(m.displayName||m.shortName||m.slug):(m.shortName||m.slug);
    html+='<option value="'+m.slug+'"'+(currentSlug===m.slug?' selected':'')+'>'+esc(label)+'</option>';
  }
  for(var j=0;j<inactives.length;j++){
    var m2=inactives[j];
    var isCur=currentSlug===m2.slug;
    var label2=fullName?(m2.displayName||m2.shortName||m2.slug):(m2.shortName||m2.slug);
    html+='<option value="'+m2.slug+'"'+(isCur?' selected':'')+(isCur?'':' disabled')+'>🔒 '+esc(label2)+' (inactif)</option>';
  }
  return html;
}

/* Recompose CRIT_FIELDS et DEFAULT_VIEWS dynamiquement à partir des membres
   chargés. Appelé au démarrage et à chaque rechargement de TEAM_MEMBERS. */
function rebuildTeamDependentConfig(){
  // CRIT_FIELDS : option assignedTo dynamique (tous les membres, actifs + inactifs)
  for(var i=0;i<CRIT_FIELDS.length;i++){
    if(CRIT_FIELDS[i].key==='assignedTo'){
      var opts=tmList().map(function(m){
        var label=m.displayName||m.shortName||m.slug;
        if(m.active===false)label='🔒 '+label+' (inactif)';
        return {v:m.slug,l:label};
      });
      CRIT_FIELDS[i].opts=opts;
      break;
    }
  }
  // DEFAULT_VIEWS : retire les anciennes vues hardcodées par membre et regénère
  DEFAULT_VIEWS=DEFAULT_VIEWS.filter(function(v){return !v._teamMemberView;});
  tmActive().forEach(function(m){
    DEFAULT_VIEWS.push({
      id:'__'+m.slug+'__',
      name:m.shortName||m.slug,
      icon:'⭐',
      criteria:[{field:'assignedTo',op:'eq',value:m.slug}],
      _teamMemberView:true
    });
  });
}

/* ═══ STATE ═══ */
var allLeads=[],filterSetter='all',filterSection='all',filterType='all',searchQuery='',draggedLeadId=null;
var archiveMode='recent'; /* 'recent' = ≤6 months, 'old' = >6 months */
var currentView='pipeline',listSortKey='createdAt',listSortDir='desc';
var pageSize=50,currentPage=1,selectedIds={};
var savedViews=[],activeViewId='__all__';
/* ── Column card limits (perf mobile) ── */
var isMobile=window.innerWidth<=768;
var COL_CARD_LIMIT=isMobile?15:30;
var COL_CARD_STEP=isMobile?15:30;
var colCardLimits={};
var crmDataLoaded=false;
var savedViews=[],activeViewId='__all__';
var DEFAULT_VIEWS=[
  {id:'__all__',name:'Toutes les Affaires',icon:'📋',criteria:[]},
  {id:'__prospection__',name:'Prospection',icon:'📞',criteria:[{field:'stage',op:'eq',value:STAGES.filter(function(s){return s.section==='Prospection';}).map(function(s){return s.key;}).join(',')}]},
  {id:'__closing__',name:'Closing',icon:'🤝',criteria:[{field:'stage',op:'eq',value:STAGES.filter(function(s){return s.section==='Closing';}).map(function(s){return s.key;}).join(',')}]},
  {id:'__won__',name:'Closed Won',icon:'🏆',criteria:[{field:'stage',op:'eq',value:'closed_won_setting,closed_won_self'}]},
  {id:'__lost__',name:'Closed Lost',icon:'❌',criteria:[{field:'stage',op:'eq',value:'closed_lost'}]},
  {id:'__followup__',name:'Follow-Up',icon:'🔔',criteria:[{field:'stage',op:'eq',value:'follow_up_pm,follow_up_closing'}]},
  {id:'__leads__',name:'Leads récents',icon:'✨',criteria:[{field:'stage',op:'eq',value:'lead'}]}
  /* Les vues par membre sont injectées dynamiquement par rebuildTeamDependentConfig() */
];

/* ═══ UTILS ═══ */
function toast(m){var t=document.getElementById('crmToast');t.textContent=m;t.classList.add('show');setTimeout(function(){t.classList.remove('show');},2200);}
function esc(s){if(!s)return'';var d=document.createElement('div');d.textContent=s;return d.innerHTML;}
function escA(s){if(!s)return'';return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');}
function decodeUtm(v){if(v==null)return v;var s=String(v);if(s.indexOf('%')===-1)return s;try{return decodeURIComponent(s);}catch(e){return s.replace(/(?:%[0-9A-Fa-f]{2})+/g,function(m){try{return decodeURIComponent(m);}catch(_){return m;}});}}
function fmtNow(){var d=new Date();return String(d.getDate()).padStart(2,'0')+'/'+String(d.getMonth()+1).padStart(2,'0')+'/'+d.getFullYear()+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');}
function fmtDate(ts){if(!ts)return'—';var d;if(ts instanceof Date)d=ts;else if(ts.toDate)d=ts.toDate();else if(typeof ts==='string'){d=new Date(ts.replace(' ','T'));if(isNaN(d.getTime()))return'—';}else d=new Date(ts);return String(d.getDate()).padStart(2,'0')+'/'+String(d.getMonth()+1).padStart(2,'0')+'/'+d.getFullYear();}

/* ═══ FILTERING ═══ */
function applyCriteria(list,criteria){
  if(!criteria||!criteria.length)return list;
  criteria.forEach(function(c){
    if(!c.field||!c.op)return;
    list=list.filter(function(l){
      var val=(l[c.field]||'').toString().toLowerCase();
      var cv=(c.value||'').toLowerCase();
      if(c.op==='eq'){var vs=cv.split(',').map(function(v){return v.trim();});return vs.indexOf(val)>=0;}
      if(c.op==='neq'){var ns=cv.split(',').map(function(v){return v.trim();});return ns.indexOf(val)<0;}
      if(c.op==='contains')return val.indexOf(cv)>=0;
      if(c.op==='empty')return !val;
      if(c.op==='notempty')return !!val;
      return true;
    });
  });
  return list;
}

function getFiltered(){
  var list=allLeads.slice();
  var view=getActiveView();
  if(view&&view.criteria)list=applyCriteria(list,view.criteria);
  if(filterSetter!=='all')list=list.filter(function(l){return l.assignedTo===filterSetter;});
  if(filterSection!=='all'){var ss=STAGES.filter(function(s){return s.section===filterSection;}).map(function(s){return s.key;});list=list.filter(function(l){return ss.indexOf(l.stage||'lead')>=0;});}
  if(searchQuery){var q=searchQuery.toLowerCase();list=list.filter(function(l){return((l.nom||'')+' '+(l.telephone||'')+' '+(l.email||'')).toLowerCase().indexOf(q)>=0;});}
  // Date filter
  if(filterDateRange!=='all'){
    if(filterDateRange==='custom'){
      if(filterDateFrom)list=list.filter(function(l){var d=getLeadDate(l);return d&&d>=filterDateFrom;});
      if(filterDateTo)list=list.filter(function(l){var d=getLeadDate(l);return d&&d<=filterDateTo;});
    } else {
      var threshold=getDateThreshold(filterDateRange);
      if(threshold)list=list.filter(function(l){var d=getLeadDate(l);return d&&d>=threshold;});
    }
  }
  // Tag filter
  if(filterTags.length>0){
    list=list.filter(function(l){
      var allT=[];
      if(l.tags&&Array.isArray(l.tags))l.tags.forEach(function(t){allT.push((t||'').toLowerCase());});
      if(l.tagsWebi&&typeof l.tagsWebi==='string')l.tagsWebi.split(',').forEach(function(t){allT.push(t.trim().toLowerCase());});
      for(var i=0;i<filterTags.length;i++){if(allT.indexOf(filterTags[i].toLowerCase())>=0)return true;}
      return false;
    });
  }
  // Type filter
  if(filterType!=='all'){list=list.filter(function(l){return(l.type||'')===filterType;});}
  return list;
}

function getActiveView(){
  for(var i=0;i<DEFAULT_VIEWS.length;i++){if(DEFAULT_VIEWS[i].id===activeViewId)return DEFAULT_VIEWS[i];}
  for(var j=0;j<savedViews.length;j++){if(savedViews[j].id===activeViewId)return savedViews[j];}
  return DEFAULT_VIEWS[0];
}
function getPaginated(list){var s=(currentPage-1)*pageSize;return list.slice(s,s+pageSize);}
function getTotalPages(list){return Math.max(1,Math.ceil(list.length/pageSize));}

/* ═══ SELECTION ═══ */
function getSelectedCount(){var n=0;for(var k in selectedIds){if(selectedIds[k])n++;}return n;}
function clearSelection(){selectedIds={};updateBulkBar();}
function updateBulkBar(){
  var n=getSelectedCount();var bar=document.getElementById('bulkBar');
  if(n>0){bar.classList.add('show');document.getElementById('bulkCount').textContent=n+' sélectionné'+(n>1?'s':'');}
  else{bar.classList.remove('show');}
}

/* ═══ BUILD ═══ */
function buildBoard(){
  var board=document.getElementById('crmBoard');var h='';
  STAGES.forEach(function(st){
    h+='<div class="crm-col" data-stage="'+st.key+'">';
    h+='<div class="crm-col-head" style="position:relative">';
    h+='<div class="crm-col-head-top">';
    h+='<span class="crm-col-dot" style="background:'+st.color+'"></span>';
    h+='<span class="crm-col-title" title="'+escA(st.label)+'">'+esc(st.label)+'</span>';
    h+='<span class="crm-col-count" data-count="'+st.key+'">0</span>';
    h+='<button class="crm-col-sort" data-colsort="'+st.key+'" title="Trier">↕</button>';
    h+='</div>';
    h+='<div class="col-sort-dd" data-colsortdd="'+st.key+'">';
    h+='<div class="col-sort-item" data-csort="nom_asc" data-cstage="'+st.key+'">↑ Nom A → Z</div>';
    h+='<div class="col-sort-item" data-csort="nom_desc" data-cstage="'+st.key+'">↓ Nom Z → A</div>';
    h+='<div class="col-sort-item" data-csort="date_asc" data-cstage="'+st.key+'">↑ Date ancien → récent</div>';
    h+='<div class="col-sort-item" data-csort="date_desc" data-cstage="'+st.key+'">↓ Date récent → ancien</div>';
    h+='<div class="col-sort-item" data-csort="none" data-cstage="'+st.key+'">✕ Pas de tri</div>';
    h+='</div>';
    h+='</div>';
    h+='<div class="crm-col-cards" data-drop="'+st.key+'"></div></div>';
  });
  board.innerHTML=h;
}
buildBoard();

/* Per-column sort state */
var colSorts={};

document.getElementById('crmBoard').addEventListener('click',function(e){
  // Load more cards in column
  var loadMore=e.target.closest('[data-loadstage]');
  if(loadMore){
    e.stopPropagation();
    var stKey=loadMore.dataset.loadstage;
    colCardLimits[stKey]=(colCardLimits[stKey]||COL_CARD_LIMIT)+COL_CARD_STEP;
    renderAll();
    return;
  }
  // Toggle sort dropdown
  var sortBtn=e.target.closest('[data-colsort]');
  if(sortBtn){
    e.stopPropagation();
    var stKey=sortBtn.dataset.colsort;
    // Close all other dropdowns
    document.querySelectorAll('.col-sort-dd').forEach(function(dd){dd.classList.remove('open');});
    var dd=document.querySelector('[data-colsortdd="'+stKey+'"]');
    if(dd)dd.classList.toggle('open');
    return;
  }
  // Sort item click
  var sortItem=e.target.closest('[data-csort]');
  if(sortItem){
    e.stopPropagation();
    var stageKey=sortItem.dataset.cstage;
    var sortType=sortItem.dataset.csort;
    if(sortType==='none'){delete colSorts[stageKey];}
    else{colSorts[stageKey]=sortType;}
    // Update active state visually
    var dd2=sortItem.closest('.col-sort-dd');
    if(dd2){dd2.querySelectorAll('.col-sort-item').forEach(function(it){it.classList.remove('active');});sortItem.classList.add('active');dd2.classList.remove('open');}
    // Update sort button indicator
    var btn=document.querySelector('[data-colsort="'+stageKey+'"]');
    if(btn)btn.classList.toggle('has-sort',!!colSorts[stageKey]);
    renderAll();
    return;
  }
  // Close dropdowns when clicking elsewhere on board
  document.querySelectorAll('.col-sort-dd.open').forEach(function(dd){dd.classList.remove('open');});
});
document.addEventListener('click',function(e){if(!e.target.closest('.col-sort-dd')&&!e.target.closest('[data-colsort]'))document.querySelectorAll('.col-sort-dd.open').forEach(function(dd){dd.classList.remove('open');});});

function sortColumnLeads(leads, sortType){
  if(!sortType)return leads;
  return leads.slice().sort(function(a,b){
    if(sortType==='nom_asc'){return(a.nom||'').toLowerCase()<(b.nom||'').toLowerCase()?-1:1;}
    if(sortType==='nom_desc'){return(a.nom||'').toLowerCase()>(b.nom||'').toLowerCase()?-1:1;}
    if(sortType==='date_asc'){var da=getLeadDate(a),db2=getLeadDate(b);return(da?da.getTime():0)-(db2?db2.getTime():0);}
    if(sortType==='date_desc'){var dc=getLeadDate(a),dd=getLeadDate(b);return(dd?dd.getTime():0)-(dc?dc.getTime():0);}
    return 0;
  });
}

var LIST_COLS=[{key:'_cb',label:'',w:'40px'},{key:'nom',label:'Nom',w:'180px'},{key:'telephone',label:'Téléphone',w:'130px'},{key:'email',label:'Email',w:'180px'},{key:'stage',label:'Étape',w:'160px'},{key:'assignedTo',label:'Setter',w:'120px'},{key:'type',label:'Type',w:'100px'},{key:'utm',label:'Source',w:'120px'},{key:'createdAt',label:'Créé le',w:'100px'}];

function buildListHead(){
  var h='';LIST_COLS.forEach(function(col){
    if(col.key==='_cb'){h+='<th style="width:40px;min-width:40px"><input type="checkbox" class="th-cb" id="listCbAll"/></th>';return;}
    var isSorted=listSortKey===col.key;var arrow=isSorted?(listSortDir==='asc'?'▲':'▼'):'▲';
    h+='<th data-sortcol="'+col.key+'" class="'+(isSorted?'sorted':'')+'" style="min-width:'+col.w+'">'+esc(col.label)+'<span class="sort-arrow">'+arrow+'</span></th>';
  });document.getElementById('listHead').innerHTML=h;
}
buildListHead();

var SHEET_COLS=[{key:'_cb',label:'',edit:false},{key:'_num',label:'#',edit:false},{key:'nom',label:'Nom',edit:true},{key:'telephone',label:'Téléphone',edit:true},{key:'email',label:'Email',edit:true},{key:'stage',label:'Étape',edit:'select'},{key:'assignedTo',label:'Setter',edit:'select'},{key:'type',label:'Type',edit:'select'},{key:'utm',label:'Source',edit:true},{key:'secteur',label:'Secteur',edit:true},{key:'ca',label:'CA',edit:true},{key:'defi',label:'Défi',edit:true},{key:'closeur',label:'Closeur',edit:true},{key:'setting',label:'Setting',edit:true}];

function buildSheetHead(){
  var h='';SHEET_COLS.forEach(function(col){
    if(col.key==='_cb'){h+='<th style="width:40px"><input type="checkbox" class="th-cb" id="sheetCbAll"/></th>';return;}
    h+='<th>'+esc(col.label)+'</th>';
  });document.getElementById('sheetHead').innerHTML=h;
}
buildSheetHead();

/* ═══ RENDER ═══ */
function rebuildTypeDD(){
  var types={};
  for(var i=0;i<allLeads.length;i++){var t=allLeads[i].type||'';if(t)types[t]=(types[t]||0)+1;}
  var keys=Object.keys(types).sort();
  var c=document.getElementById('fbTypeDD');
  if(filterType!=='all'&&!types[filterType])filterType='all';
  var h='<div class="fb-dd-item'+(filterType==='all'?' active':'')+'" data-typef="all">Tous</div>';
  for(var j=0;j<keys.length;j++){var k=keys[j];var label=LT[k]||k;h+='<div class="fb-dd-item'+(filterType===k?' active':'')+'" data-typef="'+k+'">'+esc(label)+' <span class="fb-dd-count">'+types[k]+'</span></div>';}
  c.innerHTML=h;
  var trig=document.getElementById('fbTypeTrigger');
  if(filterType!=='all'){var tl=LT[filterType]||filterType;trig.innerHTML=esc(tl)+' <span class="fb-dd-caret">▼</span>';trig.classList.add('has-value');}
  else{trig.innerHTML='📦 Type <span class="fb-dd-caret">▼</span>';trig.classList.remove('has-value');}
}
function renderAll(){
  rebuildTypeDD();
  var leads=getFiltered();updateStats(leads);
  if(currentView==='pipeline')renderPipeline(leads);
  else if(currentView==='list')renderList(leads);
  else if(currentView==='sheet')renderSheet(leads);
  document.getElementById('svTriggerCount').textContent=leads.length;
  updateBulkBar();
}
function updateStats(leads){
  document.getElementById('statTotal').textContent=leads.length;
  document.getElementById('statWon').textContent=leads.filter(function(l){return l.stage==='closed_won_setting'||l.stage==='closed_won_self';}).length;
  document.getElementById('statLost').textContent=leads.filter(function(l){return l.stage==='closed_lost';}).length;
}

function renderPipeline(leads){
  var counts={};STAGES.forEach(function(s){counts[s.key]=0;});
  leads.forEach(function(l){var st=l.stage||'lead';if(counts[st]!==undefined)counts[st]++;});
  STAGES.forEach(function(s){var el=document.querySelector('[data-count="'+s.key+'"]');if(el)el.textContent=counts[s.key];});
  STAGES.forEach(function(s){
    var container=document.querySelector('[data-drop="'+s.key+'"]');var col=container?container.closest('.crm-col'):null;if(!col)return;
    if(filterSection!=='all'&&s.section!==filterSection){col.style.display='none';return;}
    col.style.display='';
    var sl=leads.filter(function(l){return(l.stage||'lead')===s.key;});
    if(colSorts[s.key])sl=sortColumnLeads(sl,colSorts[s.key]);
    var limit=colCardLimits[s.key]||COL_CARD_LIMIT;
    var total=sl.length;
    var visible=sl.slice(0,limit);
    var remaining=total-limit;
    var h='';visible.forEach(function(l){h+=renderCard(l);});
    if(remaining>0){
      h+='<button class="col-load-more" data-loadstage="'+s.key+'">Voir +'+remaining+' leads</button>';
    }
    container.innerHTML=h;
  });
  // Dialer bridge : boutons d'appel + multi-sélection sur le board kanban
  if (window.DialerBridge) {
    try {
      window.DialerBridge.attachButtons('#crmBoard', { cardSelector: '.crm-card' });
      window.DialerBridge.enableMultiSelect('#crmBoard', {
        cardSelector: '.crm-card',
        maxSelection: 5,
        // Kanban : checkbox "toute la colonne" dans le header de chaque colonne
        groupSelector: '.crm-col',
        groupCheckboxTarget: '.crm-col-head-top',
      });
    } catch (e) { console.warn('[DialerBridge] attach failed', e); }
  }
}

function renderCard(l){
  var tk=l.type||'vsl_elite',badge=TB[tk]||'other',tl=LT[tk]||tk;
  var setter=l.assignedTo||'';
  var sl=setter?tmName(setter):'';
  // Classe CSS = slug (la couleur sera appliquée via style inline pour les nouveaux membres)
  var sc=setter||'';
  var setterColor=setter?tmColor(setter):'';
  var setterInactive=setter?!tmIsActive(setter):false;
  var hn=l.notesHistory&&l.notesHistory.length>0;
  var sL={nouveau:'Nouveau',appele:'Appelé',decroche:'Décroché',messagerie:'Msg',nrp1:'NRP1',nrp2:'NRP2',nrp3:'NRP3',all_nrp:'All NRP',faux_numero:'Faux n°',follow_up_pm:'Follow Up PM',set:'SET',rdv_self_booking:'RDV Self',rdv_pose:'RDV posé',pas_interesse:'Pas intéressé',disqualifie:'Disqualifié',poubelle:'Poubelle',client:'Client'};
  var ls=l.status||'nouveau';
  var _telC=(l.telephone||'').toString().replace(/\s/g,'');
  var h='<div class="crm-card" draggable="true" data-id="'+l.id+'" data-lead-id="'+l.id+'" data-phone="'+_telC+'" data-name="'+esc(l.nom||'').replace(/"/g,'&quot;')+'">';
  h+='<span class="crm-card-eye" data-action="quickview" data-id="'+l.id+'">👁</span>';
  h+='<div class="crm-card-name">'+esc(l.nom||'—')+'</div>';
  if(isKanbanFieldVisible('telephone')&&l.telephone)h+='<div class="crm-card-phone">'+esc(l.telephone)+'</div>';
  if(isKanbanFieldVisible('email')&&l.email)h+='<div class="crm-card-phone" style="font-size:11px">'+esc(l.email)+'</div>';
  if(isKanbanFieldVisible('createdAt')){var cd=getLeadDate(l);if(cd)h+='<div class="crm-card-phone" style="font-size:11px;color:var(--subtle-text)">'+fmtDate(cd)+'</div>';}
  h+='<div class="crm-card-bottom">';
  if(isKanbanFieldVisible('type'))h+='<span class="crm-card-badge '+badge+'">'+tl+'</span>';
  if(isKanbanFieldVisible('assignedTo')&&sl){
    var styleAttr='';
    if(setterColor){var rgb=hexToRgbCrm(setterColor);styleAttr='background:rgba('+rgb+',0.10);color:'+setterColor+(setterInactive?';opacity:.55':'');}
    h+='<span class="crm-card-setter" style="'+styleAttr+'">'+(setterInactive?'🔒 ':'')+esc(sl)+'</span>';
  }
  if(isKanbanFieldVisible('status')&&ls!=='nouveau')h+='<span class="crm-card-setter" style="color:var(--blue)">📞 '+(sL[ls]||ls)+'</span>';
  if(isKanbanFieldVisible('utm')&&l.utm)h+='<span class="crm-card-setter" style="color:var(--purple);font-size:9px">🔗 '+esc(decodeUtm(l.utm))+'</span>';
  if(isKanbanFieldVisible('closeur')&&l.closeur)h+='<span class="crm-card-setter" style="color:var(--gold);font-size:9px">🎯 '+esc(l.closeur)+'</span>';
  if(hn)h+='<span class="crm-card-notes-dot"></span>';
  h+='</div>';
  if(isKanbanFieldVisible('tags')&&l.tags&&l.tags.length>0){h+='<div class="crm-card-tags">';l.tags.forEach(function(t){if(t)h+='<span class="crm-card-tag" style="background:'+tagColor(t)+'20;color:'+tagColor(t)+'">'+esc(t)+'</span>';});h+='</div>';}
  h+='</div>';return h;
}

function renderList(leads){
  var sorted=leads.slice().sort(function(a,b){
    var va=a[listSortKey]||'',vb=b[listSortKey]||'';
    if(listSortKey==='createdAt'||listSortKey==='updatedAt'){va=getLeadDate(a);vb=getLeadDate(b);va=va?va.getTime():0;vb=vb?vb.getTime():0;}
    if(listSortKey==='stage'){va=SM[va]?SM[va].label:va;vb=SM[vb]?SM[vb].label:vb;}
    if(typeof va==='string')va=va.toLowerCase();if(typeof vb==='string')vb=vb.toLowerCase();
    if(va<vb)return listSortDir==='asc'?-1:1;if(va>vb)return listSortDir==='asc'?1:-1;return 0;
  });
  var tp=getTotalPages(sorted);if(currentPage>tp)currentPage=tp;
  var page=getPaginated(sorted);
  var h='';page.forEach(function(l){
    var sel=!!selectedIds[l.id];
    var _telL=(l.telephone||'').toString().replace(/\s/g,'');
    h+='<tr data-id="'+l.id+'" data-lead-id="'+l.id+'" data-phone="'+_telL+'" data-name="'+esc(l.nom||'').replace(/"/g,'&quot;')+'"'+(sel?' class="selected"':'')+'>';
    LIST_COLS.forEach(function(col){
      if(col.key==='_cb'){h+='<td style="width:40px" onclick="event.stopPropagation()"><input type="checkbox" class="row-cb" data-cbid="'+l.id+'"'+(sel?' checked':'')+'/></td>';return;}
      var val=l[col.key]||'';
      if(col.key==='nom'){h+='<td style="font-family:var(--fh);font-weight:700">'+esc(val||'—')+'</td>';}
      else if(col.key==='telephone'){h+='<td style="font-family:var(--fm);color:var(--muted)">'+esc(val)+'</td>';}
      else if(col.key==='stage'){var st=SM[val||'lead']||STAGES[0];h+='<td><span class="list-stage-badge" style="background:'+st.color+'14;color:'+st.color+'"><span class="list-stage-dot" style="background:'+st.color+'"></span>'+esc(st.label)+'</span></td>';}
      else if(col.key==='assignedTo'){
        var sl=val?tmName(val):'—';
        var col2=val?tmColor(val):'#6b7280';
        var rgb2=hexToRgbCrm(col2);
        var inactive2=val?!tmIsActive(val):false;
        h+='<td><span class="list-setter-badge" style="background:rgba('+rgb2+',0.10);color:'+col2+(inactive2?';opacity:.55':'')+'">'+(inactive2?'🔒 ':'')+esc(sl)+'</span></td>';
      }
      else if(col.key==='type'){var tl=LT[val]||val,tb=TB[val]||'other';h+='<td><span class="list-type-badge" style="background:'+(tb==='vsl'?'rgba(167,139,250,0.12);color:#c4b5fd':'rgba(245,158,11,0.12);color:#fcd34d')+'">'+tl+'</span></td>';}
      else if(col.key==='createdAt'||col.key==='updatedAt'){h+='<td style="font-family:var(--fm);font-size:11px;color:var(--muted)">'+fmtDate(col.key==='createdAt'?getLeadDate(l):val)+'</td>';}
      else{h+='<td style="color:var(--muted)">'+esc(String(val))+'</td>';}
    });
    h+='</tr>';
  });
  document.getElementById('listBody').innerHTML=h;
  if (window.DialerBridge) {
    try {
      var _lb=document.getElementById('listBody');
      window.DialerBridge.attachButtons(_lb, { cardSelector: 'tr[data-lead-id]' });
      window.DialerBridge.enableMultiSelect(_lb, { cardSelector: 'tr[data-lead-id]', maxSelection: 5 });
    } catch (e) { console.warn('[DialerBridge] attach failed', e); }
  }
  renderPagi('pagiList',sorted.length,tp);
}

function renderSheet(leads){
  var tp=getTotalPages(leads);if(currentPage>tp)currentPage=tp;
  var page=getPaginated(leads),si=(currentPage-1)*pageSize;
  var h='';page.forEach(function(l,idx){
    var sel=!!selectedIds[l.id];
    h+='<tr data-sid="'+l.id+'"'+(sel?' class="selected"':'')+'>';
    SHEET_COLS.forEach(function(col){
      if(col.key==='_cb'){h+='<td style="width:40px;padding:5px 8px;text-align:center"><input type="checkbox" class="row-cb" data-cbid="'+l.id+'"'+(sel?' checked':'')+'/></td>';}
      else if(col.key==='_num'){h+='<td class="sheet-row-num">'+(si+idx+1)+'</td>';}
      else if(col.edit==='select'&&col.key==='stage'){h+='<td><select class="sheet-cell-select" data-sf="stage">';STAGES.forEach(function(s){h+='<option value="'+s.key+'"'+((l.stage||'lead')===s.key?' selected':'')+'>'+esc(s.label)+'</option>';});h+='</select></td>';}
      else if(col.edit==='select'&&col.key==='assignedTo'){h+='<td><select class="sheet-cell-select" data-sf="assignedTo"><option value="">—</option>'+buildAssignOptionsCrm(l.assignedTo)+'</select></td>';}
      else if(col.edit==='select'&&col.key==='type'){h+='<td><select class="sheet-cell-select" data-sf="type"><option value="vsl_elite"'+(l.type==='vsl_elite'?' selected':'')+'>VSL</option><option value="self_booking"'+(l.type==='self_booking'?' selected':'')+'>Self Booking</option></select></td>';}
      else if(col.edit){h+='<td><input class="sheet-cell" data-sf="'+col.key+'" value="'+escA(l[col.key]||'')+'" placeholder="—"/></td>';}
      else{h+='<td style="padding:5px 8px;font-size:11px;color:var(--muted)">'+esc(String(l[col.key]||''))+'</td>';}
    });h+='</tr>';
  });
  document.getElementById('sheetBody').innerHTML=h;
  renderPagi('pagiSheet',leads.length,tp);
}

function renderPagi(elId,total,tp){
  var h='<span class="pagi-info">Nombre total : <b>'+total+'</b></span>';
  h+='<span class="pagi-info" style="margin-left:8px">Par page :</span>';
  h+='<select class="pagi-select" data-pagi-size>';
  [25,50,100].forEach(function(n){h+='<option value="'+n+'"'+(pageSize===n?' selected':'')+'>'+n+'</option>';});
  h+='</select><div class="pagi-nav">';
  h+='<button class="pagi-btn" data-pagi-prev'+(currentPage<=1?' disabled':'')+'>‹</button>';
  h+='<span class="pagi-current">'+currentPage+' / '+tp+'</span>';
  h+='<button class="pagi-btn" data-pagi-next'+(currentPage>=tp?' disabled':'')+'>›</button></div>';
  document.getElementById(elId).innerHTML=h;
}

/* Pagi events */
document.addEventListener('change',function(e){if(e.target.matches('[data-pagi-size]')){pageSize=parseInt(e.target.value);currentPage=1;renderAll();}});
document.addEventListener('click',function(e){
  if(e.target.matches('[data-pagi-prev]')&&!e.target.disabled){currentPage--;renderAll();}
  if(e.target.matches('[data-pagi-next]')&&!e.target.disabled){currentPage++;renderAll();}
});

/* ═══ VIEW SWITCH ═══ */
document.querySelectorAll('.view-btn').forEach(function(btn){
  btn.addEventListener('click',function(){
    document.querySelectorAll('.view-btn').forEach(function(b){b.classList.remove('active');});
    btn.classList.add('active');currentView=btn.dataset.view;
    document.querySelectorAll('.crm-view').forEach(function(v){v.classList.remove('active');});
    var viewId='view'+currentView.charAt(0).toUpperCase()+currentView.slice(1);
    document.getElementById(viewId).classList.add('active');
    currentPage=1;clearSelection();renderAll();
  });
});

/* ═══ SAVED VIEWS ═══ */
function renderSavedViews(filter){
  filter=(filter||'').toLowerCase();
  var hD='<div class="sv-section-label">Par défaut</div>';
  DEFAULT_VIEWS.forEach(function(v){
    if(filter&&v.name.toLowerCase().indexOf(filter)<0)return;
    hD+='<div class="sv-item'+(activeViewId===v.id?' active':'')+'" data-svid="'+v.id+'"><span class="sv-item-icon">'+v.icon+'</span><span class="sv-item-label">'+esc(v.name)+'</span><span class="sv-item-count">'+countViewLeads(v)+'</span></div>';
  });
  document.getElementById('svListDefault').innerHTML=hD;
  var hC='';
  if(savedViews.length>0){
    hC+='<div class="sv-section-label">Mes affichages</div>';
    savedViews.forEach(function(v){
      if(filter&&v.name.toLowerCase().indexOf(filter)<0)return;
      hC+='<div class="sv-item'+(activeViewId===v.id?' active':'')+'" data-svid="'+v.id+'"><span class="sv-item-icon">📌</span><span class="sv-item-label">'+esc(v.name)+'</span><span class="sv-item-count">'+countViewLeads(v)+'</span><button class="sv-item-del" data-svdel="'+v.id+'">✕</button></div>';
    });
  }
  document.getElementById('svListCustom').innerHTML=hC;
}
function countViewLeads(v){var l=allLeads.slice();if(v.criteria)l=applyCriteria(l,v.criteria);return l.length;}
function activateView(vid){
  activeViewId=vid;var v=getActiveView();document.getElementById('svTriggerLabel').textContent=v.name;
  filterSetter='all';filterSection='all';filterType='all';currentPage=1;
  document.querySelectorAll('.crm-filter-pill').forEach(function(p){p.classList.toggle('active',p.dataset.setter==='all');});
  document.querySelectorAll('.crm-section-pill').forEach(function(p){p.classList.toggle('active',p.dataset.section==='all');});
  clearSelection();renderSavedViews();renderAll();closeSvDD();
}
function closeSvDD(){document.getElementById('svDropdown').classList.remove('open');document.getElementById('svTrigger').classList.remove('open');}

document.getElementById('svTrigger').addEventListener('click',function(e){e.stopPropagation();var dd=document.getElementById('svDropdown');var o=dd.classList.toggle('open');this.classList.toggle('open',o);if(o){renderSavedViews();document.getElementById('svSearchInput').value='';document.getElementById('svSearchInput').focus();}});
document.addEventListener('click',function(e){if(!e.target.closest('#svWrapper'))closeSvDD();});
document.getElementById('svSearchInput').addEventListener('input',function(){renderSavedViews(this.value);});
document.getElementById('svDropdown').addEventListener('click',function(e){
  var del=e.target.closest('[data-svdel]');
  if(del){e.stopPropagation();var vid=del.dataset.svdel;if(!confirm('Supprimer ?'))return;db.collection('crm_views').doc(vid).delete().then(function(){toast('🗑 Supprimé');savedViews=savedViews.filter(function(v){return v.id!==vid;});if(activeViewId===vid)activateView('__all__');else renderSavedViews();});return;}
  var item=e.target.closest('[data-svid]');if(item)activateView(item.dataset.svid);
});

/* ═══ CREATE VIEW (Criteria Builder) ═══ */
document.getElementById('svCreateBtn').addEventListener('click',function(){closeSvDD();openCV();});
var cvCriteria=[];

function openCV(){
  cvCriteria=[{field:'',op:'',value:''}];renderCVModal();
  document.getElementById('cvBackdrop').classList.add('open');
}
function closeCV(){document.getElementById('cvBackdrop').classList.remove('open');}
document.getElementById('cvBackdrop').addEventListener('click',function(e){if(e.target===this)closeCV();});

function renderCVModal(){
  var h='<div class="cv-head"><div class="cv-title">Nouvel affichage</div><button class="cv-close" id="cvClose">✕</button></div>';
  h+='<div class="cv-body">';
  h+='<div class="cv-label">Spécifier un nom</div>';
  h+='<input class="cv-input" id="cvName" placeholder="Ex: Leads Webinaire Mercredi"/>';
  h+='<div class="cv-label">Critères</div><div class="cv-criteria-list" id="cvCritList">';
  cvCriteria.forEach(function(c,i){
    h+='<div class="cv-crit-row" data-ci="'+i+'"><span class="cv-crit-num">'+(i+1)+'</span>';
    h+='<select class="cv-crit-select" data-cv="field" style="flex:1.2"><option value="">Choisissez une propriété</option>';
    CRIT_FIELDS.forEach(function(f){h+='<option value="'+f.key+'"'+(c.field===f.key?' selected':'')+'>'+esc(f.label)+'</option>';});
    h+='</select>';
    var field=null;for(var fi=0;fi<CRIT_FIELDS.length;fi++){if(CRIT_FIELDS[fi].key===c.field){field=CRIT_FIELDS[fi];break;}}
    var ops=field&&field.type==='select'?CRIT_OPS_SELECT:CRIT_OPS_TEXT;
    h+='<select class="cv-crit-select" data-cv="op" style="flex:0.8"><option value="">Condition</option>';
    ops.forEach(function(o){h+='<option value="'+o.v+'"'+(c.op===o.v?' selected':'')+'>'+esc(o.l)+'</option>';});
    h+='</select>';
    if(c.op!=='empty'&&c.op!=='notempty'){
      if(field&&field.type==='select'){
        h+='<select class="cv-crit-select" data-cv="value" style="flex:1.5"><option value="">Choisir...</option>';
        field.opts.forEach(function(o){h+='<option value="'+o.v+'"'+(c.value===o.v?' selected':'')+'>'+esc(o.l)+'</option>';});
        h+='</select>';
      }else{h+='<input class="cv-crit-value" data-cv="value" value="'+escA(c.value||'')+'" placeholder="Valeur" style="flex:1.5"/>';}
    }
    h+='<button class="cv-crit-del" data-cvdel="'+i+'">✕</button></div>';
  });
  h+='</div><button class="cv-add-crit" id="cvAddCrit">+ Ajouter un critère</button>';
  h+='<div class="cv-label">Qui peut y accéder ?</div><div class="cv-access-row">';
  h+='<label class="cv-radio-label"><input type="radio" name="cvAccess" value="me"/> Moi uniquement</label>';
  h+='<label class="cv-radio-label"><input type="radio" name="cvAccess" value="all" checked/> Tous les utilisateurs</label>';
  h+='<label class="cv-radio-label"><input type="radio" name="cvAccess" value="selected"/> Utilisateurs sélectionnés</label>';
  h+='</div>';
  h+='<div class="cv-actions"><button class="cv-btn cv-btn-cancel" id="cvCancel">Annuler</button><button class="cv-btn cv-btn-save" id="cvSave">Enregistrer</button></div></div>';
  document.getElementById('cvModal').innerHTML=h;

  document.getElementById('cvClose').onclick=closeCV;
  document.getElementById('cvCancel').onclick=closeCV;
  document.getElementById('cvAddCrit').onclick=function(){cvCriteria.push({field:'',op:'',value:''});renderCVModal();};
  document.getElementById('cvCritList').addEventListener('change',function(e){
    var row=e.target.closest('[data-ci]');if(!row)return;var ci=parseInt(row.dataset.ci),attr=e.target.dataset.cv;
    if(attr)cvCriteria[ci][attr]=e.target.value;
    if(attr==='field'){cvCriteria[ci].op='';cvCriteria[ci].value='';renderCVModal();}
    if(attr==='op'&&(e.target.value==='empty'||e.target.value==='notempty')){cvCriteria[ci].value='';renderCVModal();}
  });
  document.getElementById('cvCritList').addEventListener('input',function(e){
    var row=e.target.closest('[data-ci]');if(!row)return;var ci=parseInt(row.dataset.ci);
    if(e.target.dataset.cv==='value')cvCriteria[ci].value=e.target.value;
  });
  document.getElementById('cvCritList').addEventListener('click',function(e){
    var del=e.target.closest('[data-cvdel]');if(del){cvCriteria.splice(parseInt(del.dataset.cvdel),1);if(!cvCriteria.length)cvCriteria.push({field:'',op:'',value:''});renderCVModal();}
  });
  document.getElementById('cvSave').onclick=function(){
    var name=document.getElementById('cvName').value.trim();if(!name){toast('Donne un nom');return;}
    var criteria=cvCriteria.filter(function(c){return c.field&&c.op;});
    var access='all';var r=document.querySelector('input[name="cvAccess"]:checked');if(r)access=r.value;
    db.collection('crm_views').add({name:name,criteria:criteria,access:access,createdAt:firebase.firestore.FieldValue.serverTimestamp(),createdBy:firebase.auth().currentUser?firebase.auth().currentUser.uid:'anon'}).then(function(ref){
      savedViews.push({id:ref.id,name:name,criteria:criteria,access:access});toast('✅ "'+name+'" créé');closeCV();activateView(ref.id);
    }).catch(function(err){toast('❌ '+err.message);});
  };
}

function loadSavedViews(){db.collection('crm_views').orderBy('createdAt','desc').onSnapshot(function(snap){savedViews=[];snap.forEach(function(doc){var d=doc.data();d.id=doc.id;savedViews.push(d);});renderSavedViews();},function(err){console.warn('[crm_views]',err);});}

/* ═══ CHECKBOX / BULK ═══ */
document.addEventListener('change',function(e){
  if(e.target.matches('.row-cb')){var id=e.target.dataset.cbid;if(e.target.checked)selectedIds[id]=true;else delete selectedIds[id];updateBulkBar();var tr=e.target.closest('tr');if(tr)tr.classList.toggle('selected',e.target.checked);}
  if(e.target.matches('#listCbAll')||e.target.matches('#sheetCbAll')){var checked=e.target.checked;e.target.closest('table').querySelectorAll('.row-cb').forEach(function(cb){cb.checked=checked;if(checked)selectedIds[cb.dataset.cbid]=true;else delete selectedIds[cb.dataset.cbid];var tr=cb.closest('tr');if(tr)tr.classList.toggle('selected',checked);});updateBulkBar();}
});
document.getElementById('bulkDeselect').addEventListener('click',function(){clearSelection();renderAll();});

document.getElementById('bulkStageBtn').addEventListener('click',function(e){
  e.stopPropagation();var dd=document.getElementById('bulkStageDD');
  if(dd.classList.contains('open')){dd.classList.remove('open');return;}
  var h='';STAGES.forEach(function(s){h+='<div class="bulk-stage-item" data-bstage="'+s.key+'"><span style="width:8px;height:8px;border-radius:50%;background:'+s.color+';flex-shrink:0"></span>'+esc(s.label)+'</div>';});
  dd.innerHTML=h;dd.classList.add('open');
});
document.addEventListener('click',function(e){if(!e.target.closest('#bulkStageBtn')&&!e.target.closest('#bulkStageDD'))document.getElementById('bulkStageDD').classList.remove('open');});
document.getElementById('bulkStageDD').addEventListener('click',function(e){
  var item=e.target.closest('[data-bstage]');if(!item)return;var ns=item.dataset.bstage;
  var ids=Object.keys(selectedIds).filter(function(k){return selectedIds[k];});if(!ids.length)return;
  var batch=db.batch();ids.forEach(function(id){var upd={stage:ns,updatedAt:firebase.firestore.FieldValue.serverTimestamp()};if(S2S[ns])upd.status=S2S[ns];if(ns==='closed_won_setting'||ns==='closed_won_self'){upd.isClient=true;upd.clientSince=firebase.firestore.FieldValue.serverTimestamp();}batch.update(db.collection('leads').doc(id),upd);for(var i=0;i<allLeads.length;i++){if(allLeads[i].id===id){allLeads[i].stage=ns;break;}}});
  batch.commit().then(function(){toast('✅ '+ids.length+' → '+(SM[ns]?SM[ns].label:ns));clearSelection();renderAll();});
  document.getElementById('bulkStageDD').classList.remove('open');
});
document.getElementById('bulkSetterBtn').addEventListener('click',function(){
  var ids=Object.keys(selectedIds).filter(function(k){return selectedIds[k];});if(!ids.length)return;
  var slugs=tmActive().map(function(m){return m.slug;});
  var setter=prompt('Setter ('+slugs.join(' / ')+') :');
  if(!setter||slugs.indexOf(setter.toLowerCase())<0){toast('Setter invalide');return;}
  setter=setter.toLowerCase();var batch=db.batch();
  ids.forEach(function(id){batch.update(db.collection('leads').doc(id),{assignedTo:setter,updatedAt:firebase.firestore.FieldValue.serverTimestamp()});for(var i=0;i<allLeads.length;i++){if(allLeads[i].id===id){allLeads[i].assignedTo=setter;break;}}});
  batch.commit().then(function(){toast('✅ '+ids.length+' → '+setter);clearSelection();renderAll();});
});
document.getElementById('bulkDeleteBtn').addEventListener('click',function(){
  var ids=Object.keys(selectedIds).filter(function(k){return selectedIds[k];});if(!ids.length)return;
  if(!confirm('Supprimer '+ids.length+' leads ?'))return;
  var batch=db.batch();ids.forEach(function(id){batch.delete(db.collection('leads').doc(id));});
  batch.commit().then(function(){toast('🗑 '+ids.length+' supprimés');clearSelection();});
});
document.getElementById('bulkTagBtn').addEventListener('click',function(){
  var ids=Object.keys(selectedIds).filter(function(k){return selectedIds[k];});if(!ids.length)return;
  var tag=prompt('Tag à ajouter :');if(!tag||!tag.trim())return;tag=tag.trim();
  saveCustomTag(tag);
  var batch=db.batch();
  ids.forEach(function(id){
    for(var i=0;i<allLeads.length;i++){if(allLeads[i].id===id){if(!allLeads[i].tags)allLeads[i].tags=[];if(allLeads[i].tags.indexOf(tag)<0)allLeads[i].tags.push(tag);batch.update(db.collection('leads').doc(id),{tags:allLeads[i].tags,updatedAt:firebase.firestore.FieldValue.serverTimestamp()});break;}}
  });
  batch.commit().then(function(){toast('🏷 Tag "'+tag+'" ajouté à '+ids.length+' leads');collectTags();clearSelection();renderAll();});
});

/* ═══ DRAG & DROP ═══ */
var board=document.getElementById('crmBoard');
board.addEventListener('dragstart',function(e){var c=e.target.closest('.crm-card');if(!c)return;draggedLeadId=c.dataset.id;c.classList.add('dragging');e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',draggedLeadId);});
board.addEventListener('dragend',function(e){var c=e.target.closest('.crm-card');if(c)c.classList.remove('dragging');document.querySelectorAll('.crm-col-cards.drag-over').forEach(function(el){el.classList.remove('drag-over');});draggedLeadId=null;});
board.addEventListener('dragover',function(e){var d=e.target.closest('[data-drop]');if(d){e.preventDefault();d.classList.add('drag-over');}});
board.addEventListener('dragleave',function(e){var d=e.target.closest('[data-drop]');if(d)d.classList.remove('drag-over');});
board.addEventListener('drop',function(e){e.preventDefault();var d=e.target.closest('[data-drop]');if(!d||!draggedLeadId)return;d.classList.remove('drag-over');var ns=d.dataset.drop,lid=draggedLeadId;draggedLeadId=null;for(var i=0;i<allLeads.length;i++){if(allLeads[i].id===lid){allLeads[i].stage=ns;break;}}renderAll();var upd={stage:ns,updatedAt:firebase.firestore.FieldValue.serverTimestamp()};if(S2S[ns])upd.status=S2S[ns];if(ns==='closed_won_setting'||ns==='closed_won_self'){upd.isClient=true;upd.clientSince=firebase.firestore.FieldValue.serverTimestamp();}db.collection('leads').doc(lid).update(upd).then(function(){toast('→ '+(SM[ns]?SM[ns].label:ns));}).catch(function(err){toast('❌ '+err.message);});});

/* ═══ CLICKS ═══ */
board.addEventListener('click',function(e){var eye=e.target.closest('[data-action="quickview"]');if(eye){e.stopPropagation();openQV(eye.dataset.id,eye);return;}if(e.target.closest('.crm-card')&&!draggedLeadId)openModal(e.target.closest('.crm-card').dataset.id);});
document.getElementById('listBody').addEventListener('click',function(e){if(e.target.matches('.row-cb'))return;var tr=e.target.closest('tr[data-id]');if(tr)openModal(tr.dataset.id);});
document.getElementById('listHead').addEventListener('click',function(e){var th=e.target.closest('[data-sortcol]');if(!th)return;var col=th.dataset.sortcol;if(listSortKey===col){listSortDir=listSortDir==='asc'?'desc':'asc';}else{listSortKey=col;listSortDir='asc';}buildListHead();renderAll();});

/* ═══ SHEET EDIT ═══ */
var sheetTimer=null;
document.getElementById('sheetBody').addEventListener('input',function(e){var el=e.target.closest('[data-sf]');if(!el)return;var tr=el.closest('tr[data-sid]');if(!tr)return;if(sheetTimer)clearTimeout(sheetTimer);sheetTimer=setTimeout(function(){saveSheetRow(tr);},1500);});
document.getElementById('sheetBody').addEventListener('change',function(e){var el=e.target.closest('[data-sf]');if(!el)return;var tr=el.closest('tr[data-sid]');if(tr)saveSheetRow(tr);});
function saveSheetRow(tr){var lid=tr.dataset.sid,upd={};tr.querySelectorAll('[data-sf]').forEach(function(el){upd[el.dataset.sf]=el.value.trim();});upd.updatedAt=firebase.firestore.FieldValue.serverTimestamp();if(upd.stage&&S2S[upd.stage])upd.status=S2S[upd.stage];if(upd.stage&&(upd.stage==='closed_won_setting'||upd.stage==='closed_won_self')){upd.isClient=true;upd.clientSince=firebase.firestore.FieldValue.serverTimestamp();}for(var i=0;i<allLeads.length;i++){if(allLeads[i].id===lid){for(var k in upd){if(k!=='updatedAt')allLeads[i][k]=upd[k];}break;}}db.collection('leads').doc(lid).update(upd).then(function(){toast('✅ Sauvegardé');}).catch(function(err){toast('❌ '+err.message);});}

/* ═══ QUICK VIEW ═══ */
var qvTimer=null,qvLid=null;
function openQV(lid,anchor){var lead;for(var i=0;i<allLeads.length;i++){if(allLeads[i].id===lid){lead=allLeads[i];break;}}if(!lead)return;qvLid=lid;var sc=lead.assignedTo?tmColor(lead.assignedTo):'#6b7280',ini=(lead.nom||'?')[0].toUpperCase();var h='<div class="qv-head"><div class="qv-av" style="background:linear-gradient(135deg,'+sc+','+sc+'88)">'+ini+'</div><span class="qv-name">'+esc(lead.nom||'—')+'</span><button class="qv-close" id="qvClose">✕</button></div><div class="qv-body">';h+=qvF('Nom','nom',lead.nom)+qvF('Téléphone','telephone',lead.telephone)+qvF('Email','email',lead.email);h+='<div class="qv-field"><span class="qv-field-label">Attribué</span><select class="qv-select" data-qf="assignedTo"><option value="">—</option>'+buildAssignOptionsCrm(lead.assignedTo)+'</select></div><div class="qv-sep"></div>';h+=qvF('Source','utm',decodeUtm(lead.utm))+qvF('Secteur','secteur',lead.secteur)+qvF('CA','ca',lead.ca)+qvF('Défi','defi',lead.defi)+'<div class="qv-sep"></div>'+qvF('Closeur','closeur',lead.closeur)+qvF('Setting','setting',lead.setting);h+='<div class="qv-saved" id="qvSaved">✅ Sauvegardé</div><a class="qv-link" href="sales-contact.html?id='+lid+'">↗ Fiche complète</a></div>';var p=document.getElementById('qvPanel');p.innerHTML=h;var r=anchor.getBoundingClientRect(),left=r.right+8;if(left+320>window.innerWidth)left=r.left-328;if(left<8)left=8;var top=r.top-20;if(top+400>window.innerHeight)top=window.innerHeight-420;if(top<8)top=8;p.style.left=left+'px';p.style.top=top+'px';p.style.display='';document.getElementById('qvOverlay').classList.add('open');document.getElementById('qvClose').onclick=closeQV;document.getElementById('qvOverlay').onclick=closeQV;p.addEventListener('input',function(e){if(e.target.closest('[data-qf]')){if(qvTimer)clearTimeout(qvTimer);qvTimer=setTimeout(saveQV,2000);}});p.addEventListener('change',function(e){if(e.target.closest('[data-qf]'))saveQV();});}
function qvF(l,k,v){return'<div class="qv-field"><span class="qv-field-label">'+esc(l)+'</span><input class="qv-field-input" data-qf="'+k+'" value="'+escA(v||'')+'" placeholder="—"/></div>';}
function saveQV(){if(!qvLid)return;var p=document.getElementById('qvPanel'),fs=['nom','telephone','email','assignedTo','utm','secteur','ca','defi','closeur','setting'],upd={};fs.forEach(function(f){var el=p.querySelector('[data-qf="'+f+'"]');if(el)upd[f]=el.value.trim();});upd.updatedAt=firebase.firestore.FieldValue.serverTimestamp();for(var i=0;i<allLeads.length;i++){if(allLeads[i].id===qvLid){for(var k in upd){if(k!=='updatedAt')allLeads[i][k]=upd[k];}break;}}db.collection('leads').doc(qvLid).update(upd).then(function(){var m=document.getElementById('qvSaved');if(m){m.style.opacity='1';setTimeout(function(){m.style.opacity='0';},1500);}renderAll();});}
function closeQV(){document.getElementById('qvPanel').style.display='none';document.getElementById('qvOverlay').classList.remove('open');qvLid=null;}

/* ═══ MODAL ═══ */
function openModal(lid){var lead;for(var i=0;i<allLeads.length;i++){if(allLeads[i].id===lid){lead=allLeads[i];break;}}if(!lead)return;var sc=lead.assignedTo?tmColor(lead.assignedTo):'#6b7280',ini=(lead.nom||'?')[0].toUpperCase();var h='<div class="crm-modal-head"><div class="crm-modal-av" style="background:linear-gradient(135deg,'+sc+','+sc+'88)">'+ini+'</div><div class="crm-modal-name">'+esc(lead.nom||'—')+'</div><a href="sales-contact.html?id='+lid+'" style="padding:6px 12px;border:1px solid var(--border);border-radius:8px;color:var(--muted);font-size:11px;font-weight:700;text-decoration:none;white-space:nowrap">↗ Fiche</a><button class="crm-modal-close" data-action="closeModal">✕</button></div><div class="crm-modal-body">';h+='<div class="crm-modal-section"><div class="crm-modal-stitle">📋 Informations</div>';h+=mF('Nom','nom',lead.nom)+mF('Téléphone','telephone',lead.telephone)+mF('Email','email',lead.email)+mF('Source','utm',decodeUtm(lead.utm));h+='<div class="crm-modal-field"><span class="crm-modal-field-label">Attribué à</span><select class="crm-modal-select" data-medit="assignedTo"><option value="">— Non attribué —</option>'+buildAssignOptionsCrm(lead.assignedTo,true)+'</select></div>';h+='<div class="crm-modal-field"><span class="crm-modal-field-label">Type</span><select class="crm-modal-select" data-medit="type"><option value="vsl_elite"'+(lead.type==='vsl_elite'?' selected':'')+'>VSL ÉLITE</option><option value="self_booking"'+(lead.type==='self_booking'?' selected':'')+'>Self Booking</option></select></div>';h+=mF('Secteur','secteur',lead.secteur)+mF('CA actuel','ca',lead.ca)+mF('Défi','defi',lead.defi);h+='<div class="crm-modal-saved" id="modalSaved">✅ Sauvegardé</div></div>';h+='<div class="crm-modal-section"><div class="crm-modal-stitle">🏷 Tags</div><div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px" id="modalTagsWrap">';var leadTags=lead.tags||[];leadTags.forEach(function(t){if(t)h+='<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;background:'+tagColor(t)+'18;color:'+tagColor(t)+';border:1px solid '+tagColor(t)+'30">'+esc(t)+' <span style="cursor:pointer;opacity:0.6" data-action="removeTag" data-tagval="'+escA(t)+'">✕</span></span>';});h+='</div><div style="display:flex;gap:6px"><input class="crm-modal-input" id="modalTagInput" placeholder="Ajouter un tag..." style="flex:1;font-size:11px;padding:6px 10px"/><button style="padding:6px 12px;border:none;border-radius:8px;background:rgba(167,139,250,0.1);color:#c4b5fd;font-family:var(--fb);font-size:11px;font-weight:700;cursor:pointer" data-action="addTag">+</button></div></div>';h+='<div class="crm-modal-section"><div class="crm-modal-stitle">🔀 Étape pipeline</div><div class="crm-stage-pills">';STAGES.forEach(function(s){var isA=(lead.stage||'lead')===s.key;h+='<span class="crm-stage-pill'+(isA?' active':'')+'" data-action="setStage" data-stage="'+s.key+'" style="'+(isA?'color:'+s.color+';border-color:'+s.color+';background:'+s.color+'18':'')+'">'+esc(s.label)+'</span>';});h+='</div></div>';h+='<div class="crm-modal-section"><div class="crm-modal-stitle">📞 Appels récents</div>';var crmComms=(lead.communications||[]).filter(function(cc){return cc&&cc.type==='call';});crmComms.sort(function(aa,bb){var da=aa.date?new Date(aa.date).getTime():0;var db2=bb.date?new Date(bb.date).getTime():0;return db2-da;});if(crmComms.length===0){h+='<div style="font-size:11px;color:var(--muted);padding:6px 0">Aucun appel enregistré</div>';}else{var crmCommsShow=crmComms.slice(0,8);for(var cci=0;cci<crmCommsShow.length;cci++){var cco=crmCommsShow[cci];var ccDate=cco.date?new Date(cco.date):null;var ccDateStr=ccDate?ccDate.toLocaleString('fr-FR',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}):'';var ccDir=cco.direction==='outbound'||cco.direction==='out'?'↗':'↙';var ccMissed=!cco.duration;var ccDurStr='';if(cco.duration){var ccDm=Math.floor(cco.duration/60),ccDs=cco.duration%60;ccDurStr=ccDm+'m'+(ccDs?String(ccDs).padStart(2,'0')+'s':'');}var ccBadges='';if(cco.hasRecording)ccBadges+='🎙';if(cco.hasTranscript)ccBadges+='📄';if(cco.hasAiAnalysis)ccBadges+='🤖';var ccClickable=!!cco.callLogId;h+='<div class="crm-call-row"'+(ccClickable?' data-action="callDetail" data-cid="'+esc(cco.callLogId)+'" style="cursor:pointer;display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;background:rgba(52,211,153,0.06);border:1px solid rgba(52,211,153,0.12);margin-bottom:6px"':' style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);margin-bottom:6px"')+'>';h+='<span style="font-size:14px;color:'+(ccMissed?'#ef4444':'#34d399')+'">'+ccDir+'</span>';h+='<div style="flex:1;min-width:0"><div style="font-size:12px;color:#fff;font-weight:600">'+esc(cco.ownerName||'Appel')+'</div><div style="font-size:10px;color:var(--muted)">'+esc(ccDateStr)+(ccDurStr?' · '+ccDurStr:'')+'</div></div>';if(ccBadges)h+='<span style="font-size:12px;opacity:0.85">'+ccBadges+'</span>';h+='</div>';}}h+='</div>';h+='<div class="crm-modal-section"><div class="crm-modal-stitle">📝 Notes</div>';var notes=lead.notesHistory||[];for(var ni=notes.length-1;ni>=0;ni--){h+='<div class="crm-note-item"><div class="crm-note-date">'+esc(notes[ni].date||'')+'</div><div class="crm-note-text">'+esc(notes[ni].text||'')+'</div></div>';}h+='<div class="crm-note-add-row"><textarea class="crm-note-input" id="modalNoteInput" placeholder="Ajouter une note..."></textarea><button class="crm-note-add-btn" data-action="addNote">+ Ajouter</button></div></div>';// Payment + Contract section
h+='<div class="crm-modal-section">';
h+='<div class="crm-modal-stitle">💳 Paiement & Contrat</div>';
if(lead.contractSigned){
  h+='<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:8px;background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.2);margin-bottom:8px">';
  h+='<span style="color:#34d399;font-size:16px">✍️</span>';
  h+='<div><div style="font-size:12px;font-weight:700;color:#34d399">Contrat signé</div>';
  if(lead.contractTemplateName)h+='<div style="font-size:10px;color:var(--muted)">'+esc(lead.contractTemplateName)+'</div>';
  h+='</div></div>';
}
// Check existing payments
h+='<div id="crmPaySection_'+lid+'" style="margin-bottom:8px;font-size:11px;color:var(--muted)">Chargement paiements…</div>';
h+='<div style="display:flex;gap:6px;flex-wrap:wrap">';
h+='<button onclick="window.markAsClient(\''+lid+'\')" style="display:'+(!lead.isClient?'inline-flex':'none')+';align-items:center;gap:5px;padding:7px 12px;border:1px solid rgba(16,185,129,0.3);border-radius:8px;background:rgba(16,185,129,0.08);color:#34d399;font-size:12px;font-weight:700;cursor:pointer">👥 Marquer client</button>';
h+='<a href="payments.html?leadId='+lid+'&leadName='+encodeURIComponent(lead.nom||'')+'&leadEmail='+encodeURIComponent(lead.email||'')+'&leadPhone='+encodeURIComponent(lead.telephone||'')+'" style="display:inline-flex;align-items:center;gap:5px;padding:7px 12px;border:1px solid rgba(16,185,129,0.3);border-radius:8px;background:rgba(16,185,129,0.08);color:#34d399;font-size:12px;font-weight:700;text-decoration:none">💳 Créer paiement</a>';
h+='</div>';
h+='</div>';
h+='<div class="crm-modal-section">';if(lead.telephone)h+='<button type="button" data-action="dialerCall" data-phone="'+escA(lead.telephone.replace(/\s/g,''))+'" data-name="'+escA(lead.nom||'')+'" style="display:block;width:100%;text-align:center;padding:10px;background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.2);border-radius:10px;color:#34d399;font-family:inherit;font-weight:700;font-size:13px;cursor:pointer;margin-bottom:8px">📞 Appeler</button>';if(lead.email)h+='<a href="mailto:'+escA(lead.email)+'" style="display:block;text-align:center;padding:10px;background:rgba(96,165,250,0.1);border:1px solid rgba(96,165,250,0.2);border-radius:10px;color:#60a5fa;font-weight:700;font-size:13px;text-decoration:none">✉️ Email</a>';h+='</div></div>';document.getElementById('modalPanel').innerHTML=h;document.getElementById('modalBg').classList.add('open');
// Load payment summary for this lead
(function(leadId){
  var el=document.getElementById('crmPaySection_'+leadId);
  if(!el)return;
  db.collection('payments').where('leadId','==',leadId).orderBy('createdAt','desc').limit(3).get().then(function(sn){
    if(!el)return;
    if(sn.empty){el.style.display='none';return;}
    var STATUS={draft:'Brouillon',pending_mandate:'Mandat en attente',mandate_active:'Mandat actif',active:'Actifs',completed:'Terminé',failed:'Échec',cancelled:'Annulé'};
    var h2='';sn.forEach(function(d){var p=d.data();h2+='<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 8px;border-radius:6px;background:var(--bg3);margin-bottom:4px"><span style="font-size:11px;color:var(--text);font-weight:600">'+new Intl.NumberFormat('fr-FR',{style:'currency',currency:'EUR'}).format(p.totalAmount||0)+'</span><span style="font-size:10px;color:var(--muted)">'+(STATUS[p.status]||p.status)+'</span></div>';});
    el.innerHTML=h2;el.style.fontSize='12px';
  }).catch(function(){if(el)el.style.display='none';});
})(lid);document.getElementById('modalBg')._leadId=lid;}
function mF(l,k,v){return'<div class="crm-modal-field"><span class="crm-modal-field-label">'+esc(l)+'</span><input class="crm-modal-input" data-medit="'+k+'" value="'+escA(v||'')+'"/></div>';}

document.getElementById('modalBg').addEventListener('click',function(e){var dcT=e.target.closest('[data-action="dialerCall"]');if(dcT){e.stopPropagation();e.preventDefault();if(window.DialerBridge&&dcT.dataset.phone){window.DialerBridge.callLead(this._leadId||null,dcT.dataset.phone,dcT.dataset.name||null);}else if(!window.DialerBridge){console.warn('[DialerBridge] non chargé');}return;}var cdT=e.target.closest('[data-action="callDetail"]');if(cdT){e.stopPropagation();var ccid=cdT.dataset.cid;if(ccid&&window.CallDetailModal)window.CallDetailModal.open(ccid);return;}if(e.target===this)this.classList.remove('open');if(e.target.closest('[data-action="closeModal"]'))this.classList.remove('open');var sp=e.target.closest('[data-action="setStage"]');if(sp){var ns=sp.dataset.stage,lid=this._leadId;for(var i=0;i<allLeads.length;i++){if(allLeads[i].id===lid){allLeads[i].stage=ns;break;}}document.querySelectorAll('.crm-stage-pill').forEach(function(p){p.classList.remove('active');p.style.color='';p.style.borderColor='';p.style.background='';});sp.classList.add('active');var sO=SM[ns];if(sO){sp.style.color=sO.color;sp.style.borderColor=sO.color;sp.style.background=sO.color+'18';}renderAll();var upd={stage:ns,updatedAt:firebase.firestore.FieldValue.serverTimestamp()};if(S2S[ns])upd.status=S2S[ns];if(ns==='closed_won_setting'||ns==='closed_won_self'){upd.isClient=true;upd.clientSince=firebase.firestore.FieldValue.serverTimestamp();}db.collection('leads').doc(lid).update(upd).then(function(){toast('→ '+(sO?sO.label:ns));});}var nb=e.target.closest('[data-action="addNote"]');if(nb){var inp=document.getElementById('modalNoteInput');var txt=inp?inp.value.trim():'';if(!txt)return;var lid2=this._leadId,nn={text:txt,date:fmtNow()};for(var j=0;j<allLeads.length;j++){if(allLeads[j].id===lid2){if(!allLeads[j].notesHistory)allLeads[j].notesHistory=[];allLeads[j].notesHistory.push(nn);db.collection('leads').doc(lid2).update({notesHistory:allLeads[j].notesHistory,updatedAt:firebase.firestore.FieldValue.serverTimestamp()}).then(function(){toast('✅ Note ajoutée');});break;}}openModal(lid2);}var addTagBtn=e.target.closest('[data-action="addTag"]');if(addTagBtn){var tagInput=document.getElementById('modalTagInput');var newTag=tagInput?tagInput.value.trim():'';if(!newTag)return;var lid3=this._leadId;for(var x=0;x<allLeads.length;x++){if(allLeads[x].id===lid3){if(!allLeads[x].tags)allLeads[x].tags=[];if(allLeads[x].tags.indexOf(newTag)<0){allLeads[x].tags.push(newTag);db.collection('leads').doc(lid3).update({tags:allLeads[x].tags,updatedAt:firebase.firestore.FieldValue.serverTimestamp()}).then(function(){toast('🏷 Tag ajouté');collectTags();});}break;}}saveCustomTag(newTag);openModal(lid3);}var rmTag=e.target.closest('[data-action="removeTag"]');if(rmTag){var tv=rmTag.dataset.tagval;var lid4=this._leadId;for(var y=0;y<allLeads.length;y++){if(allLeads[y].id===lid4){if(allLeads[y].tags){var ti=allLeads[y].tags.indexOf(tv);if(ti>=0)allLeads[y].tags.splice(ti,1);db.collection('leads').doc(lid4).update({tags:allLeads[y].tags,updatedAt:firebase.firestore.FieldValue.serverTimestamp()}).then(function(){toast('🏷 Tag retiré');collectTags();});}break;}}openModal(lid4);}});

var mSaveTimer=null;
document.getElementById('modalBg').addEventListener('input',function(e){if(!e.target.closest('[data-medit]'))return;if(mSaveTimer)clearTimeout(mSaveTimer);mSaveTimer=setTimeout(saveModal,2000);});
document.getElementById('modalBg').addEventListener('change',function(e){if(e.target.closest('[data-medit]'))saveModal();});
function saveModal(){var lid=document.getElementById('modalBg')._leadId;if(!lid)return;var p=document.getElementById('modalPanel'),fs=['nom','telephone','email','utm','assignedTo','type','secteur','ca','defi'],upd={};fs.forEach(function(f){var el=p.querySelector('[data-medit="'+f+'"]');if(el)upd[f]=el.value.trim();});upd.updatedAt=firebase.firestore.FieldValue.serverTimestamp();for(var i=0;i<allLeads.length;i++){if(allLeads[i].id===lid){for(var k in upd){if(k!=='updatedAt')allLeads[i][k]=upd[k];}break;}}db.collection('leads').doc(lid).update(upd).then(function(){var m=document.getElementById('modalSaved');if(m){m.style.opacity='1';setTimeout(function(){m.style.opacity='0';},1500);}renderAll();});}

/* ═══ SEARCH & FILTER ═══ */
document.getElementById('crmSearch').addEventListener('input',function(){searchQuery=this.value.trim();currentPage=1;colCardLimits={};renderAll();});
document.querySelectorAll('.crm-filter-pill').forEach(function(b){b.addEventListener('click',function(){document.querySelectorAll('.crm-filter-pill').forEach(function(p){p.classList.remove('active');});b.classList.add('active');filterSetter=b.dataset.setter;currentPage=1;colCardLimits={};renderAll();});});
document.querySelectorAll('.crm-section-pill').forEach(function(b){b.addEventListener('click',function(){document.querySelectorAll('.crm-section-pill').forEach(function(p){p.classList.remove('active');});b.classList.add('active');filterSection=b.dataset.section;currentPage=1;colCardLimits={};renderAll();});});

/* ═══ DATE FILTER ═══ */
var filterDateRange='all';
var filterDateFrom=null,filterDateTo=null;

function getLeadDate(l){
  // Priority: importedCreatedAt (original Bigin date) > createdAt (Firestore)
  if(l.importedCreatedAt){
    var d=new Date(l.importedCreatedAt.replace(' ','T'));
    if(!isNaN(d.getTime()))return d;
  }
  if(l.createdAt){return l.createdAt.toDate?l.createdAt.toDate():new Date(l.createdAt);}
  return null;
}

function getDateThreshold(range){
  var now=new Date();
  if(range==='7d')return new Date(now.getTime()-7*86400000);
  if(range==='30d')return new Date(now.getTime()-30*86400000);
  if(range==='90d')return new Date(now.getTime()-90*86400000);
  if(range==='year')return new Date(now.getFullYear(),0,1);
  return null;
}

/* ── Date dropdown open/close ── */
document.getElementById('fbDateTrigger').addEventListener('click',function(e){
  e.stopPropagation();
  var dd=document.getElementById('fbDateDD');
  dd.classList.toggle('open');
  document.getElementById('fbTypeDD').classList.remove('open');
});
document.getElementById('fbDateDD').addEventListener('click',function(e){
  var item=e.target.closest('[data-daterange]');if(!item)return;
  document.querySelectorAll('#fbDateDD .fb-dd-item').forEach(function(p){p.classList.remove('active');});
  item.classList.add('active');
  filterDateRange=item.dataset.daterange;
  var isCustom=filterDateRange==='custom';
  document.getElementById('fbDateFrom').style.display=isCustom?'':'none';
  document.getElementById('fbDateTo').style.display=isCustom?'':'none';
  if(!isCustom){filterDateFrom=null;filterDateTo=null;}
  /* Update trigger label */
  var trig=document.getElementById('fbDateTrigger');
  if(filterDateRange!=='all'){var labels={'7d':'7 jours','30d':'30 jours','90d':'3 mois',year:'Cette année',custom:'Personnalisé'};trig.innerHTML=esc(labels[filterDateRange]||filterDateRange)+' <span class="fb-dd-caret">▼</span>';trig.classList.add('has-value');}
  else{trig.innerHTML='📅 Période <span class="fb-dd-caret">▼</span>';trig.classList.remove('has-value');}
  if(!isCustom)document.getElementById('fbDateDD').classList.remove('open');
  currentPage=1;renderAll();renderActiveChips();
});
document.getElementById('fbDateFrom').addEventListener('change',function(){
  filterDateFrom=this.value?new Date(this.value):null;currentPage=1;renderAll();renderActiveChips();
});
document.getElementById('fbDateTo').addEventListener('change',function(){
  filterDateTo=this.value?new Date(this.value+'T23:59:59'):null;currentPage=1;renderAll();renderActiveChips();
});

/* ═══ TYPE FILTER ═══ */
/* ── Type dropdown open/close ── */
document.getElementById('fbTypeTrigger').addEventListener('click',function(e){
  e.stopPropagation();
  var dd=document.getElementById('fbTypeDD');
  dd.classList.toggle('open');
  document.getElementById('fbDateDD').classList.remove('open');
});
document.getElementById('fbTypeDD').addEventListener('click',function(e){
  var item=e.target.closest('[data-typef]');if(!item)return;
  document.querySelectorAll('#fbTypeDD .fb-dd-item').forEach(function(p){p.classList.remove('active');});
  item.classList.add('active');
  filterType=item.dataset.typef;
  document.getElementById('fbTypeDD').classList.remove('open');
  rebuildTypeDD();
  currentPage=1;renderAll();renderActiveChips();
});
/* ── Close all dropdowns on outside click ── */
document.addEventListener('click',function(e){
  if(!e.target.closest('#fbDateWrapper'))document.getElementById('fbDateDD').classList.remove('open');
  if(!e.target.closest('#fbTypeWrapper'))document.getElementById('fbTypeDD').classList.remove('open');
});

/* ═══ TAG SYSTEM ═══ */
var filterTags=[];
var allTagsDef=[];

function collectTags(){
  var tagSet={};
  allLeads.forEach(function(l){
    // Tags array
    if(l.tags&&Array.isArray(l.tags)){l.tags.forEach(function(t){if(t)tagSet[t.toLowerCase()]=t;});}
    // Parse tagsWebi from Bigin (comma-separated string)
    if(l.tagsWebi&&typeof l.tagsWebi==='string'){
      l.tagsWebi.split(',').forEach(function(t){t=t.trim();if(t)tagSet[t.toLowerCase()]=t;});
    }
  });
  var custom=[];try{custom=JSON.parse(localStorage.getItem('crm_custom_tags')||'[]');}catch(e){}
  custom.forEach(function(t){if(t&&!tagSet[t.toLowerCase()])tagSet[t.toLowerCase()]=t;});
  allTagsDef=Object.values(tagSet).sort();
}

function saveCustomTag(tagName){
  var custom=[];try{custom=JSON.parse(localStorage.getItem('crm_custom_tags')||'[]');}catch(e){}
  if(custom.indexOf(tagName)<0){custom.push(tagName);localStorage.setItem('crm_custom_tags',JSON.stringify(custom));}
}

var TAG_COLORS=['#a78bfa','#f59e0b','#34d399','#ef4444','#60a5fa','#ec4899','#f97316','#14b8a6','#8b5cf6','#eab308'];
function tagColor(t){var h=0;for(var i=0;i<t.length;i++){h=t.charCodeAt(i)+((h<<5)-h);}return TAG_COLORS[Math.abs(h)%TAG_COLORS.length];}

function renderTagDD(filter){
  collectTags();filter=(filter||'').toLowerCase();
  var h='<input class="fb-tag-search" id="fbTagSearch" placeholder="Rechercher ou créer un tag..." value="'+escA(filter)+'"/>';
  var shown=allTagsDef.filter(function(t){return !filter||t.toLowerCase().indexOf(filter)>=0;});
  shown.forEach(function(t){
    var sel=filterTags.indexOf(t)>=0;
    var col=tagColor(t);
    h+='<div class="fb-tag-item'+(sel?' selected':'')+'" data-tagval="'+escA(t)+'">';
    h+='<input type="checkbox" class="fb-tag-item-cb"'+(sel?' checked':'')+'/>';
    h+='<span class="fb-tag-item-color" style="background:'+col+'"></span>';
    h+=esc(t)+'</div>';
  });
  if(filter&&shown.length===0){
    h+='<div class="fb-tag-create" id="fbTagCreate" data-newtag="'+escA(filter)+'">+ Créer le tag "'+esc(filter)+'"</div>';
  } else if(filter&&allTagsDef.indexOf(filter)<0){
    h+='<div class="fb-tag-create" id="fbTagCreate" data-newtag="'+escA(filter)+'">+ Créer "'+esc(filter)+'"</div>';
  }
  document.getElementById('fbTagDD').innerHTML=h;
  var searchEl=document.getElementById('fbTagSearch');
  if(searchEl){searchEl.addEventListener('input',function(){renderTagDD(this.value);});searchEl.focus();}
}

document.getElementById('fbTagTrigger').addEventListener('click',function(e){
  e.stopPropagation();
  var dd=document.getElementById('fbTagDD');
  if(dd.classList.contains('open')){dd.classList.remove('open');return;}
  renderTagDD();dd.classList.add('open');
});
document.addEventListener('click',function(e){if(!e.target.closest('#fbTagWrapper'))document.getElementById('fbTagDD').classList.remove('open');});

document.getElementById('fbTagDD').addEventListener('click',function(e){
  var item=e.target.closest('[data-tagval]');
  if(item){
    var tag=item.dataset.tagval;
    var idx=filterTags.indexOf(tag);
    if(idx>=0)filterTags.splice(idx,1);else filterTags.push(tag);
    renderTagDD(document.getElementById('fbTagSearch')?document.getElementById('fbTagSearch').value:'');
    document.getElementById('fbTagTrigger').classList.toggle('has-tags',filterTags.length>0);
    document.getElementById('fbTagTrigger').innerHTML=filterTags.length>0?(filterTags.length+' tag'+(filterTags.length>1?'s':'')+' <span class="fb-dd-caret">▼</span>'):('🏷 Tags <span class="fb-dd-caret">▼</span>');
    currentPage=1;renderAll();renderActiveChips();
    return;
  }
  var create=e.target.closest('[data-newtag]');
  if(create){
    var newTag=create.dataset.newtag.trim();
    if(!newTag)return;
    saveCustomTag(newTag);
    filterTags.push(newTag);
    collectTags();
    renderTagDD();
    document.getElementById('fbTagTrigger').classList.add('has-tags');
    document.getElementById('fbTagTrigger').innerHTML=filterTags.length+' tag'+(filterTags.length>1?'s':'')+' <span class="fb-dd-caret">▼</span>';
    currentPage=1;renderAll();renderActiveChips();
    toast('🏷 Tag "'+newTag+'" créé');
  }
});

/* ═══ ACTIVE FILTER CHIPS ═══ */
function renderActiveChips(){
  var h='';var hasFilters=false;
  if(filterDateRange!=='all'){
    hasFilters=true;
    var labels={all:'Tout','7d':'7 jours','30d':'30 jours','90d':'3 mois',year:'Cette année',custom:'Personnalisé'};
    var label=labels[filterDateRange]||filterDateRange;
    if(filterDateRange==='custom'&&filterDateFrom){label='Du '+fmtDate(filterDateFrom);if(filterDateTo)label+=' au '+fmtDate(filterDateTo);}
    h+='<span class="fb-chip">📅 '+esc(label)+' <span class="fb-chip-x" data-chipclear="date">✕</span></span>';
  }
  filterTags.forEach(function(t){
    hasFilters=true;
    h+='<span class="fb-chip tag-chip">🏷 '+esc(t)+' <span class="fb-chip-x" data-chipclear="tag" data-chipval="'+escA(t)+'">✕</span></span>';
  });
  if(filterType!=='all'){
    hasFilters=true;
    var tLabel=LT[filterType]||filterType;
    h+='<span class="fb-chip">📦 '+esc(tLabel)+' <span class="fb-chip-x" data-chipclear="type">✕</span></span>';
  }
  document.getElementById('fbActiveChips').innerHTML=h;
  document.getElementById('fbClearAll').style.display=hasFilters?'':'none';
}

document.getElementById('fbActiveChips').addEventListener('click',function(e){
  var x=e.target.closest('[data-chipclear]');if(!x)return;
  if(x.dataset.chipclear==='date'){
    filterDateRange='all';filterDateFrom=null;filterDateTo=null;
    document.querySelectorAll('#fbDateDD .fb-dd-item').forEach(function(p){p.classList.toggle('active',p.dataset.daterange==='all');});
    document.getElementById('fbDateFrom').style.display='none';document.getElementById('fbDateTo').style.display='none';
    document.getElementById('fbDateTrigger').innerHTML='📅 Période <span class="fb-dd-caret">▼</span>';document.getElementById('fbDateTrigger').classList.remove('has-value');
  }
  if(x.dataset.chipclear==='tag'){
    var tv=x.dataset.chipval;var idx=filterTags.indexOf(tv);if(idx>=0)filterTags.splice(idx,1);
    document.getElementById('fbTagTrigger').classList.toggle('has-tags',filterTags.length>0);
    document.getElementById('fbTagTrigger').innerHTML=filterTags.length>0?(filterTags.length+' tag'+(filterTags.length>1?'s':'')+' <span class="fb-dd-caret">▼</span>'):('🏷 Tags <span class="fb-dd-caret">▼</span>');
  }
  if(x.dataset.chipclear==='type'){filterType='all';}
  currentPage=1;renderAll();renderActiveChips();
});

document.getElementById('fbClearAll').addEventListener('click',function(){
  filterDateRange='all';filterDateFrom=null;filterDateTo=null;filterTags=[];filterType='all';
  document.querySelectorAll('#fbDateDD .fb-dd-item').forEach(function(p){p.classList.toggle('active',p.dataset.daterange==='all');});
  document.getElementById('fbDateFrom').style.display='none';document.getElementById('fbDateTo').style.display='none';
  document.getElementById('fbDateTrigger').innerHTML='📅 Période <span class="fb-dd-caret">▼</span>';document.getElementById('fbDateTrigger').classList.remove('has-value');
  document.getElementById('fbTagTrigger').classList.remove('has-tags');
  document.getElementById('fbTagTrigger').innerHTML='🏷 Tags <span class="fb-dd-caret">▼</span>';
  currentPage=1;renderAll();renderActiveChips();
});

/* ═══ SORT DROPDOWN ═══ */
var SORT_FIELDS=[
  {key:'createdAt',label:'Heure de création'},
  {key:'nom',label:'Nom de l\'Affaire'},
  {key:'assignedTo',label:'Gestionnaire de l\'Affaire'},
  {key:'telephone',label:'Portable'},
  {key:'stage',label:'Étape'},
  {key:'utm',label:'Source / UTM'},
  {key:'type',label:'Origine du Prospect'},
  {key:'updatedAt',label:'Heure de modification'}
];
var globalSortKey='createdAt',globalSortDir='desc';

function renderSortDD(filter){
  filter=(filter||'').toLowerCase();
  var h='<input class="sort-dd-search" id="sortDDSearch" placeholder="Rechercher"/>';
  SORT_FIELDS.forEach(function(f){
    if(filter&&f.label.toLowerCase().indexOf(filter)<0)return;
    h+='<div class="sort-dd-item'+(globalSortKey===f.key?' active':'')+'" data-sortf="'+f.key+'">'+esc(f.label)+'</div>';
  });
  document.getElementById('sortDD').innerHTML=h;
  var search=document.getElementById('sortDDSearch');
  if(search){search.value=filter;search.addEventListener('input',function(){renderSortDD(this.value);});}
}

document.getElementById('sortTrigger').addEventListener('click',function(e){
  e.stopPropagation();
  var dd=document.getElementById('sortDD');var o=dd.classList.toggle('open');
  this.classList.toggle('open',o);
  if(o){renderSortDD();setTimeout(function(){var s=document.getElementById('sortDDSearch');if(s)s.focus();},50);}
});
document.addEventListener('click',function(e){if(!e.target.closest('#sortWrapper')){document.getElementById('sortDD').classList.remove('open');document.getElementById('sortTrigger').classList.remove('open');}});
document.getElementById('sortDD').addEventListener('click',function(e){
  var item=e.target.closest('[data-sortf]');if(!item)return;
  globalSortKey=item.dataset.sortf;listSortKey=globalSortKey;
  var label=SORT_FIELDS.filter(function(f){return f.key===globalSortKey;})[0];
  document.getElementById('sortTriggerLabel').textContent=label?label.label:globalSortKey;
  document.getElementById('sortDD').classList.remove('open');
  document.getElementById('sortTrigger').classList.remove('open');
  buildListHead();renderAll();
});
document.getElementById('sortDirBtn').addEventListener('click',function(){
  globalSortDir=globalSortDir==='desc'?'asc':'desc';listSortDir=globalSortDir;
  this.textContent=globalSortDir==='asc'?'↑':'↓';
  buildListHead();renderAll();
});

/* ═══ COLUMN CONFIG ═══ */
var ALL_COLUMNS=[
  {key:'nom',label:'Nom de l\'Affaire',default:true},
  {key:'stage',label:'Étape',default:true},
  {key:'telephone',label:'Portable',default:true},
  {key:'email',label:'Email',default:true},
  {key:'assignedTo',label:'Gestionnaire de l\'Affaire',default:true},
  {key:'type',label:'Origine du Prospect',default:true},
  {key:'utm',label:'Source / UTM',default:true},
  {key:'createdAt',label:'Heure de création',default:true},
  {key:'secteur',label:'Secteur',default:false},
  {key:'ca',label:'CA actuel',default:false},
  {key:'defi',label:'Défi',default:false},
  {key:'closeur',label:'Closeur',default:false},
  {key:'setting',label:'Setting',default:false},
  {key:'status',label:'Statut Leads Live',default:false},
  {key:'updatedAt',label:'Heure de modification',default:false}
];
var visibleCols=null;

function loadColConfig(){
  var saved=localStorage.getItem('crm_visible_cols');
  if(saved){try{visibleCols=JSON.parse(saved);}catch(e){visibleCols=null;}}
  if(!visibleCols){visibleCols=ALL_COLUMNS.filter(function(c){return c.default;}).map(function(c){return c.key;});}
}
loadColConfig();

function saveColConfig(){localStorage.setItem('crm_visible_cols',JSON.stringify(visibleCols));}

/* ═══ KANBAN FIELD CONFIG ═══ */
var KANBAN_FIELDS=[
  {key:'telephone',label:'Téléphone',icon:'📱',default:true},
  {key:'email',label:'Email',icon:'📧',default:false},
  {key:'type',label:'Type (Origine)',icon:'🏷',default:true},
  {key:'assignedTo',label:'Setter',icon:'⭐',default:true},
  {key:'status',label:'Statut appel',icon:'📞',default:true},
  {key:'tags',label:'Tags',icon:'🏷',default:true},
  {key:'utm',label:'Source / UTM',icon:'🔗',default:false},
  {key:'closeur',label:'Closeur',icon:'🎯',default:false},
  {key:'createdAt',label:'Date de création',icon:'📅',default:false}
];
var visibleKanbanFields=null;

function loadKanbanConfig(){
  var saved=localStorage.getItem('crm_kanban_fields');
  if(saved){try{visibleKanbanFields=JSON.parse(saved);}catch(e){visibleKanbanFields=null;}}
  if(!visibleKanbanFields){visibleKanbanFields=KANBAN_FIELDS.filter(function(f){return f.default;}).map(function(f){return f.key;});}
}
loadKanbanConfig();

function saveKanbanConfig(){localStorage.setItem('crm_kanban_fields',JSON.stringify(visibleKanbanFields));}
function isKanbanFieldVisible(key){return visibleKanbanFields.indexOf(key)>=0;}

function getVisibleListCols(){
  var cols=[{key:'_cb',label:'',w:'40px'}];
  visibleCols.forEach(function(k){
    var def=null;for(var i=0;i<ALL_COLUMNS.length;i++){if(ALL_COLUMNS[i].key===k){def=ALL_COLUMNS[i];break;}}
    if(def)cols.push({key:k,label:def.label,w:'140px'});
  });
  return cols;
}

function getVisibleSheetCols(){
  var cols=[{key:'_cb',label:'',edit:false},{key:'_num',label:'#',edit:false}];
  visibleCols.forEach(function(k){
    var editType=true;
    if(k==='stage'||k==='assignedTo'||k==='type')editType='select';
    if(k==='createdAt'||k==='updatedAt')editType=false;
    cols.push({key:k,label:(ALL_COLUMNS.filter(function(c){return c.key===k;})[0]||{}).label||k,edit:editType});
  });
  return cols;
}

/* Override LIST_COLS and SHEET_COLS to be dynamic */
function rebuildDynamicCols(){
  LIST_COLS=getVisibleListCols();
  SHEET_COLS=getVisibleSheetCols();
  buildListHead();
  buildSheetHead();
  renderAll();
}

var colcfgActiveTab='pipeline';

function openColConfig(){
  /* Auto-select tab matching current view */
  if(currentView==='pipeline')colcfgActiveTab='pipeline';
  else colcfgActiveTab='list';
  renderColConfigPanel();
  document.getElementById('colcfgPanel').classList.add('open');
  document.getElementById('colcfgBtn').classList.add('open');
}

function renderColConfigPanel(){
  var h='<div class="colcfg-head">';
  h+='<div class="colcfg-title">Champs affichés</div>';
  h+='<button class="colcfg-close" id="colcfgClose">✕</button></div>';

  /* Tabs */
  h+='<div class="colcfg-tabs">';
  h+='<button class="colcfg-tab'+(colcfgActiveTab==='pipeline'?' active':'')+'" data-cfgtab="pipeline">▥ Pipeline</button>';
  h+='<button class="colcfg-tab'+(colcfgActiveTab==='list'?' active':'')+'" data-cfgtab="list">☰ Liste / Feuille</button>';
  h+='</div>';

  if(colcfgActiveTab==='pipeline'){
    h+='<div class="colcfg-desc">Choisissez les champs visibles sur chaque carte du Kanban.</div>';
    h+='<div class="colcfg-list" id="colcfgList">';
    KANBAN_FIELDS.forEach(function(f){
      var checked=visibleKanbanFields.indexOf(f.key)>=0;
      h+='<div class="colcfg-item" data-colkey="'+f.key+'">';
      h+='<span class="colcfg-item-icon">'+f.icon+'</span>';
      h+='<span class="colcfg-item-label">'+esc(f.label)+'</span>';
      h+='<label class="colcfg-toggle"><input type="checkbox" class="colcfg-cb" data-colcb="'+f.key+'"'+(checked?' checked':'')
        +'/><span class="colcfg-toggle-track"></span></label>';
      h+='</div>';
    });
    h+='</div>';
    /* Mini preview */
    h+='<div class="colcfg-preview" id="colcfgPreview"></div>';
  } else {
    h+='<div class="colcfg-desc">Choisissez les colonnes visibles dans la vue Liste et Feuille.</div>';
    h+='<input class="colcfg-search" id="colcfgSearch" placeholder="Rechercher une colonne..."/>';
    h+='<div class="colcfg-list" id="colcfgList">';
    ALL_COLUMNS.forEach(function(col){
      var checked=visibleCols.indexOf(col.key)>=0;
      h+='<div class="colcfg-item" data-colkey="'+col.key+'">';
      h+='<span class="colcfg-item-drag">⠿</span>';
      h+='<span class="colcfg-item-label">'+esc(col.label)+'</span>';
      h+='<label class="colcfg-toggle"><input type="checkbox" class="colcfg-cb" data-colcb="'+col.key+'"'+(checked?' checked':'')
        +'/><span class="colcfg-toggle-track"></span></label>';
      h+='</div>';
    });
    h+='</div>';
  }
  h+='<div class="colcfg-actions">';
  h+='<button class="colcfg-reset-btn" id="colcfgReset">↺ Défaut</button>';
  h+='<button class="colcfg-cancel-btn" id="colcfgCancel">Annuler</button>';
  h+='<button class="colcfg-save-btn" id="colcfgSave">Enregistrer</button></div>';
  document.getElementById('colcfgPanel').innerHTML=h;

  /* Bind events */
  document.getElementById('colcfgClose').onclick=closeColConfig;
  document.getElementById('colcfgCancel').onclick=closeColConfig;

  /* Tab switch */
  document.querySelectorAll('[data-cfgtab]').forEach(function(tab){
    tab.addEventListener('click',function(){colcfgActiveTab=this.dataset.cfgtab;renderColConfigPanel();});
  });

  /* Search (list tab only) */
  var searchEl=document.getElementById('colcfgSearch');
  if(searchEl){
    searchEl.addEventListener('input',function(){
      var q=this.value.toLowerCase();
      document.querySelectorAll('.colcfg-item').forEach(function(item){
        var label=item.querySelector('.colcfg-item-label');
        item.style.display=(!label||label.textContent.toLowerCase().indexOf(q)>=0)?'':'none';
      });
    });
  }

  /* Live preview for Pipeline tab */
  if(colcfgActiveTab==='pipeline'){
    updateKanbanPreview();
    document.querySelectorAll('#colcfgList .colcfg-cb').forEach(function(cb){
      cb.addEventListener('change',updateKanbanPreview);
    });
  }

  /* Reset */
  document.getElementById('colcfgReset').onclick=function(){
    if(colcfgActiveTab==='pipeline'){
      var defKeys=KANBAN_FIELDS.filter(function(f){return f.default;}).map(function(f){return f.key;});
      document.querySelectorAll('#colcfgList .colcfg-cb').forEach(function(cb){cb.checked=defKeys.indexOf(cb.dataset.colcb)>=0;});
      updateKanbanPreview();
    } else {
      var defCols=ALL_COLUMNS.filter(function(c){return c.default;}).map(function(c){return c.key;});
      document.querySelectorAll('#colcfgList .colcfg-cb').forEach(function(cb){cb.checked=defCols.indexOf(cb.dataset.colcb)>=0;});
    }
  };

  /* Save */
  document.getElementById('colcfgSave').onclick=function(){
    if(colcfgActiveTab==='pipeline'){
      visibleKanbanFields=[];
      document.querySelectorAll('#colcfgList .colcfg-cb:checked').forEach(function(cb){visibleKanbanFields.push(cb.dataset.colcb);});
      saveKanbanConfig();renderAll();closeColConfig();toast('✅ Champs Pipeline mis à jour');
    } else {
      visibleCols=[];
      document.querySelectorAll('#colcfgList .colcfg-cb:checked').forEach(function(cb){visibleCols.push(cb.dataset.colcb);});
      saveColConfig();rebuildDynamicCols();closeColConfig();toast('✅ Colonnes Liste mises à jour');
    }
  };
}

function updateKanbanPreview(){
  var preview=document.getElementById('colcfgPreview');
  if(!preview)return;
  var active=[];
  document.querySelectorAll('#colcfgList .colcfg-cb:checked').forEach(function(cb){active.push(cb.dataset.colcb);});
  var h='<div class="colcfg-preview-title">Aperçu carte</div>';
  h+='<div class="colcfg-preview-card">';
  h+='<div style="font-weight:800;font-size:12px;margin-bottom:2px">Jean Dupont</div>';
  if(active.indexOf('telephone')>=0)h+='<div style="font-family:var(--fm);font-size:10px;color:var(--muted)">06 12 34 56 78</div>';
  if(active.indexOf('email')>=0)h+='<div style="font-family:var(--fm);font-size:10px;color:var(--muted)">jean@email.com</div>';
  if(active.indexOf('createdAt')>=0)h+='<div style="font-size:11px;color:var(--subtle-text)">02/04/2026</div>';
  h+='<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:3px">';
  if(active.indexOf('type')>=0)h+='<span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;background:rgba(167,139,250,0.12);color:#c4b5fd">VSL</span>';
  if(active.indexOf('assignedTo')>=0)h+='<span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;background:var(--hover-bg);color:var(--red3)">Guillaume</span>';
  if(active.indexOf('status')>=0)h+='<span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;background:var(--hover-bg);color:var(--blue)">📞 Appelé</span>';
  if(active.indexOf('utm')>=0)h+='<span style="font-size:9px;font-weight:700;padding:2px 7px;border-radius:4px;background:var(--hover-bg);color:var(--purple)">🔗 FB Ads</span>';
  if(active.indexOf('closeur')>=0)h+='<span style="font-size:9px;font-weight:700;padding:2px 7px;border-radius:4px;background:var(--hover-bg);color:var(--gold)">🎯 Adrien</span>';
  h+='</div>';
  if(active.indexOf('tags')>=0){
    h+='<div style="display:flex;gap:3px;margin-top:3px">';
    h+='<span style="font-size:8px;font-weight:700;padding:1px 5px;border-radius:3px;background:rgba(167,139,250,0.12);color:#c4b5fd">VSL 03</span>';
    h+='<span style="font-size:8px;font-weight:700;padding:1px 5px;border-radius:3px;background:rgba(52,211,153,0.12);color:#34d399">Chaud</span>';
    h+='</div>';
  }
  h+='</div>';
  preview.innerHTML=h;
}

function closeColConfig(){document.getElementById('colcfgPanel').classList.remove('open');document.getElementById('colcfgBtn').classList.remove('open');}
document.getElementById('colcfgBtn').addEventListener('click',function(){
  if(document.getElementById('colcfgPanel').classList.contains('open'))closeColConfig();else openColConfig();
});

/* Apply dynamic columns on init */
rebuildDynamicCols();

/* Override pipeline sort to use globalSortKey */
var origRenderPipeline=renderPipeline;
renderPipeline=function(leads){
  if(globalSortKey&&globalSortKey!=='createdAt'){
    leads=leads.slice().sort(function(a,b){
      var va=a[globalSortKey]||'',vb=b[globalSortKey]||'';
      if(typeof va==='string')va=va.toLowerCase();if(typeof vb==='string')vb=vb.toLowerCase();
      if(va<vb)return globalSortDir==='asc'?-1:1;if(va>vb)return globalSortDir==='asc'?1:-1;return 0;
    });
  }
  origRenderPipeline(leads);
};

/* ═══ ADD LEAD ═══ */
document.getElementById('crmAddBtn').addEventListener('click',function(){var nom=prompt('Nom du lead :');if(!nom||!nom.trim())return;var tel=prompt('Téléphone :')||'',email=prompt('Email :')||'';db.collection('leads').add({nom:nom.trim(),telephone:tel.trim(),email:email.trim(),type:'vsl_elite',stage:'lead',status:'nouveau',assignedTo:'',notesHistory:[],createdAt:firebase.firestore.FieldValue.serverTimestamp(),updatedAt:firebase.firestore.FieldValue.serverTimestamp()}).then(function(){toast('✅ Lead ajouté');}).catch(function(err){toast('❌ '+err.message);});});

/* ═══ SETTINGS PANEL ═══ */
var settingsUsers=[];
var settingsRoles=[];
var activeSetTab='users';

var ROLE_HIERARCHY={
  id:'pdg',name:'PDG',icon:'👑',color:'#f59e0b',children:[
    {id:'head_of_sales',name:'Head Of Sales',icon:'📊',color:'#60a5fa',children:[
      {id:'closeurs',name:'Closeurs',icon:'🎯',color:'#ef4444',children:[]},
      {id:'setteurs',name:'Setteurs',icon:'📞',color:'#f59e0b',children:[]}
    ]},
    {id:'coachs',name:'Coachs',icon:'🎓',color:'#a78bfa',children:[]}
  ]
};

var ROLE_COLORS={pdg:'#f59e0b',head_of_sales:'#60a5fa',closeurs:'#ef4444',setteurs:'#f59e0b',coachs:'#a78bfa',admin:'#f59e0b',sales:'#ef4444',coach:'#a78bfa'};
var PROFILE_COLORS={super_admin:'#f59e0b',administrateur:'#60a5fa',admin:'#60a5fa',standard:'#6b7280'};

document.getElementById('settingsGear').addEventListener('click',openSettings);

function openSettings(){
  document.getElementById('settingsOverlay').classList.add('open');
  document.getElementById('settingsPanel').classList.add('open');
  renderSettingsPanel();
  loadSettingsUsers();
}

function closeSettings(){
  document.getElementById('settingsOverlay').classList.remove('open');
  document.getElementById('settingsPanel').classList.remove('open');
}

function renderSettingsPanel(){
  var h='<div class="set-header"><div class="set-title">⚙ Paramètres</div><button class="set-close" id="setClose">✕</button></div>';
  h+='<div class="set-tabs">';
  h+='<div class="set-tab'+(activeSetTab==='users'?' active':'')+'" data-settab="users">Utilisateurs et contrôles</div>';
  h+='<div class="set-tab'+(activeSetTab==='roles'?' active':'')+'" data-settab="roles">Rôles</div>';
  h+='<div class="set-tab'+(activeSetTab==='permissions'?' active':'')+'" data-settab="permissions">Profils</div>';
  h+='<div class="set-tab'+(activeSetTab==='fields'?' active':'')+'" data-settab="fields">Champs</div>';
  h+='</div>';
  h+='<div class="set-body" id="setBody"></div>';
  document.getElementById('settingsPanel').innerHTML=h;

  document.getElementById('setClose').onclick=closeSettings;
  document.getElementById('settingsOverlay').onclick=closeSettings;

  document.querySelectorAll('.set-tab').forEach(function(tab){
    tab.addEventListener('click',function(){activeSetTab=this.dataset.settab;renderSettingsPanel();loadSettingsUsers();});
  });

  if(activeSetTab==='users')renderUsersTab();
  else if(activeSetTab==='roles')renderRolesTab();
  else if(activeSetTab==='permissions')renderPermissionsTab();
  else if(activeSetTab==='fields')renderFieldsTab();
}

/* ── Users Tab ── */
function loadSettingsUsers(){
  db.collection('users').get().then(function(snap){
    settingsUsers=[];
    snap.forEach(function(doc){var d=doc.data();d.uid=doc.id;settingsUsers.push(d);});
    if(activeSetTab==='users')renderUsersTab();
  });
}

function renderUsersTab(){
  var body=document.getElementById('setBody');
  var h='<div class="set-user-toolbar">';
  h+='<input class="set-user-search" id="setUserSearch" placeholder="Rechercher un utilisateur..."/>';
  h+='<button class="set-add-user-btn" id="setAddUserBtn">+ Nouvel utilisateur</button>';
  h+='</div>';
  h+='<table class="set-users-table"><thead><tr>';
  h+='<th>Nom Complet</th><th>E-Mail</th><th>Rôle</th><th>Profil</th><th>Statut</th><th></th>';
  h+='</tr></thead><tbody id="setUsersBody">';
  settingsUsers.forEach(function(u){h+=renderUserRow(u);});
  h+='</tbody></table>';
  body.innerHTML=h;

  document.getElementById('setAddUserBtn').onclick=function(){openUserEdit(null);};
  document.getElementById('setUserSearch').addEventListener('input',function(){
    var q=this.value.toLowerCase();
    document.querySelectorAll('#setUsersBody tr').forEach(function(tr){
      var text=tr.textContent.toLowerCase();
      tr.style.display=text.indexOf(q)>=0?'':'none';
    });
  });
  document.getElementById('setUsersBody').addEventListener('click',function(e){
    var editBtn=e.target.closest('[data-uedit]');
    if(editBtn){var uid=editBtn.dataset.uedit;var user=settingsUsers.filter(function(u){return u.uid===uid;})[0];if(user)openUserEdit(user);}
    var delBtn=e.target.closest('[data-udel]');
    if(delBtn){var uid2=delBtn.dataset.udel;if(!confirm('Supprimer cet utilisateur ?'))return;
      db.collection('users').doc(uid2).delete().then(function(){toast('🗑 Utilisateur supprimé');loadSettingsUsers();});}
  });
}

function renderUserRow(u){
  var name=u.displayName||u.name||u.email||'—';
  var ini=name.charAt(0).toUpperCase();
  var role=u.role||'—';
  var profile=u.profile||'admin';
  var rc=ROLE_COLORS[role]||'#6b7280';
  var pc=PROFILE_COLORS[profile]||'#6b7280';
  var roleLabels={admin:'Admin',coach:'Coachs',sales:'Sales',pdg:'PDG',head_of_sales:'Head Of Sales',closeurs:'Closeurs',setteurs:'Setteurs'};
  var profileLabels={super_admin:'Super administrateur',administrateur:'Administrateur',admin:'Administrateur',standard:'Standard'};

  var h='<tr>';
  h+='<td><div class="set-user-name-cell"><div class="set-user-av" style="background:linear-gradient(135deg,'+rc+','+rc+'88)">'+ini+'</div><div><div class="set-user-name">'+esc(name)+'</div></div></div></td>';
  h+='<td style="color:var(--muted)">'+esc(u.email||'')+'</td>';
  h+='<td><span class="set-role-badge" style="background:'+rc+'18;color:'+rc+'">'+esc(roleLabels[role]||role)+'</span></td>';
  h+='<td><span class="set-profile-badge" style="background:'+pc+'18;color:'+pc+'">'+esc(profileLabels[profile]||profile)+'</span></td>';
  h+='<td><span class="set-status-dot" style="background:var(--green)" title="Actif"></span></td>';
  h+='<td><div class="set-user-actions">';
  h+='<button class="set-user-action" data-uedit="'+u.uid+'" title="Modifier">✏</button>';
  h+='<button class="set-user-action danger" data-udel="'+u.uid+'" title="Supprimer">🗑</button>';
  h+='</div></td></tr>';
  return h;
}

function openUserEdit(user){
  var isNew=!user;
  var body=document.getElementById('setBody');
  var overlay=document.createElement('div');
  overlay.className='set-edit-backdrop';
  var h='<div class="set-edit-modal">';
  h+='<div class="set-edit-title">'+(isNew?'Nouvel utilisateur':'Modifier l\'utilisateur')+'</div>';
  h+='<div class="set-edit-field"><div class="set-edit-label">Nom complet</div><input class="set-edit-input" id="seditName" value="'+escA(user?user.displayName||user.name||'':'')+'" placeholder="Prénom Nom"/></div>';
  h+='<div class="set-edit-field"><div class="set-edit-label">Email</div><input class="set-edit-input" id="seditEmail" type="email" value="'+escA(user?user.email||'':'')+'" placeholder="email@ambitiocorp.com"'+(isNew?'':' style="opacity:0.5"')+'/></div>';
  h+='<div class="set-edit-field"><div class="set-edit-label">Rôle</div><select class="set-edit-select" id="seditRole">';
  var roles=[{v:'admin',l:'Admin / PDG'},{v:'sales',l:'Sales (Closeur/Setteur)'},{v:'coach',l:'Coach'},{v:'head_of_sales',l:'Head Of Sales'}];
  roles.forEach(function(r){h+='<option value="'+r.v+'"'+(user&&user.role===r.v?' selected':'')+'>'+r.l+'</option>';});
  h+='</select></div>';
  h+='<div class="set-edit-field"><div class="set-edit-label">Profil</div><select class="set-edit-select" id="seditProfile">';
  var profiles=[{v:'super_admin',l:'Super administrateur'},{v:'administrateur',l:'Administrateur'},{v:'standard',l:'Standard'}];
  profiles.forEach(function(p){h+='<option value="'+p.v+'"'+(user&&user.profile===p.v?' selected':'')+'>'+p.l+'</option>';});
  h+='</select></div>';
  h+='<div class="set-edit-actions"><button class="set-edit-cancel" id="seditCancel">Annuler</button><button class="set-edit-save" id="seditSave">'+(isNew?'Créer':'Sauvegarder')+'</button></div>';
  h+='</div>';
  overlay.innerHTML=h;
  body.style.position='relative';
  body.appendChild(overlay);

  document.getElementById('seditCancel').onclick=function(){overlay.remove();};
  overlay.addEventListener('click',function(e){if(e.target===overlay)overlay.remove();});

  document.getElementById('seditSave').onclick=function(){
    var name=document.getElementById('seditName').value.trim();
    var email=document.getElementById('seditEmail').value.trim();
    var role=document.getElementById('seditRole').value;
    var profile=document.getElementById('seditProfile').value;
    if(!name){toast('Nom requis');return;}
    if(!email){toast('Email requis');return;}

    var data={displayName:name,name:name,email:email,role:role,profile:profile,updatedAt:firebase.firestore.FieldValue.serverTimestamp()};

    if(isNew){
      data.createdAt=firebase.firestore.FieldValue.serverTimestamp();
      var docId=email.replace(/[^a-zA-Z0-9]/g,'_');
      db.collection('users').doc(docId).set(data).then(function(){
        toast('✅ Utilisateur créé');overlay.remove();loadSettingsUsers();
      }).catch(function(err){toast('❌ '+err.message);});
    } else {
      db.collection('users').doc(user.uid).update(data).then(function(){
        toast('✅ Modifié');overlay.remove();loadSettingsUsers();
      }).catch(function(err){toast('❌ '+err.message);});
    }
  };
}

/* ── Roles Tab (editable) ── */
var firestoreRoles=null;
var DEFAULT_ROLES=[
  {id:'pdg',name:'PDG',reportsTo:null,peerVisibility:true,description:'Direction générale. Accès total à toutes les données.'},
  {id:'head_of_sales',name:'Head Of Sales',reportsTo:'pdg',peerVisibility:true,description:'Supervise les closeurs et setteurs. Accès aux données de vente.'},
  {id:'closeurs',name:'Closeurs',reportsTo:'head_of_sales',peerVisibility:false,description:'Les utilisateurs de ce rôle ne peuvent pas consulter des données pour utilisateurs administrateurs.'},
  {id:'setteurs',name:'Setteurs',reportsTo:'head_of_sales',peerVisibility:false,description:'Qualification et prise de RDV.'},
  {id:'coachs',name:'Coachs',reportsTo:'pdg',peerVisibility:true,description:'Coaching client. Accès au module coaching uniquement.'}
];

function loadRoles(cb){
  try{
    db.collection('crm_roles').get().then(function(snap){
      if(snap.empty){
        // Seed defaults to Firestore
        firestoreRoles=DEFAULT_ROLES.slice();
        var batch=db.batch();
        DEFAULT_ROLES.forEach(function(r){
          batch.set(db.collection('crm_roles').doc(r.id),{name:r.name,reportsTo:r.reportsTo||null,peerVisibility:r.peerVisibility,description:r.description,createdAt:firebase.firestore.FieldValue.serverTimestamp()});
        });
        batch.commit().then(function(){console.log('[crm_roles] seeded');if(cb)cb();}).catch(function(err){console.warn('[crm_roles] seed error:',err);if(cb)cb();});
      }
      else{firestoreRoles=[];snap.forEach(function(doc){var d=doc.data();d.id=doc.id;firestoreRoles.push(d);});if(cb)cb();}
    }).catch(function(err){console.warn('[crm_roles] load error:',err);firestoreRoles=DEFAULT_ROLES.slice();if(cb)cb();});
  }catch(e){firestoreRoles=DEFAULT_ROLES.slice();if(cb)cb();}
}

function getRoles(){return firestoreRoles||DEFAULT_ROLES;}

function countUsersInRole(roleId){
  var roleMap={pdg:'admin',head_of_sales:'admin',closeurs:'sales',setteurs:'sales',coachs:'coach'};
  var mappedRole=roleMap[roleId]||roleId;
  return settingsUsers.filter(function(u){return u.role===mappedRole||u.role===roleId;}).length;
}

function buildRoleTree(roles){
  var byParent={};
  roles.forEach(function(r){var p=r.reportsTo||'__root__';if(!byParent[p])byParent[p]=[];byParent[p].push(r);});
  function renderNode(parentId,depth){
    var children=byParent[parentId]||[];
    var h='';
    children.forEach(function(r){
      var count=countUsersInRole(r.id);
      var icons={pdg:'👑',head_of_sales:'📊',closeurs:'🎯',setteurs:'📞',coachs:'🎓'};
      var icon=icons[r.id]||'📋';
      h+='<div style="padding-left:'+(depth*28)+'px;margin:4px 0">';
      if(depth>0)h+='<span style="color:var(--muted2);margin-right:6px">├─</span>';
      h+='<div class="set-role-box" data-roleid="'+r.id+'" style="display:inline-flex">';
      h+='<span class="set-role-icon">'+icon+'</span>';
      h+='<span class="set-role-name">'+esc(r.name)+'</span>';
      if(count>0)h+='<span class="set-role-count">'+count+'</span>';
      h+='<button class="set-user-action" data-roleedit="'+r.id+'" style="margin-left:8px" title="Modifier">✏</button>';
      h+='</div>';
      h+=renderNode(r.id,depth+1);
      h+='</div>';
    });
    return h;
  }
  return renderNode('__root__',0);
}

function renderRolesTab(){
  if(!firestoreRoles){loadRoles(function(){renderRolesTab();});
    // Show loading while waiting
    var body=document.getElementById('setBody');
    if(body)body.innerHTML='<div style="text-align:center;padding:40px;color:var(--muted)">Chargement des rôles...</div>';
    return;
  }
  var body=document.getElementById('setBody');
  var roles=getRoles();
  var h='<div style="margin-bottom:16px"><span style="font-size:11px;color:var(--muted);line-height:1.6">Les rôles définissent les niveaux de visibilité pour les enregistrements. Un utilisateur de rôle inférieur ne peut pas afficher les enregistrements au-dessus de lui dans la hiérarchie.</span></div>';
  h+='<div style="font-family:var(--fh);font-size:13px;font-weight:800;margin-bottom:4px">SARL Ambitio Corp</div>';
  h+='<div class="set-role-tree" id="setRoleTree">';
  h+=buildRoleTree(roles);
  h+='</div>';
  h+='<button class="set-add-role-btn" id="setAddRoleBtn">+ Créer un nouveau rôle</button>';
  body.innerHTML=h;

  document.getElementById('setAddRoleBtn').onclick=function(){openRoleEdit(null);};
  body.addEventListener('click',function(e){
    var editBtn=e.target.closest('[data-roleedit]');
    if(editBtn){
      var rid=editBtn.dataset.roleedit;
      var role=firestoreRoles.filter(function(r){return r.id===rid;})[0];
      if(role)openRoleEdit(role);
    }
  });
}

function openRoleEdit(role){
  var isNew=!role;
  var body=document.getElementById('setBody');
  var overlay=document.createElement('div');
  overlay.className='set-edit-backdrop';
  var h='<div class="set-edit-modal">';
  h+='<div class="set-edit-title">'+(isNew?'Créer un rôle':'Modifier le rôle')+'</div>';
  h+='<div class="set-edit-field"><div class="set-edit-label">Nom de rôle</div><input class="set-edit-input" id="srName" value="'+escA(role?role.name:'')+'" placeholder="Ex: Closeurs"/></div>';
  h+='<div class="set-edit-field"><div class="set-edit-label">Rend-compte à</div><select class="set-edit-select" id="srParent">';
  h+='<option value="">— Aucun (rôle racine) —</option>';
  firestoreRoles=firestoreRoles||DEFAULT_ROLES;
  firestoreRoles.forEach(function(r){
    if(role&&r.id===role.id)return;
    h+='<option value="'+r.id+'"'+(role&&role.reportsTo===r.id?' selected':'')+'>'+esc(r.name)+'</option>';
  });
  h+='</select></div>';
  h+='<div class="set-edit-field"><div class="set-edit-label">Visibilité de données des pairs</div>';
  h+='<div style="display:flex;align-items:center;gap:10px;margin-top:4px">';
  var peerV=role?role.peerVisibility!==false:true;
  h+='<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:var(--text)"><input type="checkbox" id="srPeerVis" style="accent-color:var(--green);width:18px;height:18px"'+(peerV?' checked':'')+'/> Permettre aux utilisateurs de ce rôle de consulter les données des autres</label>';
  h+='</div></div>';
  h+='<div class="set-edit-field"><div class="set-edit-label">Description</div><textarea class="set-edit-input" id="srDesc" rows="3" style="resize:vertical;min-height:60px">'+esc(role?role.description||'':'')+'</textarea></div>';
  h+='<div class="set-edit-actions"><button class="set-edit-cancel" id="srCancel">Annuler</button><button class="set-edit-save" id="srSave">'+(isNew?'Créer':'Sauvegarder')+'</button></div>';
  h+='</div>';
  overlay.innerHTML=h;
  body.style.position='relative';
  body.appendChild(overlay);

  document.getElementById('srCancel').onclick=function(){overlay.remove();};
  overlay.addEventListener('click',function(e){if(e.target===overlay)overlay.remove();});

  document.getElementById('srSave').onclick=function(){
    var name=document.getElementById('srName').value.trim();
    if(!name){toast('Nom requis');return;}
    var parent=document.getElementById('srParent').value||null;
    var peerVis=document.getElementById('srPeerVis').checked;
    var desc=document.getElementById('srDesc').value.trim();
    var data={name:name,reportsTo:parent,peerVisibility:peerVis,description:desc,updatedAt:firebase.firestore.FieldValue.serverTimestamp()};

    if(isNew){
      var docId=name.toLowerCase().replace(/[^a-z0-9]/g,'_');
      data.createdAt=firebase.firestore.FieldValue.serverTimestamp();
      db.collection('crm_roles').doc(docId).set(data).then(function(){
        data.id=docId;firestoreRoles.push(data);
        toast('✅ Rôle "'+name+'" créé');overlay.remove();renderRolesTab();
      }).catch(function(err){toast('❌ '+err.message);});
    } else {
      db.collection('crm_roles').doc(role.id).set(data,{merge:true}).then(function(){
        for(var i=0;i<firestoreRoles.length;i++){if(firestoreRoles[i].id===role.id){for(var k in data){firestoreRoles[i][k]=data[k];}break;}}
        toast('✅ Rôle modifié');overlay.remove();renderRolesTab();
      }).catch(function(err){toast('❌ '+err.message);});
    }
  };
}

/* ── Permissions/Profils Tab ── */
var PERM_SECTIONS=[
  {id:'base',name:'Autorisations de base',items:[
    {id:'pipeline',name:'Enregistrements de pipeline',subs:['Afficher','Créer','Modifier','Supprimer','Partage externe']},
    {id:'contacts',name:'Contacts',subs:['Afficher','Créer','Modifier','Supprimer']},
    {id:'coaching',name:'Coaching / Clients',subs:['Afficher','Créer','Modifier','Supprimer']},
    {id:'commissions',name:'Commissions',subs:['Afficher','Modifier']},
    {id:'activites',name:'Activités',subs:['Afficher','Créer','Modifier','Supprimer']},
    {id:'notes',name:'Notes',subs:['Afficher','Créer','Modifier','Supprimer']},
    {id:'fichiers',name:'Fichiers',subs:['Afficher','Charger','Supprimer']},
    {id:'dashboard',name:'Tableaux de bord',subs:['Afficher','Gérer']}
  ]},
  {id:'advanced',name:'Fonctions avancées',items:[
    {id:'manage_pipeline',name:'Manage Team Pipelines',subs:[]},
    {id:'automatisation',name:'Automatisation',subs:['Manage Automations','Gérer les connexions']},
    {id:'gestion_users',name:'Gestion des utilisateurs',subs:[]},
    {id:'actions_bloc',name:'Actions en bloc',subs:['Mettre à jour','Supprimer','Propriétaire de modification']},
    {id:'admin_data',name:'Administration des données',subs:['Importer','Exporter','Historique des importations']},
    {id:'divers',name:'Divers',subs:['Rechercher et Fusionner','Gérer les vues personnalisées','Balises']}
  ]},
  {id:'canaux',name:'Canaux',items:[
    {id:'email_channel',name:'E-mail',subs:['Envoyer un e-mail','E-mails en masse','Modèles']},
    {id:'communication',name:'Communication interne',subs:['Envoyer','Voir tout']}
  ]}
];

var PROFILES_DEF=[
  {id:'super_admin',name:'Super administrateur',description:'Ce profil aura toutes les autorisations. Les utilisateurs avec ce profil pourront visualiser et gérer par défaut toutes les données à l\'intérieur du compte de l\'organisation.',color:'#f59e0b'},
  {id:'administrateur',name:'Administrateur',description:'Ce profil aura toutes les autorisations à l\'exception de certains privilèges de gestion avancée (gestion utilisateurs, administration des données).',color:'#60a5fa'},
  {id:'standard',name:'Standard',description:'Profil limité aux actions courantes : consultation et modification des enregistrements de pipeline, contacts, notes et activités. Pas d\'accès aux fonctions administratives.',color:'#6b7280'}
];
var firestoreProfiles=null;
var profDetailView=null;

function loadProfiles(cb){
  db.collection('crm_profiles').get().then(function(snap){
    if(snap.empty){
      // Seed defaults to Firestore
      firestoreProfiles=PROFILES_DEF.map(function(p){
        var perms={};
        PERM_SECTIONS.forEach(function(sec){sec.items.forEach(function(it){
          if(p.id==='super_admin'){perms[it.id]=true;}
          else if(p.id==='administrateur'){perms[it.id]=true;if(it.id==='gestion_users'||it.id==='admin_data')perms[it.id]=false;}
          else{perms[it.id]=(it.id==='pipeline'||it.id==='contacts'||it.id==='activites'||it.id==='notes'||it.id==='fichiers'||it.id==='coaching');}
        });});
        return{id:p.id,name:p.name,description:p.description,color:p.color,perms:perms};
      });
      // Write to Firestore
      var batch=db.batch();
      firestoreProfiles.forEach(function(p){
        batch.set(db.collection('crm_profiles').doc(p.id),{name:p.name,description:p.description,color:p.color,perms:p.perms,createdAt:firebase.firestore.FieldValue.serverTimestamp()});
      });
      batch.commit().then(function(){console.log('[crm_profiles] seeded');if(cb)cb();}).catch(function(err){console.warn('[crm_profiles] seed error:',err);if(cb)cb();});
    } else {
      firestoreProfiles=[];snap.forEach(function(doc){var d=doc.data();d.id=doc.id;firestoreProfiles.push(d);});
      if(cb)cb();
    }
  }).catch(function(err){console.warn('[crm_profiles]',err);
    firestoreProfiles=PROFILES_DEF.map(function(p){
      var perms={};PERM_SECTIONS.forEach(function(sec){sec.items.forEach(function(it){
        if(p.id==='super_admin')perms[it.id]=true;
        else if(p.id==='administrateur'){perms[it.id]=true;if(it.id==='gestion_users'||it.id==='admin_data')perms[it.id]=false;}
        else perms[it.id]=(it.id==='pipeline'||it.id==='contacts'||it.id==='activites'||it.id==='notes'||it.id==='fichiers'||it.id==='coaching');
      });});
      return{id:p.id,name:p.name,description:p.description,color:p.color,perms:perms};
    });
    if(cb)cb();
  });
}

function renderPermissionsTab(){
  if(!firestoreProfiles){
    var body=document.getElementById('setBody');
    if(body)body.innerHTML='<div style="text-align:center;padding:40px;color:var(--muted)">Chargement des profils...</div>';
    loadProfiles(function(){renderPermissionsTab();});
    return;
  }
  if(profDetailView){renderProfileDetail(profDetailView);return;}
  renderProfilesList();
}

function renderProfilesList(){
  var body=document.getElementById('setBody');
  var h='<div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:4px">';
  h+='<div><div style="font-family:var(--fh);font-size:16px;font-weight:800;margin-bottom:4px">Profils</div>';
  h+='<div style="font-size:12px;color:var(--muted);line-height:1.5;max-width:600px">Les profils vous aident à définir un ensemble d\'autorisations pour chaque utilisateur ainsi que les actions qu\'ils peuvent exécuter. Lorsque vous invitez des utilisateurs, vous affectez un profil à chacun d\'entre eux.</div></div>';
  h+='<button class="set-add-user-btn" id="profCreateBtn">+ Créer un nouveau profil</button></div>';
  h+='<table class="prof-list-table"><thead><tr><th>Nom De Profil</th><th>Description Du Profil</th><th>Modifié Par</th></tr></thead><tbody>';
  firestoreProfiles.forEach(function(p){
    h+='<tr data-profclick="'+p.id+'">';
    h+='<td><span class="prof-name">'+esc(p.name)+'</span></td>';
    h+='<td><span class="prof-desc">'+esc(p.description||'')+'</span></td>';
    h+='<td style="color:var(--muted);font-size:11px">—</td></tr>';
  });
  h+='</tbody></table>';
  body.innerHTML=h;

  body.addEventListener('click',function(e){
    var row=e.target.closest('[data-profclick]');
    if(row){profDetailView=row.dataset.profclick;renderPermissionsTab();}
  });
  document.getElementById('profCreateBtn').onclick=function(){
    var name=prompt('Nom du nouveau profil :');
    if(!name||!name.trim())return;
    var desc=prompt('Description :')||'';
    var newProf={id:name.trim().toLowerCase().replace(/[^a-z0-9]/g,'_'),name:name.trim(),description:desc.trim(),color:'#6b7280',perms:{}};
    PERM_SECTIONS.forEach(function(sec){sec.items.forEach(function(it){newProf.perms[it.id]=false;});});
    db.collection('crm_profiles').doc(newProf.id).set(newProf).then(function(){
      firestoreProfiles.push(newProf);toast('✅ Profil "'+name.trim()+'" créé');renderPermissionsTab();
    }).catch(function(err){toast('❌ '+err.message);});
  };
}

function renderProfileDetail(profId){
  var prof=null;for(var i=0;i<firestoreProfiles.length;i++){if(firestoreProfiles[i].id===profId){prof=firestoreProfiles[i];break;}}
  if(!prof){profDetailView=null;renderProfilesList();return;}
  var perms=prof.perms||{};

  var body=document.getElementById('setBody');
  var h='<div class="prof-detail-header">';
  h+='<button class="prof-detail-back" id="profBack">← Retour</button>';
  h+='<div class="prof-detail-name">'+esc(prof.name)+'</div>';
  h+='</div>';
  h+='<div class="prof-detail-desc">'+esc(prof.description||'')+'</div>';

  PERM_SECTIONS.forEach(function(sec){
    h+='<div class="prof-section-title">'+esc(sec.name)+'</div>';
    sec.items.forEach(function(it){
      var isOn=perms[it.id]!==false;
      var subsText=it.subs.length>0?it.subs.join(', '):'';
      h+='<div class="prof-perm-row">';
      h+='<div class="prof-perm-name">'+esc(it.name)+'</div>';
      h+='<label class="toggle-switch"><input type="checkbox" data-permid="'+it.id+'"'+(isOn?' checked':'')+(prof.id==='super_admin'?' disabled':'')+'/><span class="toggle-track"></span><span class="toggle-knob"></span></label>';
      if(subsText)h+='<span class="prof-perm-detail">'+esc(subsText)+'</span>';
      h+='</div>';
    });
  });

  h+='<div style="margin-top:24px;display:flex;gap:8px">';
  h+='<button class="set-edit-save" id="profSavePerms" style="width:auto;padding:10px 24px">Enregistrer</button>';
  h+='<button class="set-edit-cancel" id="profCancelPerms">Annuler</button>';
  h+='</div>';
  body.innerHTML=h;

  document.getElementById('profBack').onclick=function(){profDetailView=null;renderPermissionsTab();};
  document.getElementById('profCancelPerms').onclick=function(){profDetailView=null;renderPermissionsTab();};
  document.getElementById('profSavePerms').onclick=function(){
    var updatedPerms={};
    body.querySelectorAll('[data-permid]').forEach(function(cb){updatedPerms[cb.dataset.permid]=cb.checked;});
    prof.perms=updatedPerms;
    db.collection('crm_profiles').doc(prof.id).set({name:prof.name,description:prof.description,color:prof.color,perms:updatedPerms,updatedAt:firebase.firestore.FieldValue.serverTimestamp()}).then(function(){
      toast('✅ Permissions "'+prof.name+'" sauvegardées');
    }).catch(function(err){toast('❌ '+err.message);});
  };
}

/* ── Fields Tab ── */
var FIELD_MODULES=[
  {id:'leads',name:'Pipeline / Affaires',icon:'📋',fields:[
    {key:'nom',label:'Nom',type:'Texte',required:true,system:true},
    {key:'telephone',label:'Portable',type:'Téléphone',required:false,system:true},
    {key:'email',label:'E-mail',type:'Email (Unique)',required:false,system:true},
    {key:'stage',label:'Étape',type:'Liste déroulante',required:true,system:true},
    {key:'assignedTo',label:'Gestionnaire de l\'Affaire',type:'Utilisateur',required:false,system:true},
    {key:'type',label:'Origine du Prospect',type:'Liste déroulante',required:false,system:true},
    {key:'status',label:'Statut Leads Live',type:'Liste déroulante',required:false,system:true},
    {key:'utm',label:'Source / UTM',type:'Texte',required:false,system:false},
    {key:'secteur',label:'Secteur',type:'Texte',required:false,system:false},
    {key:'ca',label:'CA actuel',type:'Texte',required:false,system:false},
    {key:'defi',label:'Défi',type:'Texte',required:false,system:false},
    {key:'closeur',label:'Closeur',type:'Texte',required:false,system:false},
    {key:'setting',label:'Setting',type:'Texte',required:false,system:false},
    {key:'tags',label:'Balises',type:'Multi-valeurs',required:false,system:true},
    {key:'tagsWebi',label:'Tags Webinaire',type:'Texte',required:false,system:false},
    {key:'dateWebinaire',label:'Date Webinaire',type:'Date',required:false,system:false},
    {key:'rejetMails',label:'Rejet des mails',type:'Booléen',required:false,system:false},
    {key:'description',label:'Description',type:'Zone de texte',required:false,system:false},
    {key:'notesHistory',label:'Notes',type:'Sous-collection',required:false,system:true},
    {key:'createdAt',label:'Heure de création',type:'Date/Heure',required:true,system:true},
    {key:'updatedAt',label:'Heure de modification',type:'Date/Heure',required:false,system:true},
    {key:'importedCreatedAt',label:'Date originale (import)',type:'Date/Heure',required:false,system:true}
  ]},
  {id:'clients',name:'Coaching / Clients',icon:'🎓',fields:[
    {key:'nom',label:'Nom',type:'Texte',required:true,system:true},
    {key:'prenom',label:'Prénom',type:'Texte',required:false,system:true},
    {key:'email',label:'E-mail',type:'Email',required:false,system:true},
    {key:'telephone',label:'Téléphone',type:'Téléphone',required:false,system:true},
    {key:'coach',label:'Coach assigné',type:'Utilisateur',required:true,system:true},
    {key:'programme',label:'Programme',type:'Liste déroulante',required:false,system:false},
    {key:'dateInscription',label:'Date d\'inscription',type:'Date',required:false,system:false},
    {key:'dateFin',label:'Date fin de programme',type:'Date',required:false,system:false},
    {key:'retractation',label:'Rétractation',type:'Booléen',required:false,system:false},
    {key:'coaching72h',label:'Coaching 72H',type:'Booléen',required:false,system:false},
    {key:'coach72h',label:'Coach Coaching 72H',type:'Utilisateur',required:false,system:false}
  ]},
  {id:'bookings',name:'Bookings',icon:'📅',fields:[
    {key:'nom',label:'Nom du contact',type:'Texte',required:true,system:true},
    {key:'email',label:'E-mail',type:'Email',required:true,system:true},
    {key:'telephone',label:'Téléphone',type:'Téléphone',required:false,system:true},
    {key:'date',label:'Date du RDV',type:'Date/Heure',required:true,system:true},
    {key:'type',label:'Type de RDV',type:'Liste déroulante',required:false,system:true},
    {key:'status',label:'Statut',type:'Liste déroulante',required:true,system:true}
  ]}
];

var fieldsVisibility=null;
var activeFieldModule=0;

function loadFieldsVisibility(){
  var saved=localStorage.getItem('crm_fields_visibility');
  if(saved){try{fieldsVisibility=JSON.parse(saved);}catch(e){fieldsVisibility={};}}
  if(!fieldsVisibility)fieldsVisibility={};
}
loadFieldsVisibility();

function saveFieldsVisibility(){localStorage.setItem('crm_fields_visibility',JSON.stringify(fieldsVisibility));}

function isFieldVisible(modId,fieldKey){
  if(!fieldsVisibility[modId])return true;
  if(fieldsVisibility[modId][fieldKey]===false)return false;
  return true;
}

function renderFieldsTab(){
  var body=document.getElementById('setBody');
  var mod=FIELD_MODULES[activeFieldModule];
  var customN=mod.fields.filter(function(f){return !f.system;}).length;

  var h='<div class="fields-layout">';

  // Sidebar
  h+='<div class="fields-sidebar">';
  h+='<div style="font-family:var(--fh);font-size:13px;font-weight:800;margin-bottom:12px">Champs de module</div>';
  FIELD_MODULES.forEach(function(m,idx){
    var cn=m.fields.filter(function(f){return !f.system;}).length;
    h+='<div class="fields-mod-card'+(idx===activeFieldModule?' active':'')+'" data-fieldmod="'+idx+'">';
    h+='<div class="fields-mod-name"><span>'+m.icon+'</span> '+esc(m.name)+'</div>';
    h+='<div class="fields-mod-meta">'+m.fields.length+' champs · '+cn+' personnalisés</div>';
    h+='</div>';
  });
  h+='</div>';

  // Main
  h+='<div class="fields-main">';
  h+='<div class="fields-header">';
  h+='<span class="fields-header-title">'+mod.icon+' '+esc(mod.name)+'</span>';
  h+='<span class="fields-header-count">Champs personnalisés : <b>'+customN+'/50</b></span>';
  h+='<button class="set-add-user-btn" id="fieldAddBtn" style="font-size:11px;padding:6px 12px;margin-left:auto">+ Ajouter un champ</button>';
  h+='</div>';

  h+='<table class="fields-table"><colgroup><col style="width:24px"/><col/><col style="width:90px"/><col style="width:46px"/><col style="width:50px"/><col style="width:36px"/></colgroup><thead><tr>';
  h+='<th style="width:24px"></th>';
  h+='<th>Nom du champ</th>';
  h+='<th style="width:100px">Type</th>';
  h+='<th class="center" style="width:60px">Requis</th>';
  h+='<th class="center" style="width:60px">Visible</th>';
  h+='<th class="center" style="width:36px"></th>';
  h+='</tr></thead><tbody>';

  var typeColors={Texte:'#60a5fa','Zone de texte':'#60a5fa',Email:'#34d399','Email (Unique)':'#34d399','Téléphone':'#f59e0b',Date:'#a78bfa','Date/Heure':'#a78bfa','Liste déroulante':'#ec4899',Utilisateur:'#f97316','Booléen':'#14b8a6','Multi-valeurs':'#8b5cf6','Sous-collection':'#6b7280'};

  mod.fields.forEach(function(f){
    var vis=isFieldVisible(mod.id,f.key);
    var tc=typeColors[f.type]||'#6b7280';
    h+='<tr'+(vis?'':' class="dim"')+'>';
    h+='<td class="field-drag">⠿</td>';
    h+='<td><div class="field-name-cell">';
    if(f.system)h+='<span class="field-sys-dot" title="Système"></span>';
    h+='<span class="field-label">'+esc(f.label)+'</span> ';
    h+='<span class="field-key">'+esc(f.key)+'</span>';
    h+='</div></td>';
    h+='<td><span class="field-type-badge" style="background:'+tc+'14;color:'+tc+';cursor:pointer" data-ftypeidx="'+mod.fields.indexOf(f)+'" title="Cliquer pour changer">'+esc(f.type)+' ▾</span></td>';
    h+='<td class="center">'+(f.required?'<span style="color:var(--green)">●</span>':'<span style="color:var(--muted2)">○</span>')+'</td>';
    h+='<td class="center"><label class="toggle-switch"><input type="checkbox" data-fvis="'+f.key+'"'+(vis?' checked':'')+(f.required?' disabled':'')+'/><span class="toggle-track"></span><span class="toggle-knob"></span></label></td>';
    h+='<td class="center"><button style="width:24px;height:24px;border-radius:5px;border:1px solid var(--border);background:transparent;color:var(--muted);cursor:pointer;font-size:10px;display:inline-flex;align-items:center;justify-content:center" data-ffieldedit="'+mod.fields.indexOf(f)+'" title="Modifier le champ">✏</button></td>';
    h+='</tr>';
  });
  h+='</tbody></table>';
  h+='<div style="margin-top:12px"><button class="set-edit-save" id="fieldSaveBtn" style="width:auto;padding:8px 20px;font-size:12px">Enregistrer</button></div>';
  h+='</div></div>';

  body.innerHTML=h;

  body.querySelectorAll('[data-fieldmod]').forEach(function(el){
    el.addEventListener('click',function(){activeFieldModule=parseInt(this.dataset.fieldmod);renderFieldsTab();});
  });
  document.getElementById('fieldSaveBtn').addEventListener('click',function(){
    var modId=FIELD_MODULES[activeFieldModule].id;
    if(!fieldsVisibility[modId])fieldsVisibility[modId]={};
    body.querySelectorAll('[data-fvis]').forEach(function(cb){fieldsVisibility[modId][cb.dataset.fvis]=cb.checked;});
    saveFieldsVisibility();toast('✅ Configuration sauvegardée');
  });
  document.getElementById('fieldAddBtn').addEventListener('click',function(){
    var label=prompt('Nom du nouveau champ :');if(!label||!label.trim())return;
    var key=label.trim().toLowerCase().replace(/[^a-z0-9àâéèêëïîôùûüç]/g,'_');
    var typeIdx=prompt('Type :\n1. Texte\n2. Zone de texte\n3. Email\n4. Téléphone\n5. Date\n6. Date/Heure\n7. Liste déroulante\n8. Booléen\n9. Multi-valeurs');
    var types=['Texte','Zone de texte','Email','Téléphone','Date','Date/Heure','Liste déroulante','Booléen','Multi-valeurs'];
    var type=types[parseInt(typeIdx)-1]||'Texte';
    FIELD_MODULES[activeFieldModule].fields.push({key:key,label:label.trim(),type:type,required:false,system:false});
    toast('✅ Champ "'+label.trim()+'" ajouté');renderFieldsTab();
  });

  // Type change on badge click
  body.addEventListener('click',function(e){
    var badge=e.target.closest('[data-ftypeidx]');
    if(!badge)return;
    var idx=parseInt(badge.dataset.ftypeidx);
    var mod2=FIELD_MODULES[activeFieldModule];
    var field=mod2.fields[idx];
    if(!field||field.system)return;

    // Remove any existing dropdown
    var old=document.getElementById('fieldTypeDD');if(old)old.remove();

    var types=['Texte','Zone de texte','Email','Téléphone','Date','Date/Heure','Liste déroulante','Utilisateur','Booléen','Multi-valeurs'];
    var typeColors2={Texte:'#60a5fa','Zone de texte':'#60a5fa',Email:'#34d399',Téléphone:'#f59e0b',Date:'#a78bfa','Date/Heure':'#a78bfa','Liste déroulante':'#ec4899',Utilisateur:'#f97316',Booléen:'#14b8a6','Multi-valeurs':'#8b5cf6'};

    var dd=document.createElement('div');
    dd.id='fieldTypeDD';
    dd.style.cssText='position:absolute;z-index:20;width:160px;background:var(--bg2);border:1.5px solid var(--border2);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.5);padding:4px;max-height:240px;overflow-y:auto';
    var dh='';
    types.forEach(function(t){
      var tc2=typeColors2[t]||'#6b7280';
      var isActive=field.type===t;
      dh+='<div data-ftypeval="'+t+'" style="padding:6px 10px;border-radius:6px;cursor:pointer;font-size:11px;font-weight:600;display:flex;align-items:center;gap:6px;transition:all .1s;'+(isActive?'background:rgba(185,28,28,0.1);color:var(--red3)':'color:var(--item-text)')+'">';
      dh+='<span style="font-size:8px;font-weight:700;padding:2px 5px;border-radius:3px;background:'+tc2+'14;color:'+tc2+'">'+t+'</span>';
      if(isActive)dh+=' ✓';
      dh+='</div>';
    });
    dd.innerHTML=dh;

    var rect=badge.getBoundingClientRect();
    var panelRect=document.getElementById('settingsPanel').getBoundingClientRect();
    dd.style.left=(rect.left-panelRect.left)+'px';
    dd.style.top=(rect.bottom-panelRect.top+4)+'px';
    document.getElementById('settingsPanel').appendChild(dd);

    dd.addEventListener('click',function(ev){
      var item=ev.target.closest('[data-ftypeval]');
      if(item){
        field.type=item.dataset.ftypeval;
        dd.remove();
        toast('✅ Type → '+field.type);
        renderFieldsTab();
      }
    });

    // Close on click outside
    setTimeout(function(){
      document.addEventListener('click',function closeFTDD(ev){
        if(!ev.target.closest('#fieldTypeDD')&&!ev.target.closest('[data-ftypeidx]')){
          var el=document.getElementById('fieldTypeDD');if(el)el.remove();
          document.removeEventListener('click',closeFTDD);
        }
      });
    },10);
  });

  // Field edit modal
  body.addEventListener('click',function(e){
    var editBtn=e.target.closest('[data-ffieldedit]');
    if(!editBtn)return;
    var idx=parseInt(editBtn.dataset.ffieldedit);
    var mod3=FIELD_MODULES[activeFieldModule];
    var field=mod3.fields[idx];
    if(!field)return;
    openFieldEditModal(field,idx);
  });
}

/* ── Field Options Storage ── */
var fieldOptionsData=null;
function loadFieldOptions(){
  var saved=localStorage.getItem('crm_field_options');
  if(saved){try{fieldOptionsData=JSON.parse(saved);}catch(e){fieldOptionsData={};}}
  if(!fieldOptionsData)fieldOptionsData={};
}
loadFieldOptions();
function saveFieldOptions(){localStorage.setItem('crm_field_options',JSON.stringify(fieldOptionsData));}
function getFieldOptions(modId,fieldKey){
  if(!fieldOptionsData[modId])return[];
  return fieldOptionsData[modId][fieldKey]||[];
}
function setFieldOptions(modId,fieldKey,opts){
  if(!fieldOptionsData[modId])fieldOptionsData[modId]={};
  fieldOptionsData[modId][fieldKey]=opts;
  saveFieldOptions();
}

function openFieldEditModal(field,fieldIdx){
  var mod=FIELD_MODULES[activeFieldModule];
  var modId=mod.id;
  var opts=getFieldOptions(modId,field.key);
  var isListType=(field.type==='Liste déroulante'||field.type==='Multi-valeurs');

  var overlay=document.createElement('div');
  overlay.className='set-edit-backdrop';
  var h='<div class="set-edit-modal" style="max-width:480px">';
  h+='<div class="set-edit-title">Modifier le champ</div>';

  h+='<div class="set-edit-field"><div class="set-edit-label">Nom du champ</div>';
  h+='<input class="set-edit-input" id="feLabel" value="'+escA(field.label)+'"'+(field.system?' style="opacity:0.6" readonly':'')+'/></div>';

  h+='<div class="set-edit-field"><div class="set-edit-label">Clé Firestore</div>';
  h+='<input class="set-edit-input" id="feKey" value="'+escA(field.key)+'" style="opacity:0.5;font-family:var(--fm)" readonly/></div>';

  h+='<div class="set-edit-field"><div class="set-edit-label">Type</div>';
  h+='<select class="set-edit-select" id="feType"'+(field.system?' disabled':'')+'>';
  var allTypes=['Texte','Zone de texte','Email','Téléphone','Date','Date/Heure','Liste déroulante','Utilisateur','Booléen','Multi-valeurs'];
  allTypes.forEach(function(t){h+='<option value="'+t+'"'+(field.type===t?' selected':'')+'>'+t+'</option>';});
  h+='</select></div>';

  // Options section (for Liste / Multi-valeurs)
  h+='<div id="feOptionsSection" style="'+(isListType?'':'display:none')+'">';
  h+='<div class="set-edit-label" style="margin-top:14px">Options de la liste</div>';
  h+='<div id="feOptionsList" style="margin-top:6px">';
  if(opts.length>0){
    opts.forEach(function(opt,oi){
      h+='<div style="display:flex;gap:6px;align-items:center;margin-bottom:4px">';
      h+='<span style="font-family:var(--fm);font-size:10px;color:var(--muted);width:20px;text-align:center">'+(oi+1)+'</span>';
      h+='<input class="set-edit-input fe-opt-input" data-optidx="'+oi+'" value="'+escA(opt)+'" style="font-size:12px;padding:6px 10px"/>';
      h+='<button class="fe-opt-del" data-optdel="'+oi+'" style="width:24px;height:24px;border-radius:5px;border:1px solid var(--border);background:transparent;color:var(--muted);cursor:pointer;font-size:10px;flex-shrink:0">✕</button>';
      h+='</div>';
    });
  } else {
    h+='<div style="font-size:11px;color:var(--muted2);padding:8px 0">Aucune option définie</div>';
  }
  h+='</div>';
  h+='<div style="display:flex;gap:6px;margin-top:6px">';
  h+='<input class="set-edit-input" id="feNewOpt" placeholder="Nouvelle option..." style="flex:1;font-size:12px;padding:6px 10px"/>';
  h+='<button id="feAddOpt" style="padding:6px 12px;border:none;border-radius:8px;background:rgba(52,211,153,0.1);color:var(--green);font-family:var(--fb);font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap">+ Ajouter</button>';
  h+='</div></div>';

  h+='<div class="set-edit-actions"><button class="set-edit-cancel" id="feCancel">Annuler</button><button class="set-edit-save" id="feSave">Sauvegarder</button></div>';
  h+='</div>';

  overlay.innerHTML=h;
  overlay.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:900;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px)';
  document.body.appendChild(overlay);

  // Toggle options section on type change
  document.getElementById('feType').addEventListener('change',function(){
    var show=(this.value==='Liste déroulante'||this.value==='Multi-valeurs');
    document.getElementById('feOptionsSection').style.display=show?'':'none';
  });

  // Add option
  document.getElementById('feAddOpt').addEventListener('click',function(){
    var input=document.getElementById('feNewOpt');
    var val=input.value.trim();
    if(!val)return;
    opts.push(val);
    input.value='';
    refreshOptsList();
  });
  document.getElementById('feNewOpt').addEventListener('keydown',function(e){
    if(e.key==='Enter'){e.preventDefault();document.getElementById('feAddOpt').click();}
  });

  // Delete option (delegated)
  document.getElementById('feOptionsList').addEventListener('click',function(e){
    var del=e.target.closest('[data-optdel]');
    if(del){opts.splice(parseInt(del.dataset.optdel),1);refreshOptsList();}
  });

  // Update option text on input
  document.getElementById('feOptionsList').addEventListener('input',function(e){
    var inp=e.target.closest('[data-optidx]');
    if(inp)opts[parseInt(inp.dataset.optidx)]=inp.value;
  });

  function refreshOptsList(){
    var lh='';
    if(opts.length>0){
      opts.forEach(function(opt,oi){
        lh+='<div style="display:flex;gap:6px;align-items:center;margin-bottom:4px">';
        lh+='<span style="font-family:var(--fm);font-size:10px;color:var(--muted);width:20px;text-align:center">'+(oi+1)+'</span>';
        lh+='<input class="set-edit-input fe-opt-input" data-optidx="'+oi+'" value="'+escA(opt)+'" style="font-size:12px;padding:6px 10px"/>';
        lh+='<button class="fe-opt-del" data-optdel="'+oi+'" style="width:24px;height:24px;border-radius:5px;border:1px solid var(--border);background:transparent;color:var(--muted);cursor:pointer;font-size:10px;flex-shrink:0">✕</button>';
        lh+='</div>';
      });
    } else {
      lh+='<div style="font-size:11px;color:var(--muted2);padding:8px 0">Aucune option définie</div>';
    }
    document.getElementById('feOptionsList').innerHTML=lh;
  }

  // Cancel
  document.getElementById('feCancel').addEventListener('click',function(){overlay.remove();});
  overlay.addEventListener('click',function(e){if(e.target===overlay)overlay.remove();});

  // Save
  document.getElementById('feSave').addEventListener('click',function(){
    var newLabel=document.getElementById('feLabel').value.trim();
    var newType=document.getElementById('feType').value;
    if(newLabel&&!field.system)field.label=newLabel;
    if(!field.system)field.type=newType;

    // Save options if list type
    if(newType==='Liste déroulante'||newType==='Multi-valeurs'){
      // Collect current opts from inputs
      var currentOpts=[];
      document.querySelectorAll('.fe-opt-input').forEach(function(inp){
        var v=inp.value.trim();if(v)currentOpts.push(v);
      });
      setFieldOptions(modId,field.key,currentOpts);
    }

    overlay.remove();
    toast('✅ Champ "'+field.label+'" modifié');
    renderFieldsTab();
  });
}

/* ═══ FIRESTORE ═══ */
var leadsUnsub=null;
function startLeadsListener(){
  if(leadsUnsub)leadsUnsub();
  crmDataLoaded=false;
  var board=document.getElementById('crmBoard');
  if(board)board.innerHTML='<div style="display:flex;align-items:center;justify-content:center;width:100%;padding:60px 20px;color:var(--muted);font-size:14px;font-weight:600;gap:10px"><span class="crm-spinner"></span> Chargement des leads…</div>';
  var sixMonthsAgo=new Date();sixMonthsAgo.setMonth(sixMonthsAgo.getMonth()-6);
  var q=db.collection('leads').orderBy('createdAt','desc');
  if(archiveMode==='recent'){
    q=q.where('createdAt','>',sixMonthsAgo).limit(5000);
  } else {
    q=q.where('createdAt','<=',sixMonthsAgo).limit(5000);
  }
  leadsUnsub=q.onSnapshot(function(snap){
    allLeads=[];
    snap.forEach(function(doc){
      var d=doc.data();d.id=doc.id;
      if(!d.stage)d.stage='lead';
      allLeads.push(d);
    });
    crmDataLoaded=true;colCardLimits={};buildBoard();collectTags();renderAll();renderSavedViews();renderActiveChips();
    document.getElementById('statTotal').textContent=allLeads.length;
  },function(err){
    console.error('[crm] onSnapshot error:',err);
    if(board)board.innerHTML='<div style="display:flex;align-items:center;justify-content:center;width:100%;padding:60px 20px;color:var(--red3);font-size:13px;font-weight:600">⚠ Erreur de chargement. Rechargez la page.</div>';
  });
}

/* ═══ ARCHIVE TOGGLE ═══ */
document.getElementById('fbArchiveToggle').addEventListener('click',function(e){
  var btn=e.target.closest('[data-archive]');if(!btn)return;
  var mode=btn.dataset.archive;if(mode===archiveMode)return;
  archiveMode=mode;
  document.querySelectorAll('.fb-archive-btn').forEach(function(b){b.classList.remove('active');});
  btn.classList.add('active');
  startLeadsListener();
});

/* ═══ AUTH ═══ */
/* ═══ TEAM MEMBERS — initialisation et re-render ═══ */
function onTeamMembersReadyCrm(){
  rebuildTeamDependentConfig();
  // Si les leads sont déjà chargés, force un re-render complet
  if(crmDataLoaded){
    if(typeof renderSavedViews==='function')renderSavedViews();
    if(typeof renderAll==='function')renderAll();
  }
}
window.addEventListener('team-members-loaded',onTeamMembersReadyCrm);
if(typeof window.loadTeamMembers==='function'){
  window.loadTeamMembers().then(onTeamMembersReadyCrm);
}

firebase.auth().onAuthStateChanged(function(user){if(user){db.collection('users').doc(user.uid).get().then(function(snap){var d=snap.exists?snap.data():{};window._currentRole=d.role||'sales';window._currentUserName=user.displayName||user.email.split('@')[0];localStorage.setItem('ambitio_role',d.role||'sales');localStorage.setItem('ambitio_name',window._currentUserName);startLeadsListener();loadSavedViews();}).catch(function(){startLeadsListener();loadSavedViews();});}else{var board=document.getElementById('crmBoard');if(board)board.innerHTML='<div style="display:flex;align-items:center;justify-content:center;width:100%;padding:60px 20px;color:var(--muted);font-size:13px;font-weight:600">🔒 Connexion requise</div>';}});

/* ═══ Clients badge counter (le panel a été déplacé vers sales-clients.html) ═══ */
var _crmClientsCount = 0;
function _updateCrmClientsBadge() {
  var el = document.getElementById('crmClientsCount');
  if (el) {
    el.textContent = _crmClientsCount || '';
    el.style.display = _crmClientsCount ? '' : 'none';
  }
}
db.collection('leads').where('isClient', '==', true).onSnapshot(function(sn) {
  _crmClientsCount = sn.size;
  _updateCrmClientsBadge();
});

/* ═══ Mark as Client (depuis le modal lead) ═══ */
window.markAsClient = function(leadId) {
  if (!confirm('Marquer ce lead comme client actif ?')) return;
  db.collection('leads').doc(leadId).update({
    isClient: true,
    clientStatus: 'active',
    clientSince: firebase.firestore.FieldValue.serverTimestamp(),
    timeline_history: firebase.firestore.FieldValue.arrayUnion({
      text: '👥 Passé en client actif (manuel)',
      date: new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }),
      color: '#10b981'
    }),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  }).then(function() {
    if (typeof toast === 'function') toast('👥 Lead passé en client !');
  });
};
