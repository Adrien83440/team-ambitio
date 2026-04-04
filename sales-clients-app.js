/* ═══════════════════════════════════════════
   Gestion Clients — Ambitio Corp
   sales-clients-app.js
   ═══════════════════════════════════════════ */
var db = firebase.firestore();

/* ═══ CONFIG ═══ */
var COACHES = [
  {key:'mickael',label:'Mickael'},
  {key:'edouard',label:'Edouard'},
  {key:'emily',label:'Emily'},
  {key:'adrien',label:'Adrien'}
];
var COACH_MAP = {};
COACHES.forEach(function(c){ COACH_MAP[c.key] = c.label; });

var TEMO_TYPES = [
  {key:'trustpilot',label:'Trustpilot',icon:'⭐'},
  {key:'video',label:'Vidéo',icon:'🎥'},
  {key:'screenshot',label:'Screenshot',icon:'📸'},
  {key:'autre',label:'Autre',icon:'📎'}
];

var ALERT_DAYS_FIN = 14;      // alerte si fin dans ≤14 jours
var ALERT_WEEKS_TEMO = 4;     // alerte si >4 semaines sans témoignage

/* ═══ STATE ═══ */
var allClients = [];
var temoCache = {};   // leadId -> [temo objects]
var noteCache = {};   // leadId -> [note objects]
var filterStatut = 'all';
var filterCoach = 'all';
var searchQuery = '';
var sortKey = 'accompagnementFin';
var sortDir = 'asc';
var openLeadId = null;
var saveTimer = null;
var dataLoaded = false;

/* ═══ UTILS ═══ */
function esc(s){ var d=document.createElement('div'); d.textContent=s||''; return d.innerHTML; }
function escA(s){ return (s||'').replace(/"/g,'&quot;'); }
function toast(msg){ var t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); setTimeout(function(){ t.classList.remove('show'); },2500); }

function fmtDate(d){
  if(!d) return '—';
  if(d.toDate) d = d.toDate();
  if(typeof d === 'string') d = new Date(d);
  if(isNaN(d.getTime())) return '—';
  var dd=String(d.getDate()).padStart(2,'0');
  var mm=String(d.getMonth()+1).padStart(2,'0');
  return dd+'/'+mm+'/'+d.getFullYear();
}

function toDateObj(v){
  if(!v) return null;
  if(v.toDate) return v.toDate();
  if(typeof v === 'string'){ var d=new Date(v); return isNaN(d.getTime())?null:d; }
  if(v instanceof Date) return v;
  return null;
}

function daysBetween(a,b){
  if(!a||!b) return null;
  return Math.ceil((b.getTime()-a.getTime())/86400000);
}

function weeksBetween(a,b){
  var d = daysBetween(a,b);
  return d===null ? null : Math.ceil(d/7);
}

function fmtNow(){
  var n=new Date();
  return String(n.getDate()).padStart(2,'0')+'/'+String(n.getMonth()+1).padStart(2,'0')+'/'+n.getFullYear()+' '+String(n.getHours()).padStart(2,'0')+':'+String(n.getMinutes()).padStart(2,'0');
}

/* ═══ ALERTS ═══ */
function computeAlerts(client){
  var alerts = [];
  var today = new Date();
  today.setHours(0,0,0,0);
  var debut = toDateObj(client.accompagnementDebut);
  var fin   = toDateObj(client.accompagnementFin);

  if(fin){
    var daysLeft = daysBetween(today, fin);
    if(daysLeft !== null && daysLeft <= 0){
      alerts.push({type:'ended',cls:'fin',label:'Terminé',icon:'⏹'});
    } else if(daysLeft !== null && daysLeft <= ALERT_DAYS_FIN){
      alerts.push({type:'ending_soon',cls:'fin',label:'Fin dans '+daysLeft+'j',icon:'🔴'});
    }
    // Mi-parcours
    if(debut && daysLeft > 0){
      var totalDays = daysBetween(debut, fin);
      var elapsed   = daysBetween(debut, today);
      if(totalDays > 0 && elapsed >= totalDays/2){
        alerts.push({type:'midpoint',cls:'mid',label:'Mi-parcours',icon:'🟡'});
      }
    }
  }
  // Témoignage manquant
  var temos = temoCache[client.id] || [];
  if(temos.length === 0 && debut){
    var weeksActive = weeksBetween(debut, today);
    if(weeksActive !== null && weeksActive >= ALERT_WEEKS_TEMO){
      alerts.push({type:'no_temo',cls:'temo',label:'Pas de témoignage',icon:'🟣'});
    }
  }
  return alerts;
}

function getClientStatus(client){
  var today = new Date(); today.setHours(0,0,0,0);
  var fin = toDateObj(client.accompagnementFin);
  var debut = toDateObj(client.accompagnementDebut);
  if(fin && daysBetween(today, fin) <= 0) return 'termine';
  if(debut) return 'en_cours';
  return 'nouveau';
}

/* ═══ DATA LOADING ═══ */
function startClientsListener(){
  if(dataLoaded) return;
  dataLoaded = true;
  db.collection('leads').where('isClient','==',true)
    .onSnapshot(function(snap){
      allClients = [];
      snap.forEach(function(doc){
        var d = doc.data();
        d.id = doc.id;
        allClients.push(d);
      });
      // Load temoignages for all clients
      loadAllTemoignages(function(){
        renderAll();
      });
    }, function(err){
      console.error('Clients listener error:', err);
      document.getElementById('loadingState').innerHTML = '<span style="color:var(--red2)">❌ Erreur : '+esc(err.message)+'</span>';
    });
}

function loadAllTemoignages(cb){
  var pending = allClients.length;
  if(pending === 0){ if(cb) cb(); return; }
  allClients.forEach(function(client){
    db.collection('leads').doc(client.id).collection('client_temoignages')
      .orderBy('createdAt','desc').get()
      .then(function(snap){
        var arr = [];
        snap.forEach(function(d){ var o=d.data(); o.id=d.id; arr.push(o); });
        temoCache[client.id] = arr;
        pending--;
        if(pending <= 0 && cb) cb();
      }).catch(function(){
        temoCache[client.id] = temoCache[client.id] || [];
        pending--;
        if(pending <= 0 && cb) cb();
      });
  });
}

function loadTemoignages(leadId, cb){
  db.collection('leads').doc(leadId).collection('client_temoignages')
    .orderBy('createdAt','desc').get()
    .then(function(snap){
      var arr = [];
      snap.forEach(function(d){ var o=d.data(); o.id=d.id; arr.push(o); });
      temoCache[leadId] = arr;
      if(cb) cb(arr);
    }).catch(function(){ if(cb) cb(temoCache[leadId]||[]); });
}

function loadNotes(leadId, cb){
  db.collection('leads').doc(leadId).collection('client_notes')
    .orderBy('createdAt','desc').get()
    .then(function(snap){
      var arr = [];
      snap.forEach(function(d){ var o=d.data(); o.id=d.id; arr.push(o); });
      noteCache[leadId] = arr;
      if(cb) cb(arr);
    }).catch(function(){ if(cb) cb(noteCache[leadId]||[]); });
}

/* ═══ AUTH ═══ */
firebase.auth().onAuthStateChanged(function(user){
  if(user){
    startClientsListener();
  } else {
    window.location.href = 'login.html';
  }
});

/* ═══ FILTERING & SORTING ═══ */
function getFiltered(){
  var list = allClients.slice();
  // Search
  if(searchQuery){
    var q = searchQuery.toLowerCase();
    list = list.filter(function(c){
      return (c.nom||'').toLowerCase().indexOf(q) >= 0 ||
             (c.commerce||'').toLowerCase().indexOf(q) >= 0 ||
             (c.email||'').toLowerCase().indexOf(q) >= 0;
    });
  }
  // Coach filter
  if(filterCoach !== 'all'){
    list = list.filter(function(c){
      if(filterCoach === '') return !c.coachAssigned;
      return c.coachAssigned === filterCoach;
    });
  }
  // Statut filter
  if(filterStatut !== 'all'){
    if(filterStatut === 'alerte'){
      list = list.filter(function(c){ return computeAlerts(c).length > 0; });
    } else {
      list = list.filter(function(c){ return getClientStatus(c) === filterStatut; });
    }
  }
  // Sort
  list.sort(function(a,b){
    var va, vb;
    if(sortKey === 'nom'){ va=(a.nom||'').toLowerCase(); vb=(b.nom||'').toLowerCase(); }
    else if(sortKey === 'coachAssigned'){ va=a.coachAssigned||''; vb=b.coachAssigned||''; }
    else if(sortKey === 'accompagnementDebut' || sortKey === 'accompagnementFin' || sortKey === 'clientSince'){
      va = toDateObj(a[sortKey]); vb = toDateObj(b[sortKey]);
      va = va ? va.getTime() : 0; vb = vb ? vb.getTime() : 0;
    }
    else if(sortKey === 'temoignages'){ va=(temoCache[a.id]||[]).length; vb=(temoCache[b.id]||[]).length; }
    else if(sortKey === 'alertes'){ va=computeAlerts(a).length; vb=computeAlerts(b).length; }
    else { va=(a[sortKey]||'').toString().toLowerCase(); vb=(b[sortKey]||'').toString().toLowerCase(); }
    if(va < vb) return sortDir==='asc' ? -1 : 1;
    if(va > vb) return sortDir==='asc' ? 1 : -1;
    return 0;
  });
  return list;
}

/* ═══ RENDER ═══ */
function renderAll(){
  var list = getFiltered();
  updateStats(list);
  renderTable(list);
  // Refresh panel if open
  if(openLeadId) refreshPanel();
}

function updateStats(list){
  var total = allClients.length;
  var enCours = 0, termines = 0, alertCount = 0, temoTotal = 0;
  allClients.forEach(function(c){
    var st = getClientStatus(c);
    if(st === 'en_cours') enCours++;
    if(st === 'termine') termines++;
    if(computeAlerts(c).length > 0) alertCount++;
    temoTotal += (temoCache[c.id]||[]).length;
  });
  document.getElementById('statTotal').textContent = total;
  document.getElementById('statEnCours').textContent = enCours;
  document.getElementById('statTermines').textContent = termines;
  document.getElementById('statAlertes').textContent = alertCount;
  document.getElementById('statTemo').textContent = temoTotal;
}

function renderTable(list){
  var container = document.getElementById('tableBody');
  if(list.length === 0){
    container.innerHTML = '<div class="cl-empty"><div class="cl-empty-icon">👥</div><div class="cl-empty-text">Aucun client trouvé</div></div>';
    return;
  }
  var h = '<table class="cl-table"><thead><tr>';
  var cols = [
    {key:'nom',label:'Client',w:'200px'},
    {key:'coachAssigned',label:'Coach',w:'100px'},
    {key:'accompagnementDebut',label:'Début',w:'100px'},
    {key:'accompagnementFin',label:'Fin',w:'100px'},
    {key:'_weeks',label:'Sem.',w:'70px'},
    {key:'_status',label:'Statut',w:'100px'},
    {key:'alertes',label:'Alertes',w:'160px'},
    {key:'temoignages',label:'Tém.',w:'60px'}
  ];
  cols.forEach(function(col){
    var isSorted = (sortKey === col.key);
    var arrow = isSorted ? (sortDir === 'asc' ? '↑' : '↓') : '↕';
    var sortable = col.key !== '_weeks' && col.key !== '_status';
    h += '<th style="width:'+col.w+'"'+(sortable?' data-sortcol="'+col.key+'"':'')+' class="'+(isSorted?'sorted':'')+'">';
    h += esc(col.label);
    if(sortable) h += ' <span class="sort-arrow">'+arrow+'</span>';
    h += '</th>';
  });
  h += '</tr></thead><tbody>';
  var today = new Date(); today.setHours(0,0,0,0);
  list.forEach(function(c){
    var alerts = computeAlerts(c);
    var status = getClientStatus(c);
    var debut = toDateObj(c.accompagnementDebut);
    var fin   = toDateObj(c.accompagnementFin);
    var weeksLeft = (fin && status !== 'termine') ? weeksBetween(today, fin) : null;
    var temoCount = (temoCache[c.id]||[]).length;
    var rowClass = openLeadId === c.id ? ' active-row' : '';

    h += '<tr data-lid="'+c.id+'" class="'+rowClass+'">';
    // Client
    h += '<td><div class="cl-client-name">'+esc(c.nom||'—')+'</div>';
    if(c.commerce) h += '<div class="cl-client-commerce">'+esc(c.commerce)+'</div>';
    h += '</td>';
    // Coach
    h += '<td>';
    if(c.coachAssigned) h += '<span class="cl-coach-badge">'+esc(COACH_MAP[c.coachAssigned]||c.coachAssigned)+'</span>';
    else h += '<span style="color:var(--muted2);font-size:11px">—</span>';
    h += '</td>';
    // Début
    h += '<td class="cl-dates">'+fmtDate(c.accompagnementDebut)+'</td>';
    // Fin
    h += '<td class="cl-dates">'+fmtDate(c.accompagnementFin)+'</td>';
    // Semaines
    h += '<td>';
    if(weeksLeft !== null){
      var wClass = weeksLeft <= 2 ? 'danger' : weeksLeft <= 4 ? 'warning' : 'ok';
      h += '<span class="cl-weeks '+wClass+'">'+weeksLeft+'s</span>';
    } else if(status === 'termine'){
      h += '<span class="cl-weeks ok">FIN</span>';
    } else {
      h += '<span style="color:var(--muted2)">—</span>';
    }
    h += '</td>';
    // Statut
    h += '<td><span class="cl-status-badge '+status+'">'+({en_cours:'En cours',termine:'Terminé',nouveau:'Nouveau'}[status])+'</span></td>';
    // Alertes
    h += '<td><div class="cl-alert-badges">';
    if(alerts.length === 0) h += '<span style="color:var(--muted2);font-size:11px">—</span>';
    alerts.forEach(function(a){ h += '<span class="cl-alert-badge '+a.cls+'">'+a.icon+' '+esc(a.label)+'</span>'; });
    h += '</div></td>';
    // Témoignages
    h += '<td><span class="cl-temo-count'+(temoCount>0?' has':'')+'">'+temoCount+'</span></td>';
    h += '</tr>';
  });
  h += '</tbody></table>';
  container.innerHTML = h;
}

/* ═══ EVENTS — TOOLBAR ═══ */
document.getElementById('searchInput').addEventListener('input', function(e){
  searchQuery = e.target.value.trim();
  renderAll();
});

document.querySelector('.cl-toolbar').addEventListener('click', function(e){
  var pill = e.target.closest('[data-filter="statut"]');
  if(pill){
    filterStatut = pill.dataset.val;
    document.querySelectorAll('[data-filter="statut"]').forEach(function(p){ p.classList.toggle('active', p.dataset.val === filterStatut); });
    renderAll();
  }
});

document.getElementById('filterCoach').addEventListener('change', function(e){
  filterCoach = e.target.value;
  renderAll();
});

/* ═══ EVENTS — TABLE ═══ */
document.getElementById('tableBody').addEventListener('click', function(e){
  // Sort
  var th = e.target.closest('[data-sortcol]');
  if(th){
    var col = th.dataset.sortcol;
    if(sortKey === col) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    else { sortKey = col; sortDir = 'asc'; }
    renderAll();
    return;
  }
  // Row click -> open panel
  var tr = e.target.closest('tr[data-lid]');
  if(tr) openPanel(tr.dataset.lid);
});

/* ═══ DETAIL PANEL ═══ */
function openPanel(leadId){
  openLeadId = leadId;
  var bg = document.getElementById('panelBg');
  bg.classList.add('open');
  // Load notes & temos then render
  loadNotes(leadId, function(){
    loadTemoignages(leadId, function(){
      refreshPanel();
      renderAll(); // re-render table to highlight active row
    });
  });
}

function closePanel(){
  openLeadId = null;
  document.getElementById('panelBg').classList.remove('open');
  renderAll();
}

function refreshPanel(){
  if(!openLeadId) return;
  var client = null;
  for(var i=0;i<allClients.length;i++){
    if(allClients[i].id===openLeadId){ client=allClients[i]; break; }
  }
  if(!client){ closePanel(); return; }

  var alerts = computeAlerts(client);
  var temos  = temoCache[client.id] || [];
  var notes  = noteCache[client.id] || [];
  var coachColor = '#b91c1c';
  var ini = (client.nom||'?')[0].toUpperCase();

  var h = '';
  // Head
  h += '<div class="cl-panel-head">';
  h += '<div class="cl-panel-av" style="background:linear-gradient(135deg,'+coachColor+','+coachColor+'88)">'+ini+'</div>';
  h += '<div class="cl-panel-name">'+esc(client.nom||'—')+'</div>';
  h += '<a href="sales-contact.html?id='+client.id+'" style="padding:5px 10px;border:1px solid var(--border);border-radius:8px;color:var(--muted);font-size:11px;font-weight:700;text-decoration:none;white-space:nowrap;flex-shrink:0">↗ Fiche Lead</a>';
  h += '<button class="cl-panel-close" data-action="closePanel">✕</button>';
  h += '</div>';

  h += '<div class="cl-panel-body">';

  // ── Alertes ──
  if(alerts.length > 0){
    h += '<div class="cl-section">';
    h += '<div class="cl-section-title">⚠️ Alertes</div>';
    h += '<div class="cl-alert-list">';
    alerts.forEach(function(a){
      h += '<div class="cl-alert-item '+a.cls+'">'+a.icon+' '+esc(a.label)+'</div>';
    });
    h += '</div></div>';
  }

  // ── Informations client ──
  h += '<div class="cl-section">';
  h += '<div class="cl-section-title">📋 Informations</div>';
  h += pField('Nom','nom',client.nom,'text');
  h += pField('Commerce','commerce',client.commerce,'text');
  h += pField('Téléphone','telephone',client.telephone,'text');
  h += pField('Email','email',client.email,'text');
  h += pField('Problématique','problematique',client.problematique,'textarea');
  h += pField('Prob. secondaires','pbSecondaires',client.pbSecondaires,'textarea');
  h += pField('Résultats','resultats',client.resultats,'textarea');
  h += '<div class="cl-saved" id="panelSaved">✅ Sauvegardé</div>';
  h += '</div>';

  // ── Accompagnement ──
  h += '<div class="cl-section">';
  h += '<div class="cl-section-title">📅 Accompagnement</div>';
  h += '<div class="cl-field"><span class="cl-field-label">Coach</span><div class="cl-field-value">';
  h += '<select class="cl-select" data-cedit="coachAssigned">';
  h += '<option value="">— Non assigné —</option>';
  COACHES.forEach(function(c){
    h += '<option value="'+c.key+'"'+(client.coachAssigned===c.key?' selected':'')+'>'+esc(c.label)+'</option>';
  });
  h += '</select></div></div>';
  h += '<div class="cl-field"><span class="cl-field-label">Dates</span><div class="cl-field-value"><div class="cl-date-row">';
  h += '<input class="cl-input" type="date" data-cedit="accompagnementDebut" value="'+(client.accompagnementDebut||'')+'" placeholder="Début"/>';
  h += '<input class="cl-input" type="date" data-cedit="accompagnementFin" value="'+(client.accompagnementFin||'')+'" placeholder="Fin"/>';
  h += '</div></div></div>';
  // Durée calculée
  var deb = toDateObj(client.accompagnementDebut);
  var fin = toDateObj(client.accompagnementFin);
  if(deb && fin){
    var totalWeeks = weeksBetween(deb, fin);
    h += '<div class="cl-field"><span class="cl-field-label">Durée</span><div class="cl-field-value" style="padding-top:7px;font-family:var(--fm);font-size:13px;font-weight:700">'+totalWeeks+' semaines</div></div>';
  }
  h += '</div>';

  // ── Témoignages ──
  h += '<div class="cl-section">';
  h += '<div class="cl-section-title">⭐ Témoignages <span style="font-weight:400;font-size:10px;color:var(--muted);text-transform:none;letter-spacing:0">('+temos.length+')</span></div>';
  if(temos.length === 0){
    h += '<div style="color:var(--muted);font-size:12px;padding:4px 0">Aucun témoignage</div>';
  }
  temos.forEach(function(t){
    h += '<div class="cl-temo-item">';
    h += '<span class="cl-temo-type '+(t.type||'autre')+'">'+esc(t.type||'autre')+'</span>';
    h += '<a class="cl-temo-url" href="'+escA(t.url||'')+'" target="_blank" rel="noopener">'+esc(t.url||'—')+'</a>';
    if(t.label) h += '<span style="font-size:10px;color:var(--muted);flex-shrink:0">'+esc(t.label)+'</span>';
    h += '<button class="cl-temo-del" data-action="delTemo" data-tid="'+t.id+'" title="Supprimer">✕</button>';
    h += '</div>';
  });
  h += '<div class="cl-temo-add">';
  h += '<select class="cl-select" id="temoType" style="width:120px">';
  TEMO_TYPES.forEach(function(t){ h += '<option value="'+t.key+'">'+t.icon+' '+esc(t.label)+'</option>'; });
  h += '</select>';
  h += '<input class="cl-input" id="temoUrl" placeholder="URL du témoignage…"/>';
  h += '<button class="cl-temo-add-btn" data-action="addTemo">+ Ajouter</button>';
  h += '</div>';
  h += '</div>';

  // ── Notes ──
  h += '<div class="cl-section">';
  h += '<div class="cl-section-title">📝 Notes de suivi <span style="font-weight:400;font-size:10px;color:var(--muted);text-transform:none;letter-spacing:0">('+notes.length+')</span></div>';
  notes.forEach(function(n){
    h += '<div class="cl-note-item">';
    h += '<button class="cl-note-del" data-action="delNote" data-nid="'+n.id+'" title="Supprimer" style="float:right">✕</button>';
    h += '<div class="cl-note-meta">';
    if(n.auteur) h += '<span class="cl-note-author">'+esc(n.auteur)+'</span>';
    h += '<span class="cl-note-date">'+fmtDate(n.createdAt)+'</span>';
    h += '</div>';
    h += '<div class="cl-note-text">'+esc(n.contenu||'')+'</div>';
    h += '</div>';
  });
  h += '<div class="cl-note-add">';
  h += '<textarea class="cl-note-textarea" id="noteInput" placeholder="Écrire une note…"></textarea>';
  h += '<button class="cl-note-submit" data-action="addNote">+ Ajouter une note</button>';
  h += '</div>';
  h += '</div>';

  // ── Actions ──
  h += '<div class="cl-section" style="display:flex;gap:8px;flex-wrap:wrap">';
  if(client.telephone){
    h += '<a href="tel:'+escA((client.telephone||'').replace(/\s/g,''))+'" style="flex:1;text-align:center;padding:10px;background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.2);border-radius:10px;color:#34d399;font-weight:700;font-size:13px;text-decoration:none">📞 Appeler</a>';
  }
  if(client.email){
    h += '<a href="mailto:'+escA(client.email)+'" style="flex:1;text-align:center;padding:10px;background:rgba(96,165,250,0.1);border:1px solid rgba(96,165,250,0.2);border-radius:10px;color:#60a5fa;font-weight:700;font-size:13px;text-decoration:none">✉️ Email</a>';
  }
  h += '</div>';

  h += '</div>'; // end cl-panel-body
  document.getElementById('panelContent').innerHTML = h;
}

function pField(label, key, val, type){
  var h = '<div class="cl-field"><span class="cl-field-label">'+esc(label)+'</span><div class="cl-field-value">';
  if(type === 'textarea'){
    h += '<textarea class="cl-input cl-textarea" data-cedit="'+key+'" placeholder="'+escA(label)+'…">'+esc(val||'')+'</textarea>';
  } else {
    h += '<input class="cl-input" data-cedit="'+key+'" type="text" value="'+escA(val||'')+'" placeholder="'+escA(label)+'…"/>';
  }
  h += '</div></div>';
  return h;
}

/* ═══ PANEL EVENTS ═══ */
document.getElementById('panelBg').addEventListener('click', function(e){
  // Close panel on backdrop click
  if(e.target === this){ closePanel(); return; }
  if(e.target.closest('[data-action="closePanel"]')){ closePanel(); return; }

  // Add témoignage
  if(e.target.closest('[data-action="addTemo"]')){
    var url = document.getElementById('temoUrl').value.trim();
    if(!url){ toast('❌ URL requise'); return; }
    var type = document.getElementById('temoType').value;
    var lid = openLeadId;
    db.collection('leads').doc(lid).collection('client_temoignages').add({
      type: type,
      url: url,
      label: '',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    }).then(function(){
      toast('⭐ Témoignage ajouté');
      loadTemoignages(lid, function(){ refreshPanel(); renderAll(); });
    }).catch(function(err){ toast('❌ '+err.message); });
    return;
  }

  // Delete témoignage
  var delTemo = e.target.closest('[data-action="delTemo"]');
  if(delTemo){
    var tid = delTemo.dataset.tid;
    var lid2 = openLeadId;
    if(!confirm('Supprimer ce témoignage ?')) return;
    db.collection('leads').doc(lid2).collection('client_temoignages').doc(tid).delete()
      .then(function(){
        toast('🗑 Témoignage supprimé');
        loadTemoignages(lid2, function(){ refreshPanel(); renderAll(); });
      }).catch(function(err){ toast('❌ '+err.message); });
    return;
  }

  // Add note
  if(e.target.closest('[data-action="addNote"]')){
    var txt = document.getElementById('noteInput').value.trim();
    if(!txt){ toast('❌ Note vide'); return; }
    var lid3 = openLeadId;
    var user = firebase.auth().currentUser;
    db.collection('leads').doc(lid3).collection('client_notes').add({
      contenu: txt,
      auteur: user ? user.email : 'inconnu',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    }).then(function(){
      toast('📝 Note ajoutée');
      loadNotes(lid3, function(){ refreshPanel(); });
    }).catch(function(err){ toast('❌ '+err.message); });
    return;
  }

  // Delete note
  var delNote = e.target.closest('[data-action="delNote"]');
  if(delNote){
    var nid = delNote.dataset.nid;
    var lid4 = openLeadId;
    if(!confirm('Supprimer cette note ?')) return;
    db.collection('leads').doc(lid4).collection('client_notes').doc(nid).delete()
      .then(function(){
        toast('🗑 Note supprimée');
        loadNotes(lid4, function(){ refreshPanel(); });
      }).catch(function(err){ toast('❌ '+err.message); });
    return;
  }
});

// Auto-save on field edit
document.getElementById('panelBg').addEventListener('input', function(e){
  if(!e.target.closest('[data-cedit]')) return;
  if(saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(savePanelFields, 1500);
});
document.getElementById('panelBg').addEventListener('change', function(e){
  if(e.target.closest('[data-cedit]')) savePanelFields();
});

function savePanelFields(){
  if(!openLeadId) return;
  var panel = document.getElementById('panelContent');
  var fields = ['nom','commerce','telephone','email','problematique','pbSecondaires','resultats','coachAssigned','accompagnementDebut','accompagnementFin'];
  var upd = {};
  fields.forEach(function(f){
    var el = panel.querySelector('[data-cedit="'+f+'"]');
    if(el) upd[f] = el.value.trim();
  });
  upd.updatedAt = firebase.firestore.FieldValue.serverTimestamp();

  // Update local cache
  for(var i=0;i<allClients.length;i++){
    if(allClients[i].id === openLeadId){
      for(var k in upd){ if(k !== 'updatedAt') allClients[i][k] = upd[k]; }
      break;
    }
  }

  db.collection('leads').doc(openLeadId).update(upd).then(function(){
    var saved = document.getElementById('panelSaved');
    if(saved){ saved.style.opacity = '1'; setTimeout(function(){ saved.style.opacity = '0'; }, 1500); }
    renderAll();
  }).catch(function(err){ toast('❌ '+err.message); });
}

/* ═══ CLOSE PANEL ON ESCAPE ═══ */
document.addEventListener('keydown', function(e){
  if(e.key === 'Escape' && openLeadId) closePanel();
});

/* ═══ CSV EXPORT ═══ */
document.getElementById('btnExport').addEventListener('click', function(){
  var list = getFiltered();
  var rows = [['Nom','Commerce','Coach','Email','Téléphone','Problématique','Prob. secondaires','Résultats','Début','Fin','Statut','Témoignages']];
  list.forEach(function(c){
    rows.push([
      c.nom||'', c.commerce||'', COACH_MAP[c.coachAssigned]||'',
      c.email||'', c.telephone||'', c.problematique||'', c.pbSecondaires||'',
      c.resultats||'', c.accompagnementDebut||'', c.accompagnementFin||'',
      getClientStatus(c), (temoCache[c.id]||[]).length
    ]);
  });
  var csv = rows.map(function(r){ return r.map(function(v){ return '"'+String(v).replace(/"/g,'""')+'"'; }).join(','); }).join('\n');
  var blob = new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'});
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a'); a.href = url; a.download = 'clients_ambitio.csv'; a.click();
  URL.revokeObjectURL(url);
  toast('📥 Export CSV téléchargé');
});
