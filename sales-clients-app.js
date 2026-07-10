/* ═══════════════════════════════════════════
   Clients — Ambitio Corp · v2
   Consolidation du panel CRM Pipeline + Gestion Clients
   sales-clients-app.js
   ═══════════════════════════════════════════ */
var db = firebase.firestore();

/* ═══ CONFIG ═══ */
/*
 * COACHES + COACH_MAP — source unique _meta/team_members via nav.js
 * (window.TEAM_MEMBERS_ACTIVE). Rebuilt dynamiquement par refreshCoaches() au
 * load initial puis à chaque event `team-members-loaded`. Inclut tous les
 * membres actifs role coach OR admin (cohérence avec coaching.html).
 */
var COACHES = [];
var COACH_MAP = {};

// Fallback hardcoded — utilisé si TEAM_MEMBERS_ACTIVE n'a pas pu être chargé
// (race au premier paint, rules Firestore, erreur réseau). Garantit que les
// dropdowns coach de sales-clients ne sont JAMAIS vides.
var _COACH_FALLBACK_SC = [
  { key: 'thomas',  label: 'Thomas'  },
  { key: 'edouard', label: 'Edouard' },
  { key: 'flore',   label: 'Flore'   },
  { key: 'emily',   label: 'Emily'   },
  { key: 'adrien',  label: 'Adrien'  }
];

function refreshCoaches(){
  COACHES.length = 0;
  Object.keys(COACH_MAP).forEach(function(k){ delete COACH_MAP[k]; });
  var used = false;
  // 1. Mode normal : TEAM_MEMBERS chargé, filtrage inclusif
  //    (exclut sales/setter/closer/closing/csm)
  var EXCLUDED = { sales:1, setter:1, closer:1, closing:1, csm:1 };
  if(window.TEAM_MEMBERS_ACTIVE && window.TEAM_MEMBERS_ACTIVE.length){
    window.TEAM_MEMBERS_ACTIVE.forEach(function(m){
      if(m.role){
        var r = String(m.role).toLowerCase();
        if(EXCLUDED[r]) return;
      }
      var label = m.displayName || m.shortName || m.slug;
      COACHES.push({ key: m.slug, label: label });
      COACH_MAP[m.slug] = label;
      used = true;
    });
  }
  // 2. Fallback : si rien n'a été ajouté (data legacy ou échec chargement)
  if(!used){
    _COACH_FALLBACK_SC.forEach(function(c){
      COACHES.push({ key: c.key, label: c.label });
      COACH_MAP[c.key] = c.label;
    });
  }
  populateClientsCoachFilter();
}

// Peuple le <select id="filterCoach"> dans sales-clients.html.
// Insère les <option> entre "Tous les coachs" (value=all) et "Non assigné" (value="").
// Préserve la valeur sélectionnée si encore présente après refresh.
function populateClientsCoachFilter(){
  var sel = document.getElementById('filterCoach');
  if(!sel) return;
  var prev = sel.value;
  // Conserve les 2 sentinels (Tous + Non assigné) en début et fin de liste
  var html = '<option value="all">Tous les coachs</option>';
  COACHES.forEach(function(c){
    html += '<option value="'+c.key.replace(/"/g,'&quot;')+'">'+c.label.replace(/</g,'&lt;')+'</option>';
  });
  html += '<option value="">Non assigné</option>';
  sel.innerHTML = html;
  if(prev && Array.prototype.some.call(sel.options, function(o){ return o.value === prev; })){
    sel.value = prev;
  }
}

// Tente un premier remplissage synchrone : si TEAM_MEMBERS est déjà chargé
// (cache mémoire d'un nav.js déjà exécuté sur une autre page), on est bons
// immédiatement. Sinon refresh quand team-members-loaded fire.
refreshCoaches();
window.addEventListener('team-members-loaded', function(){
  refreshCoaches();
  // Re-render les vues affectées si déjà rendues
  try {
    if(typeof renderAll === 'function') renderAll();
  } catch(e){ console.warn('[sales-clients] re-render after team-members-loaded failed', e); }
});

var TEMO_TYPES = [
  {key:'trustpilot',label:'Trustpilot',icon:'⭐'},
  {key:'video',label:'Vidéo',icon:'🎥'},
  {key:'screenshot',label:'Screenshot',icon:'📸'},
  {key:'autre',label:'Autre',icon:'📎'}
];

var STATUS_CLIENT = {
  active:    { label:'✅ Actif',     color:'#10b981' },
  paused:    { label:'⏸ En pause',   color:'#f59e0b' },
  completed: { label:'🎉 Terminé',   color:'#a78bfa' },
  stopped:   { label:'🛑 Stoppé',    color:'#ef4444' },
  procedure: { label:'⚖️ Procédure', color:'#f97316' }
};
var STATUS_PAY = {
  draft:'📝 Brouillon', pending_mandate:'⏳ Mandat en attente',
  mandate_active:'✅ Mandat actif', active:'💸 Actifs',
  completed:'🎉 Terminé', failed:'❌ Échec', cancelled:'🚫 Annulé'
};

var ALERT_DAYS_FIN = 14;
var ALERT_WEEKS_TEMO = 4;

/* ═══ STATE ═══ */
var allClients = [];
var paymentsCache = {};   // leadId -> [payments]
var temoCache = {};       // leadId -> [temos]
var noteCache = {};       // leadId -> [notes structurées]
var clientsListenerSet = false;

/* Caches HTML pour les sections "GoCardless live" — évite que le re-render
   du onSnapshot écrase les détails affichés après un Resync */
var gcLiveLookupCache = {}; // leadId -> html (résultat lookup)
var gcLivePayCache = {};    // paymentId -> html (détails par paiement)

var filterCStatus = 'all';
var filterCoach = 'all';
var searchQuery = '';
var viewMode = 'grid';     // 'grid' | 'list'
var sortKey = 'clientSince';
var sortDir = 'desc';
var kpiFilter = null;      // 'active' | 'ending_soon' | 'failed_pay' | 'no_mandate' | 'retracted' | 'no_temo' | 'has_alert' | null
var openLeadId = null;
var saveTimer = null;

/* ═══ UTILS ═══ */
function esc(s){ var d=document.createElement('div'); d.textContent=(s===undefined||s===null)?'':s; return d.innerHTML; }
function escA(s){ return (s==null?'':String(s)).replace(/"/g,'&quot;'); }
function toast(msg){ var t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); setTimeout(function(){ t.classList.remove('show'); },2500); }
function EURO(v){ return new Intl.NumberFormat('fr-FR',{style:'currency',currency:'EUR',maximumFractionDigits:0}).format(v||0); }
function EUROc(v){ return new Intl.NumberFormat('fr-FR',{style:'currency',currency:'EUR'}).format(v||0); }

function fmtDate(d){
  if(!d) return '—';
  if(d.toDate) d = d.toDate();
  if(typeof d === 'string') d = new Date(d);
  if(!d || isNaN(d.getTime())) return '—';
  var dd=String(d.getDate()).padStart(2,'0');
  var mm=String(d.getMonth()+1).padStart(2,'0');
  return dd+'/'+mm+'/'+d.getFullYear();
}
function fmtDateTime(d){
  if(!d) return '—';
  if(d.toDate) d = d.toDate();
  if(typeof d === 'string') d = new Date(d);
  if(!d || isNaN(d.getTime())) return '—';
  return d.toLocaleString('fr-FR',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
}
function toDateObj(v){
  if(!v) return null;
  if(v.toDate) return v.toDate();
  if(typeof v === 'string'){ var d=new Date(v); return isNaN(d.getTime())?null:d; }
  if(v instanceof Date) return v;
  return null;
}
function daysBetween(a,b){ if(!a||!b) return null; return Math.ceil((b.getTime()-a.getTime())/86400000); }
function weeksBetween(a,b){ var d=daysBetween(a,b); return d===null?null:Math.ceil(d/7); }

/* ═══ ALERTS ═══ */
function computeAlerts(client){
  var alerts = [];
  var today = new Date(); today.setHours(0,0,0,0);
  var debut = toDateObj(client.accompagnementDebut || client.accompagnementStart);
  var fin   = toDateObj(client.accompagnementFin   || client.accompagnementEnd);

  if(fin){
    var daysLeft = daysBetween(today, fin);
    if(daysLeft !== null && daysLeft <= 0){
      alerts.push({type:'ended',cls:'fin',label:'Terminé',icon:'⏹'});
    } else if(daysLeft !== null && daysLeft <= ALERT_DAYS_FIN){
      alerts.push({type:'ending_soon',cls:'fin',label:'Fin dans '+daysLeft+'j',icon:'🔴'});
    }
    if(debut && daysLeft > 0){
      var totalDays = daysBetween(debut, fin);
      var elapsed   = daysBetween(debut, today);
      if(totalDays > 0 && elapsed >= totalDays/2){
        alerts.push({type:'midpoint',cls:'mid',label:'Mi-parcours',icon:'🟡'});
      }
    }
  }
  var temos = temoCache[client.id] || [];
  if(temos.length === 0 && debut){
    var weeksActive = weeksBetween(debut, today);
    if(weeksActive !== null && weeksActive >= ALERT_WEEKS_TEMO){
      alerts.push({type:'no_temo',cls:'temo',label:'Pas de témoignage',icon:'🟣'});
    }
  }
  return alerts;
}

/* ═══ DATA LOADING ═══ */
function startClientsListener(){
  if(clientsListenerSet) return;
  clientsListenerSet = true;
  db.collection('leads').where('isClient','==',true)
    .onSnapshot(function(snap){
      allClients = [];
      snap.forEach(function(doc){
        var d = doc.data();
        d.id = doc.id;
        allClients.push(d);
      });
      // Charge paiements + témoignages en parallèle
      Promise.all([loadAllPayments(), loadAllTemoignages()]).then(function(){
        renderAll();
      }).catch(function(err){
        // Les paiements et témoignages sont des données SECONDAIRES
        // (enrichissement de la fiche client). Si leur chargement échoue
        // — typiquement une rule Firestore manquante sur 'payments' après
        // un redéploiement de règles — on affiche quand même la liste des
        // clients plutôt que de rester bloqué indéfiniment sur le spinner.
        // L'erreur réelle est loguée en console pour diagnostic.
        console.error('Clients — chargement données secondaires échoué:', err && (err.code || err.message), err);
        renderAll();
      });
    }, function(err){
      console.error('Clients listener error:', err);
      document.getElementById('loadingState').innerHTML = '<span style="color:var(--red2)">❌ Erreur : '+esc(err.message)+'</span>';
    });
}

function loadAllPayments(){
  if(!allClients.length) return Promise.resolve();
  paymentsCache = {};
  var ids = allClients.map(function(c){ return c.id; });
  var chunks = [];
  for (var i = 0; i < ids.length; i += 10) chunks.push(ids.slice(i, i + 10));
  var promises = chunks.map(function(chunk){
    return db.collection('payments').where('leadId','in',chunk).get().then(function(sn){
      sn.forEach(function(d){
        var p = d.data(); p.id = d.id;
        if (!paymentsCache[p.leadId]) paymentsCache[p.leadId] = [];
        paymentsCache[p.leadId].push(p);
      });
    }).catch(function(err){
      // Échec de lecture (ex : rule Firestore manquante sur 'payments').
      // On dégrade proprement : ce chunk reste sans paiements en cache,
      // les autres chunks et la liste clients ne sont pas bloqués.
      console.error('Clients — lecture payments échouée:', err && (err.code || err.message));
    });
  });
  return Promise.all(promises);
}

function loadAllTemoignages(){
  if(!allClients.length) return Promise.resolve();
  temoCache = {};
  var promises = allClients.map(function(client){
    return db.collection('leads').doc(client.id).collection('client_temoignages')
      .orderBy('createdAt','desc').get()
      .then(function(snap){
        var arr = [];
        snap.forEach(function(d){ var o=d.data(); o.id=d.id; arr.push(o); });
        temoCache[client.id] = arr;
      }).catch(function(){ temoCache[client.id] = []; });
  });
  return Promise.all(promises);
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

function reloadOnePayment(leadId, cb){
  db.collection('payments').where('leadId','==',leadId).get().then(function(sn){
    paymentsCache[leadId] = [];
    sn.forEach(function(d){ var p=d.data(); p.id=d.id; paymentsCache[leadId].push(p); });
    if(cb) cb();
  });
}

/* ═══ Synchro auto GC info ═══ */
function loadSyncInfo(){
  db.collection('_meta').doc('gc_sync').get().then(function(s){
    if (!s.exists) return;
    var d = s.data();
    var ts = d.lastSyncAt && d.lastSyncAt.toDate ? d.lastSyncAt.toDate() : null;
    var label = ts ? ts.toLocaleString('fr-FR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}) : '—';
    var el = document.getElementById('syncInfo');
    el.innerHTML = '🔄 Synchro auto GC : <strong>'+label+'</strong>'+(d.errors?' · <span style="color:#ef4444">⚠ '+d.errors+' erreur(s)</span>':'');
    el.style.display = '';
  }).catch(function(){});
}

/* ═══ Bulk Sync GC — synchronise tous les clients GoCardless ═══ */
window.gcBulkSync = async function(){
  var gcClients = allClients.filter(function(c){
    return c.paiementPlateforme === 'GOCARDLESS' && c.email;
  });
  if (!gcClients.length){ toast('Aucun client GC à synchroniser'); return; }

  if (!confirm('Synchroniser '+gcClients.length+' client(s) GoCardless ?\n\nCela peut prendre quelques minutes.')) return;

  var btn = document.getElementById('btnBulkGcSync');
  var prog = document.getElementById('bulkSyncProgress');
  if (btn){ btn.disabled = true; btn.textContent = '⏳ Sync…'; }
  if (prog) prog.style.display = 'block';

  var done = 0, ok = 0, errCount = 0;
  var total = gcClients.length;

  function updateProgress(){
    if (prog){
      var pct = Math.round((done / total) * 100);
      prog.innerHTML =
        '<div style="display:flex;align-items:center;gap:10px;padding:10px 0">' +
        '<div style="flex:1;background:rgba(255,255,255,.06);border-radius:4px;height:6px;overflow:hidden">' +
        '<div style="background:#34d399;height:100%;width:'+pct+'%;transition:width .3s"></div></div>' +
        '<span style="font-size:11px;color:var(--muted);white-space:nowrap">'+done+'/'+total+' · ✅ '+ok+' · ❌ '+errCount+'</span>' +
        '</div>';
    }
  }

  updateProgress();
  var token = await firebase.auth().currentUser.getIdToken();

  for (var i = 0; i < gcClients.length; i++){
    var c = gcClients[i];
    try {
      var resp = await fetch('/api/gocardless-lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ leadId: c.id, email: c.email })
      });
      var data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Erreur');
      ok++;
      // Update local cache
      var idx = allClients.findIndex(function(x){ return x.id === c.id; });
      if (idx >= 0 && data.customer && data.customer.id) allClients[idx].gcCustomerId = data.customer.id;
    } catch(e){
      errCount++;
      console.warn('GC sync failed for', c.nom, ':', e.message);
    }
    done++;
    updateProgress();
    if (i < gcClients.length - 1) await new Promise(function(r){ setTimeout(r, 200); });
  }

  if (btn){ btn.disabled = false; btn.textContent = '🔄 Resync GC'; }
  var msg = '✅ Sync terminée — ' + ok + ' liés, ' + errCount + ' non trouvés';
  if (prog) prog.innerHTML += '<div style="font-size:11px;color:#34d399;padding:4px 0">'+msg+'</div>';
  toast(msg);

  // Reload payments cache et re-render
  loadAllPayments().then(function(){
    renderAll();
  });
};

/* Affiche/cache le bouton bulk sync selon présence de clients GC */
function updateBulkSyncBtn(){
  var btn = document.getElementById('btnBulkGcSync');
  if (!btn) return;
  var hasGc = allClients.some(function(c){ return c.paiementPlateforme === 'GOCARDLESS'; });
  btn.style.display = hasGc ? '' : 'none';
}

/* ═══ Warmup : reconstruit l'index gc_customers_cache (admin only) ═══ */
window.gcWarmup = async function(){
  if (!confirm('Reconstruire l\'index des customers GoCardless ?\n\nScanne TOUS les customers GC (peut prendre 1 à 5 min selon le volume).\nÀ lancer une fois, ou après un gros lot de nouveaux mandats.')) return;

  var btn = document.getElementById('btnGcWarmup');
  var prog = document.getElementById('bulkSyncProgress');
  if (btn){ btn.disabled = true; btn.textContent = '⏳ Indexation…'; }
  if (prog){
    prog.style.display = 'block';
    prog.innerHTML = '<div style="padding:10px 0;font-size:11px;color:var(--muted)">⏳ Scan complet de GoCardless en cours… (cela peut prendre plusieurs minutes)</div>';
  }

  try {
    var token = await firebase.auth().currentUser.getIdToken();
    var resp = await fetch('/api/gocardless-warmup', {
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
      body: JSON.stringify({})
    });
    var data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Erreur API');

    var msg = '✅ Index reconstruit — '+data.count+' customers ('+data.withEmail+' avec email) en '+Math.round(data.durationMs/1000)+'s';
    if (prog) prog.innerHTML = '<div style="padding:10px 0;font-size:11px;color:#34d399">'+esc(msg)+'</div>';
    toast(msg);
  } catch (e){
    if (prog) prog.innerHTML = '<div style="padding:10px 0;font-size:11px;color:#ef4444">❌ '+esc(e.message)+'</div>';
    toast('❌ '+e.message);
  } finally {
    if (btn){ btn.disabled = false; btn.textContent = '🔁 Reconstruire index GC'; }
  }
};

/* Affiche le bouton warmup uniquement aux admins */
function updateWarmupBtn(){
  var btn = document.getElementById('btnGcWarmup');
  if (!btn) return;
  btn.style.display = (window._currentRole === 'admin') ? '' : 'none';
}

/* ═══ AUTH ═══ */
firebase.auth().onAuthStateChanged(function(user){
  if(user){
    // Récupère le rôle pour afficher le bouton warmup admin only
    db.collection('users').doc(user.uid).get().then(function(snap){
      var d = snap.exists ? snap.data() : {};
      window._currentRole = d.role || 'sales';
      updateWarmupBtn();
    }).catch(function(){
      window._currentRole = 'sales';
      updateWarmupBtn();
    });
    startClientsListener();
    loadSyncInfo();
  } else {
    window.location.href = 'login.html';
  }
});

/* ═══ Calcul des sets KPIs (pour filtres cliquables) ═══ */
function computeKpiSets(){
  var now = new Date();
  var in30 = new Date(now); in30.setDate(in30.getDate() + 30);

  var sets = {
    active: {}, ending_soon: {}, failed_pay: {},
    no_mandate: {}, retracted: {}, no_temo: {}, has_alert: {}
  };
  var counts = { active:0, ending_soon:0, failed_pay:0, no_mandate:0, retracted:0, no_temo:0, has_alert:0 };
  var contracts30 = []; // pour le sub-titre

  allClients.forEach(function(c){
    if ((c.clientStatus||'active') === 'active') { sets.active[c.id]=true; counts.active++; }

    var endD = toDateObj(c.accompagnementEnd || c.accompagnementFin);
    if (endD && endD >= now && endD <= in30) {
      sets.ending_soon[c.id] = true; counts.ending_soon++;
      contracts30.push(c.nom||'?');
    }

    if (c.paiementPlateforme === 'GOCARDLESS') {
      var pays = paymentsCache[c.id] || [];
      if (!pays.some(function(p){ return p.gcMandateId; })) {
        sets.no_mandate[c.id] = true; counts.no_mandate++;
      }
    }

    if (c.retractation && String(c.retractation).toUpperCase() === 'RENONCÉ') {
      sets.retracted[c.id] = true; counts.retracted++;
    }

    var temos = temoCache[c.id] || [];
    if (temos.length === 0) {
      var debut = toDateObj(c.accompagnementDebut || c.accompagnementStart);
      if (debut) {
        var w = weeksBetween(debut, new Date());
        if (w !== null && w >= ALERT_WEEKS_TEMO) {
          sets.no_temo[c.id] = true; counts.no_temo++;
        }
      }
    }

    if (computeAlerts(c).length > 0) { sets.has_alert[c.id]=true; counts.has_alert++; }
  });

  // Paiements failed (par leadId)
  Object.keys(paymentsCache).forEach(function(leadId){
    var hasFailed = paymentsCache[leadId].some(function(p){ return p.status === 'failed'; });
    if (hasFailed) { sets.failed_pay[leadId] = true; counts.failed_pay++; }
  });

  // Total collecté
  var totalCollecte = 0;
  Object.keys(paymentsCache).forEach(function(k){
    paymentsCache[k].forEach(function(p){ totalCollecte += (p.paidAmount || 0); });
  });

  return { sets: sets, counts: counts, totalCollecte: totalCollecte, contracts30: contracts30 };
}

/* ═══ FILTERING ═══ */
function getFiltered(){
  var list = allClients.slice();

  if(searchQuery){
    var q = searchQuery.toLowerCase();
    list = list.filter(function(c){
      return ((c.nom||'').toLowerCase().indexOf(q) >= 0)
          || ((c.email||'').toLowerCase().indexOf(q) >= 0)
          || ((c.telephone||'').toLowerCase().indexOf(q) >= 0)
          || ((c.commerce||'').toLowerCase().indexOf(q) >= 0);
    });
  }
  if(filterCoach !== 'all'){
    list = list.filter(function(c){
      if(filterCoach === '') return !c.coachAssigned && !c.coach;
      return (c.coachAssigned === filterCoach) || (c.coach === filterCoach);
    });
  }
  if(filterCStatus !== 'all'){
    if(filterCStatus === 'alerte'){
      list = list.filter(function(c){ return computeAlerts(c).length > 0; });
    } else {
      list = list.filter(function(c){ return (c.clientStatus||'active') === filterCStatus; });
    }
  }

  // Filtre KPI (vient en plus des filtres ci-dessus)
  if (kpiFilter){
    var kpiData = computeKpiSets();
    var allowed = kpiData.sets[kpiFilter] || {};
    list = list.filter(function(c){ return allowed[c.id]; });
  }

  // Tri
  list.sort(function(a,b){
    var va, vb;
    if (sortKey === 'nom' || sortKey === 'telephone' || sortKey === 'formule'){
      va = (a[sortKey]||'').toString().toLowerCase();
      vb = (b[sortKey]||'').toString().toLowerCase();
    } else if (sortKey === 'closeur'){
      va = (a.closeurName || a.closeurSlug || '').toLowerCase();
      vb = (b.closeurName || b.closeurSlug || '').toLowerCase();
    } else if (sortKey === 'coach'){
      va = (a.coachAssigned || a.coach || '').toLowerCase();
      vb = (b.coachAssigned || b.coach || '').toLowerCase();
    } else if (sortKey === 'clientStatus'){
      va = (a.clientStatus || 'active');
      vb = (b.clientStatus || 'active');
    } else if (sortKey === 'paiement'){
      var pa = paymentsCache[a.id] || []; var pb = paymentsCache[b.id] || [];
      va = pa.reduce(function(s,p){ return s + (p.totalAmount||0); }, 0);
      vb = pb.reduce(function(s,p){ return s + (p.totalAmount||0); }, 0);
    } else if (sortKey === 'accompagnementEnd' || sortKey === 'accompagnementStart' || sortKey === 'clientSince'){
      var ka = sortKey === 'accompagnementEnd' ? (a.accompagnementEnd || a.accompagnementFin)
              : sortKey === 'accompagnementStart' ? (a.accompagnementStart || a.accompagnementDebut)
              : a.clientSince;
      var kb = sortKey === 'accompagnementEnd' ? (b.accompagnementEnd || b.accompagnementFin)
              : sortKey === 'accompagnementStart' ? (b.accompagnementStart || b.accompagnementDebut)
              : b.clientSince;
      va = toDateObj(ka); vb = toDateObj(kb);
      va = va ? va.getTime() : 0; vb = vb ? vb.getTime() : 0;
    } else if (sortKey === 'temoignages'){
      va = (temoCache[a.id]||[]).length;
      vb = (temoCache[b.id]||[]).length;
    } else if (sortKey === 'alertes'){
      va = computeAlerts(a).length;
      vb = computeAlerts(b).length;
    } else {
      va = (a[sortKey] || '').toString().toLowerCase();
      vb = (b[sortKey] || '').toString().toLowerCase();
    }
    if (va < vb) return sortDir === 'asc' ? -1 : 1;
    if (va > vb) return sortDir === 'asc' ?  1 : -1;
    return 0;
  });
  return list;
}

/* ═══ RENDER ═══ */
function renderAll(){
  var list = getFiltered();
  renderKpis();
  renderHeaderCount(list);
  renderActiveFilters(list);
  renderBody(list);
  updateBulkSyncBtn();
  if(openLeadId) refreshPanel();
}

/* Bannière des filtres actifs (KPI + statut + coach + KPI filter) */
function renderActiveFilters(list){
  var bar = document.getElementById('activeFilters');
  if (!bar) return;
  var chips = [];

  if (kpiFilter){
    var kpiLabels = {
      ending_soon: '📅 Contrats <30j',
      failed_pay:  '❌ Paiements échoués',
      no_mandate:  '💸 Sans mandat GC',
      retracted:   '↩️ Rétractations',
      no_temo:     '🟣 Sans témoignage >4sem'
    };
    chips.push({ label: kpiLabels[kpiFilter] || kpiFilter, action: 'clearKpi' });
  }
  if (filterCStatus !== 'all'){
    var csLabels = { active:'✅ Actifs', paused:'⏸ En pause', completed:'🎉 Terminés', stopped:'🛑 Stoppés', procedure:'⚖️ Procédure', alerte:'⚠ Alertes' };
    chips.push({ label: csLabels[filterCStatus] || filterCStatus, action: 'clearCStatus' });
  }
  if (filterCoach !== 'all'){
    var cl = filterCoach === '' ? 'Coach non assigné' : 'Coach : ' + (COACH_MAP[filterCoach] || filterCoach);
    chips.push({ label: cl, action: 'clearCoach' });
  }
  if (searchQuery){
    chips.push({ label: '🔍 "'+searchQuery+'"', action: 'clearSearch' });
  }

  if (!chips.length){ bar.style.display = 'none'; bar.innerHTML = ''; return; }

  bar.style.display = '';
  bar.innerHTML = '<span style="font-size:11px;color:var(--muted);font-weight:600">FILTRES ACTIFS · '+list.length+' résultat'+(list.length>1?'s':'')+'</span>'+
    chips.map(function(c){
      return '<span class="cl-active-chip">'+esc(c.label)+
        ' <button class="cl-chip-x" data-clear="'+c.action+'" title="Retirer">✕</button></span>';
    }).join('') +
    (chips.length > 1 ? '<button class="cl-chip-clear-all" data-clear="all">Tout retirer</button>' : '');
}

function renderHeaderCount(list){
  var n = list.length;
  document.getElementById('clientsCountTitle').textContent = n + ' client' + (n>1?'s':'') + (n !== allClients.length ? ' / '+allClients.length+' au total' : '');
}

/* ═══ KPIs (7 cartes — toutes cliquables sauf Total) ═══ */
function renderKpis(){
  var kd = computeKpiSets();

  var kpis = [
    { key:'active',      icon:'👥', label:'Clients actifs',     val:kd.counts.active,        color:'#10b981' },
    { key:'ending_soon', icon:'📅', label:'Contrats <30j',      val:kd.counts.ending_soon,   color:'#f59e0b', urgentCls:'warn',
      sub: kd.contracts30.slice(0,2).join(', ') },
    { key:'failed_pay',  icon:'❌', label:'Paiements échoués',  val:kd.counts.failed_pay,    color:'#ef4444' },
    { key:'no_mandate',  icon:'💸', label:'Sans mandat GC',     val:kd.counts.no_mandate,    color:'#f97316', urgentCls:'orange' },
    { key:'retracted',   icon:'↩️', label:'Rétractations',      val:kd.counts.retracted,     color:'#a78bfa', urgentCls:'purple' },
    { key:null,          icon:'💰', label:'Total collecté',     val:EURO(kd.totalCollecte),  color:'#34d399', amount:true },
    { key:'no_temo',     icon:'🟣', label:'Sans témoignage >4sem', val:kd.counts.no_temo,    color:'#a78bfa', urgentCls:'purple' }
  ];

  var html = kpis.map(function(k){
    var cls = 'cl-kpi-card';
    var isUrgent = (typeof k.val === 'number' && k.val > 0);
    if (isUrgent) cls += ' urgent' + (k.urgentCls?' '+k.urgentCls:'');
    if (k.key) cls += ' clickable';
    if (k.key && kpiFilter === k.key) cls += ' selected';
    var attr = k.key ? ' data-kpi="'+k.key+'"' : '';
    return '<div class="'+cls+'"'+attr+'>'+
      '<div class="cl-kpi-icon">'+k.icon+'</div>'+
      '<div class="cl-kpi-val'+(k.amount?' amount':'')+'" style="color:'+k.color+'">'+esc(k.val)+'</div>'+
      '<div class="cl-kpi-label">'+esc(k.label)+'</div>'+
      (k.sub?'<div class="cl-kpi-sub" style="color:'+k.color+'">'+esc(k.sub)+'</div>':'')+
      '</div>';
  }).join('');
  document.getElementById('kpisBar').innerHTML = html;
}

/* Toggle d'un filtre KPI : si déjà actif → off, sinon → on */
window.toggleKpiFilter = function(key){
  if (!key) return;
  // Si KPI = 'active' ou 'has_alert', on synchronise avec filterCStatus pour cohérence
  if (key === 'active'){
    kpiFilter = null;
    filterCStatus = (filterCStatus === 'active') ? 'all' : 'active';
  } else if (key === 'has_alert'){
    kpiFilter = null;
    filterCStatus = (filterCStatus === 'alerte') ? 'all' : 'alerte';
  } else {
    kpiFilter = (kpiFilter === key) ? null : key;
  }
  // Sync UI pills statut
  document.querySelectorAll('[data-filter="cstatus"]').forEach(function(p){
    p.classList.toggle('active', p.dataset.val === filterCStatus);
  });
  renderAll();
};

/* ═══ BODY (grid OR list) ═══ */
function renderBody(list){
  var container = document.getElementById('tableBody');
  if(list.length === 0){
    container.innerHTML = '<div class="cl-empty-grid"><div class="cl-empty-grid-icon">👥</div><div style="font-size:14px;font-weight:600">Aucun client trouvé</div></div>';
    return;
  }
  if(viewMode === 'grid') renderGrid(list, container);
  else renderList(list, container);
}

/* ── GRID VIEW ── */
function renderGrid(list, container){
  var html = '<div class="cl-grid">';
  list.forEach(function(c){
    var ini = (c.nom||'?').charAt(0).toUpperCase();
    var pays = paymentsCache[c.id] || [];
    var mainPay = pays.slice().sort(function(a,b){
      return (b.createdAt && b.createdAt.seconds || 0) - (a.createdAt && a.createdAt.seconds || 0);
    })[0];
    var cs = STATUS_CLIENT[c.clientStatus || 'active'] || STATUS_CLIENT.active;
    var slug = c.closeurSlug || c.assignedTo || '';
    var tm = window.TEAM_MEMBERS && window.TEAM_MEMBERS[slug];
    var setterColor = tm ? tm.color : '#b91c1c';

    var alerts = computeAlerts(c);
    var temos = temoCache[c.id] || [];

    var payHtml = '';
    if(mainPay){
      var prog = mainPay.installmentsCount > 1
        ? (mainPay.paidCount || 0) + '/' + mainPay.installmentsCount + ' mois'
        : (mainPay.status === 'completed' ? 'Soldé' : (STATUS_PAY[mainPay.status] || mainPay.status || ''));
      payHtml = '<div class="cl-card-pay">'+
        '<span class="amount">'+EUROc(mainPay.totalAmount)+' '+(mainPay.vatType||'ht').toUpperCase()+'</span>'+
        '<span class="prog">'+esc(prog)+'</span>'+
        '</div>';
    }

    var flagsHtml = '';
    if (alerts.length){
      alerts.forEach(function(a){ flagsHtml += '<span class="cl-card-flag '+a.cls+'">'+a.icon+' '+esc(a.label)+'</span>'; });
    }
    if (c.coach || c.coachAssigned){
      var ck = c.coachAssigned || c.coach;
      flagsHtml += '<span class="cl-card-flag coach">🎓 '+esc(COACH_MAP[ck]||ck)+'</span>';
    }
    if (temos.length){
      flagsHtml += '<span class="cl-card-flag temo">⭐ '+temos.length+' tém.</span>';
    }
    var fin = toDateObj(c.accompagnementEnd || c.accompagnementFin);
    if (fin){
      flagsHtml += '<span class="cl-card-flag fin">📅 fin '+fmtDate(fin)+'</span>';
    }

    html += '<div class="cl-card" data-cid="'+c.id+'">'+
      '<div class="cl-card-head">'+
        '<div class="cl-card-av" style="background:linear-gradient(135deg,'+setterColor+'88,'+setterColor+')">'+esc(ini)+'</div>'+
        '<div class="cl-card-info">'+
          '<div class="cl-card-name">'+esc(c.nom||'—')+'</div>'+
          '<div class="cl-card-email">'+esc(c.email||'')+'</div>'+
        '</div>'+
        '<span class="cl-cs-pill" style="background:'+cs.color+'18;color:'+cs.color+';border:1px solid '+cs.color+'30">'+cs.label+'</span>'+
      '</div>'+
      '<div class="cl-card-meta">'+
        (c.telephone?'<div>📞 '+esc(c.telephone)+'</div>':'')+
        (c.clientSince?'<div>📅 '+fmtDate(c.clientSince)+'</div>':'')+
        (c.formule?'<div>🎓 '+esc(c.formule)+'</div>':'')+
        (slug?'<div>👤 '+esc(c.closeurName||slug)+'</div>':'')+
      '</div>'+
      payHtml+
      (flagsHtml ? '<div class="cl-card-flags">'+flagsHtml+'</div>' : '')+
      '</div>';
  });
  html += '</div>';
  container.innerHTML = html;
}

/* ── LIST VIEW ── */
function renderList(list, container){
  var teamOpts = '<option value="">—</option>';
  if (window.TEAM_MEMBERS_LIST) {
    window.TEAM_MEMBERS_LIST.forEach(function(m){
      if (m.active !== false) teamOpts += '<option value="'+escA(m.slug||'')+'">'+esc(m.displayName||m.shortName||m.slug)+'</option>';
    });
  }
  var statusOpts = Object.keys(STATUS_CLIENT).map(function(k){
    return '<option value="'+k+'">'+STATUS_CLIENT[k].label+'</option>';
  }).join('');

  var cols = [
    { key:'nom',                label:'Client' },
    { key:'telephone',          label:'Téléphone' },
    { key:'formule',            label:'Formule' },
    { key:'paiement',           label:'Paiement' },
    { key:'closeur',            label:'Closeur' },
    { key:'coach',              label:'Coach' },
    { key:'clientStatus',       label:'Statut' },
    { key:'accompagnementEnd',  label:'Fin accomp.' },
    { key:'temoignages',        label:'Témoignages' },
    { key:'alertes',            label:'Alertes' }
  ];

  var html = '<div class="cl-table-wrap"><table class="cl-table cl-v2"><thead><tr>';
  cols.forEach(function(col){
    var isSorted = sortKey === col.key;
    var arrow = isSorted ? (sortDir === 'asc' ? '↑' : '↓') : '↕';
    html += '<th data-sortcol="'+col.key+'" class="'+(isSorted?'sorted':'')+'" style="cursor:pointer;user-select:none">'+
      esc(col.label)+' <span class="sort-arrow">'+arrow+'</span></th>';
  });
  html += '</tr></thead><tbody>';

  list.forEach(function(c){
    var pays = paymentsCache[c.id] || [];
    var mainPay = pays.slice().sort(function(a,b){
      return (b.createdAt && b.createdAt.seconds || 0) - (a.createdAt && a.createdAt.seconds || 0);
    })[0];
    var cs = STATUS_CLIENT[c.clientStatus || 'active'] || STATUS_CLIENT.active;
    var slug = c.closeurSlug || c.assignedTo || '';
    var payStr = mainPay
      ? EUROc(mainPay.totalAmount) + (mainPay.installmentsCount > 1 ? ' · '+(mainPay.paidCount||0)+'/'+mainPay.installmentsCount+'m' : '')
      : '—';
    var alerts = computeAlerts(c);
    var temos = temoCache[c.id] || [];
    var coach = c.coachAssigned || c.coach || '';
    var fin = c.accompagnementEnd || c.accompagnementFin;

    var statusSel = '<select data-cid="'+c.id+'" data-field="clientStatus" class="cl-edit-sel cs" onclick="event.stopPropagation()" style="background:'+cs.color+'18;border:1px solid '+cs.color+'44;color:'+cs.color+'">'+
      statusOpts.replace('value="'+(c.clientStatus||'active')+'"','value="'+(c.clientStatus||'active')+'" selected')+
      '</select>';
    var closeurSel = '<select data-cid="'+c.id+'" data-field="closeurSlug" class="cl-edit-sel" onclick="event.stopPropagation()" style="max-width:120px">'+
      teamOpts.replace('value="'+escA(slug)+'"','value="'+escA(slug)+'" selected')+
      '</select>';

    var alertsHtml = '';
    if (alerts.length === 0) alertsHtml = '<span style="color:var(--muted2);font-size:11px">—</span>';
    else alerts.forEach(function(a){ alertsHtml += '<span class="cl-alert-badge '+a.cls+'">'+a.icon+' '+esc(a.label)+'</span>'; });

    html += '<tr data-cid="'+c.id+'" class="'+(openLeadId===c.id?'active-row':'')+'">'+
      '<td><div class="cl-client-name">'+esc(c.nom||'—')+'</div>'+
        (c.email?'<div class="cl-client-commerce">'+esc(c.email)+'</div>':'')+'</td>'+
      '<td class="cl-dates">'+esc(c.telephone||'—')+'</td>'+
      '<td>'+esc(c.formule||'—')+'</td>'+
      '<td style="font-size:12px">'+esc(payStr)+'</td>'+
      '<td>'+closeurSel+'</td>'+
      '<td>'+(coach?'<span class="cl-coach-badge">'+esc(COACH_MAP[coach]||coach)+'</span>':'<span style="color:var(--muted2);font-size:11px">—</span>')+'</td>'+
      '<td>'+statusSel+'</td>'+
      '<td class="cl-dates">'+(fin?fmtDate(fin):'—')+'</td>'+
      '<td><span class="cl-temo-count'+(temos.length>0?' has':'')+'">'+temos.length+'</span></td>'+
      '<td><div class="cl-alert-badges">'+alertsHtml+'</div></td>'+
      '</tr>';
  });
  html += '</tbody></table></div>';
  container.innerHTML = html;
}

/* ═══ EVENTS — TOOLBAR ═══ */
document.getElementById('searchInput').addEventListener('input', function(e){
  searchQuery = e.target.value.trim();
  renderAll();
});

document.getElementById('btnBulkGcSync').addEventListener('click', function(){
  window.gcBulkSync();
});

document.getElementById('btnGcWarmup').addEventListener('click', function(){
  window.gcWarmup();
});

/* Click sur une carte KPI cliquable → toggle le filtre */
document.getElementById('kpisBar').addEventListener('click', function(e){
  var card = e.target.closest('[data-kpi]');
  if (!card) return;
  window.toggleKpiFilter(card.dataset.kpi);
});

/* Click sur ✕ d'un chip de filtre actif → retire le filtre */
document.getElementById('activeFilters').addEventListener('click', function(e){
  var btn = e.target.closest('[data-clear]');
  if (!btn) return;
  var act = btn.dataset.clear;
  if (act === 'clearKpi') kpiFilter = null;
  else if (act === 'clearCStatus') {
    filterCStatus = 'all';
    document.querySelectorAll('[data-filter="cstatus"]').forEach(function(p){
      p.classList.toggle('active', p.dataset.val === 'all');
    });
  }
  else if (act === 'clearCoach') {
    filterCoach = 'all';
    document.getElementById('filterCoach').value = 'all';
  }
  else if (act === 'clearSearch') {
    searchQuery = '';
    document.getElementById('searchInput').value = '';
  }
  else if (act === 'all') {
    kpiFilter = null; filterCStatus = 'all'; filterCoach = 'all'; searchQuery = '';
    document.getElementById('searchInput').value = '';
    document.getElementById('filterCoach').value = 'all';
    document.querySelectorAll('[data-filter="cstatus"]').forEach(function(p){
      p.classList.toggle('active', p.dataset.val === 'all');
    });
  }
  renderAll();
});

document.querySelector('.cl-toolbar').addEventListener('click', function(e){
  var pill = e.target.closest('[data-filter="cstatus"]');
  if(pill){
    filterCStatus = pill.dataset.val;
    document.querySelectorAll('[data-filter="cstatus"]').forEach(function(p){
      p.classList.toggle('active', p.dataset.val === filterCStatus);
    });
    renderAll();
    return;
  }
  var vbtn = e.target.closest('[data-view]');
  if(vbtn){
    viewMode = vbtn.dataset.view;
    document.querySelectorAll('[data-view]').forEach(function(b){ b.classList.toggle('active', b.dataset.view === viewMode); });
    renderAll();
    return;
  }
});

document.getElementById('filterCoach').addEventListener('change', function(e){
  filterCoach = e.target.value;
  renderAll();
});

document.getElementById('sortSelect').addEventListener('change', function(e){
  var parts = e.target.value.split(':');
  sortKey = parts[0]; sortDir = parts[1] || 'asc';
  renderAll();
});

/* ═══ EVENTS — BODY (clic + édition inline + tri par en-tête) ═══ */
document.getElementById('tableBody').addEventListener('click', function(e){
  // Tri par clic sur en-tête (vue list)
  var th = e.target.closest('[data-sortcol]');
  if (th){
    var col = th.dataset.sortcol;
    if (sortKey === col) {
      // Cycle ASC → DESC → reset (clientSince desc)
      if (sortDir === 'asc') sortDir = 'desc';
      else { sortKey = 'clientSince'; sortDir = 'desc'; }
    } else {
      sortKey = col;
      sortDir = 'asc';
    }
    // Sync le sélecteur trier-par s'il existe
    var sel = document.getElementById('sortSelect');
    if (sel) sel.value = sortKey + ':' + sortDir;
    renderAll();
    return;
  }
  // Édition inline (bloque l'ouverture du panel)
  if (e.target.closest('.cl-edit-sel')) return;
  // Clic sur ligne ou carte → ouvre le panel
  var row = e.target.closest('[data-cid]');
  if (row) openPanel(row.dataset.cid);
});

document.getElementById('tableBody').addEventListener('change', function(e){
  var sel = e.target.closest('.cl-edit-sel');
  if (!sel) return;
  var cid = sel.dataset.cid, field = sel.dataset.field, val = sel.value;
  var upd = { updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
  upd[field] = val;
  if (field === 'closeurSlug' && window.TEAM_MEMBERS && window.TEAM_MEMBERS[val]) {
    upd.closeurName = window.TEAM_MEMBERS[val].displayName || window.TEAM_MEMBERS[val].shortName || val;
  }
  db.collection('leads').doc(cid).update(upd).then(function(){
    var c = allClients.find(function(x){ return x.id === cid; });
    if (c) {
      c[field] = val;
      if (upd.closeurName) c.closeurName = upd.closeurName;
    }
    toast('✅ Sauvegardé');
    renderKpis();
  }).catch(function(err){ toast('❌ '+err.message); });
});

/* ═══ DETAIL PANEL ═══ */
function openPanel(leadId){
  openLeadId = leadId;
  document.getElementById('panelBg').classList.add('open');
  loadNotes(leadId, function(){
    loadTemoignages(leadId, function(){
      refreshPanel();
      renderAll();
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
  var client = allClients.find(function(c){ return c.id === openLeadId; });
  if(!client){ closePanel(); return; }

  var alerts = computeAlerts(client);
  var temos  = temoCache[client.id] || [];
  var notes  = noteCache[client.id] || [];
  var pays   = paymentsCache[client.id] || [];
  var slug = client.closeurSlug || client.assignedTo || '';
  var tm = window.TEAM_MEMBERS && window.TEAM_MEMBERS[slug];
  var setterColor = tm ? tm.color : '#b91c1c';
  var ini = (client.nom||'?').charAt(0).toUpperCase();
  var cs = STATUS_CLIENT[client.clientStatus || 'active'] || STATUS_CLIENT.active;

  var h = '';

  /* HEADER */
  h += '<div class="cl-panel-head">'+
    '<div class="cl-panel-av" style="background:linear-gradient(135deg,'+setterColor+'88,'+setterColor+')">'+esc(ini)+'</div>'+
    '<div style="flex:1;min-width:0">'+
      '<div class="cl-panel-name">'+esc(client.nom||'—')+'</div>'+
      '<div style="font-size:12px;color:var(--muted);margin-top:2px">'+esc(client.email||'')+(client.telephone?' · '+esc(client.telephone):'')+'</div>'+
    '</div>'+
    '<span class="cl-cs-pill" style="background:'+cs.color+'18;color:'+cs.color+';border:1px solid '+cs.color+'30">'+cs.label+'</span>'+
    '<a href="sales-contact.html?id='+client.id+'" style="padding:5px 10px;border:1px solid var(--border);border-radius:8px;color:var(--muted);font-size:11px;font-weight:700;text-decoration:none;white-space:nowrap;flex-shrink:0">↗ Fiche Lead</a>'+
    '<button class="cl-panel-close" data-action="closePanel">✕</button>'+
    '</div>';

  h += '<div class="cl-panel-body">';

  /* ALERTES */
  if(alerts.length > 0){
    h += '<div class="cl-section">';
    h += '<div class="cl-section-title">⚠️ Alertes</div>';
    h += '<div class="cl-alert-list">';
    alerts.forEach(function(a){
      h += '<div class="cl-alert-item '+a.cls+'">'+a.icon+' '+esc(a.label)+'</div>';
    });
    h += '</div></div>';
  }

  /* STATUS PILLS SELECTOR */
  h += '<div class="cl-cs-pills">';
  Object.keys(STATUS_CLIENT).forEach(function(k){
    var s = STATUS_CLIENT[k];
    var on = (client.clientStatus||'active') === k;
    h += '<button class="cl-cs-pill-btn" data-action="setCStatus" data-val="'+k+'" style="border:1.5px solid '+(on?s.color:'var(--border)')+';background:'+(on?s.color+'18':'transparent')+';color:'+(on?s.color:'var(--muted)')+'">'+s.label+'</button>';
  });
  h += '</div>';

  /* 2-COLONNES */
  h += '<div class="cl-panel-2col">';

  /* COL GAUCHE — Informations / Programme / Webinaire */
  h += '<div>';

  // Informations
  h += '<div class="cl-sec-h">👤 Informations</div>';
  h += renderEditRow('👤','Nom',         renderInput('nom',       client.nom));
  h += renderEditRow('📧','Email',       renderInput('email',     client.email, 'email'));
  h += renderEditRow('📞','Téléphone',   renderInput('telephone', client.telephone, 'tel'));
  h += renderEditRow('🏢','Commerce',    renderInput('commerce',  client.commerce));
  h += renderEditRow('🏭','Secteur',     renderInput('secteur',   client.secteur));
  h += renderEditRow('💰','CA actuel',   renderInput('ca',        client.ca));
  h += renderEditRow('🎯','Problématique', renderTxa('problematique', client.problematique));
  h += renderEditRow('📋','Pb. secondaires', renderTxa('pbSecondaires', client.pbSecondaires));
  h += renderEditRow('✨','Résultats',    renderTxa('resultats',   client.resultats));
  h += '<div style="font-size:10px;color:var(--muted);padding:5px 0;display:flex;align-items:center;gap:8px"><span style="width:18px;text-align:center">📅</span><span style="min-width:115px">Client depuis</span><span style="font-size:12px;font-weight:600;color:var(--text)">'+fmtDate(client.clientSince)+'</span></div>';

  // Programme & Contrat
  h += '<div class="cl-sec-h mt">📋 Programme & Contrat</div>';
  h += renderEditRow('🎓','Formule',         renderInput('formule', client.formule));
  h += renderEditRow('📅','Début accomp.',   renderInput('accompagnementStart', client.accompagnementStart || client.accompagnementDebut, 'date'));
  h += renderEditRow('📅','Fin accomp.',     renderInput('accompagnementEnd',   client.accompagnementEnd   || client.accompagnementFin,   'date'));
  h += renderEditRow('↩️','Rétractation',    renderSelect('retractation',  client.retractation, ['Actif','RENONCÉ','Procédure']));
  h += renderEditRow('💳','Plateforme',      renderSelect('paiementPlateforme', client.paiementPlateforme, ['GOCARDLESS','Stripe','Virement','Chèque','Autre']));
  h += renderEditRow('💸','Commissions',     renderSelect('commissions',   client.commissions, ['PAYÉ','En attente','Non']));
  h += renderEditRow('🏋️','Coaching 72H',   renderSelect('coaching72',    client.coaching72,  ['FAIT','En cours','Planifié','Non']));
  h += renderEditRow('🤝','Setter',          renderInput('setting',        client.setting || client.assignedTo));
  h += renderEditRow('🎯','Closeur',         renderInput('closeurName',    client.closeurName || client.closeurSlug));
  h += renderEditRow('🎁','Goodies',         renderSelect('goodies',       client.goodies, ['Envoyé','En attente','Non']));
  h += renderEditRow('📦','Date goodies',    renderInput('dateEnvoiGoodies', client.dateEnvoiGoodies, 'date'));

  // Webinaire
  h += '<div class="cl-sec-h mt">🎙️ Webinaire</div>';
  h += renderEditRow('🎙️','Prospect webi', renderSelect('prospectWebinaire', client.prospectWebinaire, ['Oui','Non']));
  h += renderEditRow('📅','Date webinaire', renderInput('dateWebinaire',   client.dateWebinaire, 'date'));
  h += renderEditRow('✅','Présent',         renderSelect('present',       client.present, ['Oui','Non','Absent']));
  h += renderEditRow('🚫','Rejet mails',     renderInput('rejetMails',     client.rejetMails));

  h += '</div>';

  /* COL DROITE — Accompagnement / Paiements / GC / Témoignages */
  h += '<div>';

  // Accompagnement (coach + dates + durée)
  h += '<div class="cl-sec-h">🎓 Accompagnement coach</div>';
  h += '<div class="cl-edit-row"><span class="e">🎓</span><span class="l">Coach assigné</span><div class="v">'+
    '<select class="cl-edit-input cl-edit-select" data-cedit="coachAssigned"><option value="">— Non assigné —</option>'+
    COACHES.map(function(co){ return '<option value="'+co.key+'"'+(client.coachAssigned===co.key?' selected':'')+'>'+esc(co.label)+'</option>'; }).join('')+
    '</select></div></div>';
  var deb = toDateObj(client.accompagnementStart || client.accompagnementDebut);
  var fin = toDateObj(client.accompagnementEnd   || client.accompagnementFin);
  if (deb && fin){
    var totalWeeks = weeksBetween(deb, fin);
    h += '<div class="cl-edit-row"><span class="e">⏱</span><span class="l">Durée totale</span><div class="v" style="padding-top:6px;font-family:var(--fm);font-size:13px;font-weight:700">'+totalWeeks+' semaines</div></div>';
    var today = new Date(); today.setHours(0,0,0,0);
    var weeksLeft = weeksBetween(today, fin);
    if (weeksLeft !== null && weeksLeft > 0){
      h += '<div class="cl-edit-row"><span class="e">⌛</span><span class="l">Restant</span><div class="v" style="padding-top:6px;font-family:var(--fm);font-size:13px;font-weight:700;color:'+(weeksLeft<=2?'#ef4444':weeksLeft<=4?'#f59e0b':'var(--text)')+'">'+weeksLeft+' semaines</div></div>';
    }
  }

  // Paiements
  h += '<div class="cl-sec-h mt">💳 Contrat & Paiement</div>';
  if (client.contractSigned){
    h += '<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.2);margin-bottom:8px">'+
      '<span style="color:#34d399;font-size:14px">✍️</span><div><div style="font-size:12px;font-weight:700;color:#34d399">Contrat signé</div>'+
      (client.contractTemplateName?'<div style="font-size:10px;color:var(--muted)">'+esc(client.contractTemplateName)+'</div>':'')+
      (client.contractSignedAt?'<div style="font-size:10px;color:var(--muted)">'+fmtDateTime(client.contractSignedAt)+'</div>':'')+
      '</div></div>';
  }
  if (pays.length){
    pays.forEach(function(p){
      var prog = p.installmentsCount > 1 ? (p.paidCount||0) + '/' + p.installmentsCount + ' mois' : '';
      var pct = p.installmentsCount > 1 ? Math.round(((p.paidCount||0)/p.installmentsCount)*100) : (p.status === 'completed' ? 100 : 0);
      h += '<div class="cl-pay-block" id="payBlock_'+p.id+'">'+
        '<div class="cl-pay-head">'+
          '<div><div class="cl-pay-amount">'+EUROc(p.totalAmount)+' <span style="font-size:10px;opacity:.5">'+(p.vatType||'ht').toUpperCase()+'</span>'+(p.type==='installments'?' <span style="font-size:11px;color:var(--muted)">· '+p.installmentsCount+' mois</span>':'')+'</div>'+
            '<div class="cl-pay-sub">'+(STATUS_PAY[p.status]||p.status)+(prog?' · '+prog:'')+(p.gcMandateId?' · Mandat: <span style="font-family:monospace">'+p.gcMandateId.slice(-8)+'</span>':'')+'</div></div>'+
          '<div style="text-align:right">'+
            (p.paidAmount?'<div class="cl-pay-collected">'+EUROc(p.paidAmount)+' collecté</div>':'')+
            '<button class="cl-mini-btn" data-action="syncGC" data-pid="'+p.id+'" style="margin-top:4px">🔄 Sync GC</button>'+
          '</div>'+
        '</div>'+
        (p.installmentsCount > 1 ? '<div class="cl-progress"><div class="cl-progress-fill" style="width:'+pct+'%"></div></div>' : '')+
        '<div id="gcLiveData_'+p.id+'" style="margin-top:8px;display:none"></div>'+
        '</div>';
    });
  } else {
    h += '<div style="font-size:12px;color:var(--muted)">Aucun paiement enregistré — <a href="payments.html?leadId='+client.id+'" style="color:#34d399">Créer un paiement</a></div>';
  }

  // GoCardless live
  if (client.paiementPlateforme === 'GOCARDLESS' || client.gcCustomerId || pays.some(function(p){return p.gcMandateId;})){
    var hasGc = client.gcCustomerId || pays.some(function(p){return p.gcMandateId;});
    h += '<div class="cl-gc-section">'+
      '<div style="font-size:10px;font-weight:700;color:var(--muted);margin-bottom:6px;display:flex;align-items:center;justify-content:space-between">'+
        '<span>🏦 GoCardless</span>'+
        '<button class="cl-mini-btn" data-action="gcLookup" data-email="'+escA(client.email||'')+'">'+(hasGc?'🔄 Resync':'🔍 Chercher dans GC')+'</button>'+
      '</div>'+
      '<div id="gcLookupResult_'+client.id+'" style="font-size:11px;color:var(--muted)">'+
        (hasGc ? '✅ Lié — cliquer Resync pour actualiser' : 'Non lié — cliquer pour chercher par email')+
      '</div></div>';
  }

  // Témoignages
  h += '<div class="cl-sec-h mt">⭐ Témoignages <span style="font-weight:400;font-size:10px;color:var(--muted);text-transform:none;letter-spacing:0">('+temos.length+')</span></div>';
  if (temos.length === 0){
    h += '<div style="color:var(--muted);font-size:12px;padding:4px 0">Aucun témoignage</div>';
  }
  temos.forEach(function(t){
    h += '<div class="cl-temo-item">'+
      '<span class="cl-temo-type '+(t.type||'autre')+'">'+esc(t.type||'autre')+'</span>'+
      '<a class="cl-temo-url" href="'+escA(t.url||'')+'" target="_blank" rel="noopener">'+esc(t.url||'—')+'</a>'+
      (t.label?'<span style="font-size:10px;color:var(--muted);flex-shrink:0">'+esc(t.label)+'</span>':'')+
      '<button class="cl-temo-del" data-action="delTemo" data-tid="'+t.id+'" title="Supprimer">✕</button>'+
      '</div>';
  });
  h += '<div class="cl-temo-add">'+
    '<select class="cl-select" id="temoType" style="width:130px">'+
    TEMO_TYPES.map(function(tp){ return '<option value="'+tp.key+'">'+tp.icon+' '+esc(tp.label)+'</option>'; }).join('')+
    '</select>'+
    '<input class="cl-input" id="temoUrl" placeholder="URL du témoignage…"/>'+
    '<button class="cl-temo-add-btn" data-action="addTemo">+ Ajouter</button>'+
    '</div>';

  h += '</div>'; // fin col droite
  h += '</div>'; // fin 2 cols

  /* NOTES STRUCTURÉES (sous-coll client_notes) */
  h += '<div style="margin-bottom:18px"><div class="cl-sec-h">📝 Notes de suivi <span style="font-weight:400;font-size:10px;color:var(--muted);text-transform:none;letter-spacing:0">('+notes.length+')</span></div>';
  if (notes.length === 0){
    h += '<div style="color:var(--muted);font-size:12px;padding:4px 0">Aucune note</div>';
  }
  notes.forEach(function(n){
    h += '<div class="cl-note-item">'+
      '<button class="cl-note-del" data-action="delNote" data-nid="'+n.id+'" title="Supprimer" style="float:right">✕</button>'+
      '<div class="cl-note-meta">'+
      (n.auteur?'<span class="cl-note-author">'+esc(n.auteur)+'</span>':'')+
      '<span class="cl-note-date">'+fmtDate(n.createdAt)+'</span>'+
      '</div>'+
      '<div class="cl-note-text">'+esc(n.contenu||'')+'</div>'+
      '</div>';
  });
  h += '<div class="cl-note-add">'+
    '<textarea class="cl-note-textarea" id="noteInput" placeholder="Écrire une note de suivi…"></textarea>'+
    '<button class="cl-note-submit" data-action="addNote">+ Ajouter une note</button>'+
    '</div>';
  h += '</div>';

  /* TIMELINE */
  var tl = (client.timeline_history || []).slice(-10).reverse();
  if (tl.length){
    h += '<div style="margin-bottom:18px"><div class="cl-sec-h">📜 Historique récent</div>';
    tl.forEach(function(t){
      h += '<div class="cl-tl-item"><div class="cl-tl-dot" style="background:'+(t.color||'#a78bfa')+'"></div><div class="cl-tl-text">'+esc(t.text||'')+'</div><div class="cl-tl-date">'+esc(t.date||'')+'</div></div>';
    });
    h += '</div>';
  }

  /* ACTIONS */
  h += '<div class="cl-actions">';
  if (client.telephone){
    h += '<button type="button" class="cl-action-btn green" data-action="dialerCall" data-phone="'+escA(String(client.telephone).replace(/\s/g,''))+'" data-name="'+escA(client.nom||'')+'">📞 Appeler</button>';
  }
  if (client.email){
    h += '<a class="cl-action-btn blue" href="mailto:'+escA(client.email)+'">✉️ Email</a>';
  }
  h += '<a class="cl-action-btn green" href="payments.html?leadId='+client.id+'">💳 Paiements</a>';
  h += '<div style="flex:1"></div>';
  h += '<button class="cl-action-btn amber" data-action="removeFromClients">📤 Retirer des clients</button>';
  if (window._currentRole === 'admin'){
    h += '<button class="cl-action-btn red" data-action="deleteLead">🗑 Supprimer le lead</button>';
  }
  h += '</div>';

  h += '<div class="cl-saved" id="panelSaved">✅ Sauvegardé</div>';
  h += '</div>'; // fin panel-body

  document.getElementById('panelContent').innerHTML = h;

  // Restaure le HTML enrichi GoCardless si présent en cache
  // (évite que le re-render écrase ce que Resync a affiché)
  if (gcLiveLookupCache[openLeadId]) {
    var lkEl = document.getElementById('gcLookupResult_' + openLeadId);
    if (lkEl) lkEl.innerHTML = gcLiveLookupCache[openLeadId];
  }
  pays.forEach(function(p){
    if (gcLivePayCache[p.id]) {
      var liveEl = document.getElementById('gcLiveData_' + p.id);
      if (liveEl) {
        liveEl.innerHTML = gcLivePayCache[p.id];
        liveEl.style.display = 'block';
      }
    }
  });
}

/* Helpers édition inline */
function renderEditRow(emoji, label, inner){
  return '<div class="cl-edit-row"><span class="e">'+emoji+'</span><span class="l">'+esc(label)+'</span><div class="v">'+inner+'</div></div>';
}
function renderInput(field, val, type){
  return '<input class="cl-edit-input" type="'+(type||'text')+'" data-cedit="'+field+'" value="'+escA(val||'')+'"/>';
}
function renderTxa(field, val){
  return '<textarea class="cl-edit-input txa" data-cedit="'+field+'" rows="2">'+esc(val||'')+'</textarea>';
}
function renderSelect(field, val, opts){
  var html = '<select class="cl-edit-input cl-edit-select" data-cedit="'+field+'"><option value="">—</option>';
  opts.forEach(function(o){ html += '<option value="'+escA(o)+'"'+(val===o?' selected':'')+'>'+esc(o)+'</option>'; });
  return html + '</select>';
}

/* ═══ PANEL EVENTS ═══ */
document.getElementById('panelBg').addEventListener('click', function(e){
  // Backdrop close
  if(e.target === this){ closePanel(); return; }
  if(e.target.closest('[data-action="closePanel"]')){ closePanel(); return; }

  // Appel via Ringover (DialerBridge)
  var dcBtn = e.target.closest('[data-action="dialerCall"]');
  if (dcBtn){
    e.preventDefault();
    e.stopPropagation();
    if (window.DialerBridge && dcBtn.dataset.phone){
      window.DialerBridge.callLead(openLeadId || null, dcBtn.dataset.phone, dcBtn.dataset.name || null);
    } else if (!window.DialerBridge){
      toast('❌ Dialer Bridge non chargé');
    }
    return;
  }

  // Status pill change
  var csBtn = e.target.closest('[data-action="setCStatus"]');
  if (csBtn){
    var newStatus = csBtn.dataset.val;
    db.collection('leads').doc(openLeadId).update({
      clientStatus: newStatus,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }).then(function(){
      var c = allClients.find(function(x){ return x.id === openLeadId; });
      if (c) c.clientStatus = newStatus;
      toast('✅ Statut mis à jour');
      refreshPanel();
      renderAll();
    }).catch(function(err){ toast('❌ '+err.message); });
    return;
  }

  // Add témoignage
  if(e.target.closest('[data-action="addTemo"]')){
    var url = document.getElementById('temoUrl').value.trim();
    if(!url){ toast('❌ URL requise'); return; }
    var type = document.getElementById('temoType').value;
    var lid = openLeadId;
    db.collection('leads').doc(lid).collection('client_temoignages').add({
      type:type, url:url, label:'',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    }).then(function(){
      toast('⭐ Témoignage ajouté');
      loadTemoignages(lid, function(){ refreshPanel(); renderAll(); });
    }).catch(function(err){ toast('❌ '+err.message); });
    return;
  }

  // Delete témoignage
  var dt = e.target.closest('[data-action="delTemo"]');
  if (dt){
    if(!confirm('Supprimer ce témoignage ?')) return;
    var lid2 = openLeadId;
    db.collection('leads').doc(lid2).collection('client_temoignages').doc(dt.dataset.tid).delete()
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
    var u = firebase.auth().currentUser;
    db.collection('leads').doc(lid3).collection('client_notes').add({
      contenu:txt, auteur:u?u.email:'inconnu',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    }).then(function(){
      toast('📝 Note ajoutée');
      loadNotes(lid3, function(){ refreshPanel(); });
    }).catch(function(err){ toast('❌ '+err.message); });
    return;
  }

  // Delete note
  var dn = e.target.closest('[data-action="delNote"]');
  if (dn){
    if(!confirm('Supprimer cette note ?')) return;
    var lid4 = openLeadId;
    db.collection('leads').doc(lid4).collection('client_notes').doc(dn.dataset.nid).delete()
      .then(function(){
        toast('🗑 Note supprimée');
        loadNotes(lid4, function(){ refreshPanel(); });
      }).catch(function(err){ toast('❌ '+err.message); });
    return;
  }

  // GC Sync
  var gs = e.target.closest('[data-action="syncGC"]');
  if (gs){ syncGCPayment(gs.dataset.pid, openLeadId); return; }

  var gl = e.target.closest('[data-action="gcLookup"]');
  if (gl){ gcLookupClient(openLeadId, gl.dataset.email); return; }

  // Remove from clients
  if (e.target.closest('[data-action="removeFromClients"]')){
    var c = allClients.find(function(x){ return x.id === openLeadId; });
    if (!confirm('Retirer "'+(c?c.nom:openLeadId)+'" des clients ? (Le lead reste dans le pipeline)')) return;
    db.collection('leads').doc(openLeadId).update({
      isClient: false,
      clientStatus: null,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }).then(function(){
      toast('📤 Retiré des clients');
      closePanel();
    }).catch(function(err){ toast('❌ '+err.message); });
    return;
  }

  // Delete lead (admin)
  if (e.target.closest('[data-action="deleteLead"]')){
    var c2 = allClients.find(function(x){ return x.id === openLeadId; });
    if (!confirm('⚠️ Supprimer définitivement "'+(c2?c2.nom:openLeadId)+'" ? Action irréversible.')) return;
    db.collection('leads').doc(openLeadId).delete().then(function(){
      toast('🗑 Lead supprimé');
      closePanel();
    }).catch(function(err){ toast('❌ '+err.message); });
    return;
  }
});

/* Auto-save fields */
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
  var fields = ['nom','email','telephone','commerce','secteur','ca','problematique','pbSecondaires','resultats',
                'formule','accompagnementStart','accompagnementEnd','retractation','paiementPlateforme','commissions',
                'coaching72','setting','closeurName','goodies','dateEnvoiGoodies',
                'prospectWebinaire','dateWebinaire','present','rejetMails','coachAssigned'];
  var upd = {};
  fields.forEach(function(f){
    var el = panel.querySelector('[data-cedit="'+f+'"]');
    if(el) upd[f] = el.value.trim();
  });
  upd.updatedAt = firebase.firestore.FieldValue.serverTimestamp();

  // Update local cache
  var c = allClients.find(function(x){ return x.id === openLeadId; });
  if(c){ for(var k in upd){ if(k!=='updatedAt') c[k] = upd[k]; } }

  db.collection('leads').doc(openLeadId).update(upd).then(function(){
    var saved = document.getElementById('panelSaved');
    if(saved){ saved.style.opacity = '1'; setTimeout(function(){ saved.style.opacity = '0'; }, 1500); }
    renderAll();
  }).catch(function(err){ toast('❌ '+err.message); });
}

/* Close on Escape */
document.addEventListener('keydown', function(e){
  if(e.key === 'Escape' && openLeadId) closePanel();
});

/* ═══ GoCardless functions ═══ */
function gcLookupClient(leadId, email){
  var resultEl = document.getElementById('gcLookupResult_' + leadId);
  if (resultEl) resultEl.innerHTML = '⏳ Recherche en cours…';
  firebase.auth().currentUser.getIdToken().then(function(token){
    return fetch('/api/gocardless-lookup', {
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
      body: JSON.stringify({ leadId:leadId, email:email })
    }).then(function(r){ return r.json().then(function(d){ return { ok:r.ok, data:d }; }); });
  }).then(function(res){
    if (!res.ok) throw new Error(res.data.error || 'Erreur API');
    var data = res.data;
    var pmStatus = { pending_submission:'⏳', submitted:'📤', confirmed:'✅', paid_out:'💰', cancelled:'🚫', failed:'❌', charged_back:'↩' };
    var mdStatus = { pending_submission:'⏳ En attente', submitted:'📤 Soumis', active:'✅ Actif', failed:'❌ Échoué', cancelled:'🚫 Annulé', expired:'⌛ Expiré' };
    var html = '';
    html += '<div style="padding:6px 8px;background:rgba(16,185,129,.06);border-radius:6px;margin-bottom:8px;font-size:11px">'+
      '👤 '+esc((data.customer.givenName||'')+' '+(data.customer.familyName||''))+' — <span style="font-family:monospace;color:#60a5fa">'+esc(data.customer.id)+'</span></div>';
    if (data.mandates && data.mandates.length){
      html += '<div style="font-size:10px;font-weight:700;color:var(--muted);margin-bottom:4px">Mandats ('+data.mandates.length+')</div>';
      data.mandates.forEach(function(m){
        html += '<div style="display:flex;justify-content:space-between;padding:4px 6px;background:var(--bg3);border-radius:4px;margin-bottom:3px"><span style="font-family:monospace;font-size:10px">'+esc(m.id)+'</span><span style="font-size:10px;color:var(--muted)">'+(mdStatus[m.status]||m.status)+'</span></div>';
      });
    }
    if (data.subscriptions && data.subscriptions.length){
      html += '<div style="font-size:10px;font-weight:700;color:var(--muted);margin:6px 0 4px">Abonnements ('+data.subscriptions.length+')</div>';
      data.subscriptions.forEach(function(s){
        html += '<div style="padding:6px 8px;background:var(--bg3);border-radius:6px;margin-bottom:4px">'+
          '<div style="display:flex;justify-content:space-between"><span style="font-size:11px;font-weight:600">'+EUROc(s.amount)+'/mois × '+(s.count||'?')+'</span>'+
          '<span style="font-size:10px;color:'+(s.status==='active'?'#34d399':'var(--muted)')+'">'+esc(s.status)+'</span></div>';
        if (s.upcomingPayments && s.upcomingPayments.length){
          html += '<div style="font-size:10px;color:var(--muted);margin-top:3px">Prochain : '+esc(s.upcomingPayments[0].chargeDate)+' · '+EUROc(s.upcomingPayments[0].amount)+'</div>';
        }
        html += '</div>';
      });
    }
    if (data.payments && data.payments.length){
      html += '<div style="font-size:10px;font-weight:700;color:var(--muted);margin:6px 0 4px">Paiements ('+data.payments.length+')</div>';
      html += '<div style="max-height:150px;overflow-y:auto">';
      data.payments.forEach(function(p){
        html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 6px;border-radius:4px;margin-bottom:2px;background:rgba(255,255,255,.02)">'+
          '<span style="font-size:11px">'+(pmStatus[p.status]||'?')+' '+esc(p.chargeDate||'')+'</span>'+
          '<span style="font-size:11px;font-weight:700;color:'+(p.status==='paid_out'?'#34d399':'var(--muted)')+'">'+EUROc(p.amount)+'</span></div>';
      });
      html += '</div>';
    }
    if (resultEl) resultEl.innerHTML = html;
    gcLiveLookupCache[leadId] = html;
    reloadOnePayment(leadId, function(){ /* Cache updated, no full re-render */ });
    toast('✅ GoCardless synchronisé — '+data.payments.length+' paiement(s)');
  }).catch(function(e){
    if (resultEl) resultEl.innerHTML = '❌ '+esc(e.message);
    toast('❌ '+e.message);
  });
}

function syncGCPayment(payId, leadId){
  var liveEl = document.getElementById('gcLiveData_' + payId);
  firebase.auth().currentUser.getIdToken().then(function(token){
    return fetch('/api/gocardless-status', {
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
      body: JSON.stringify({ paymentId: payId })
    }).then(function(r){ return r.json().then(function(d){ return { ok:r.ok, data:d }; }); });
  }).then(function(res){
    if (!res.ok) throw new Error(res.data.error || 'Erreur API');
    var data = res.data;
    var gcHtml = '';
    if (data.mandate){
      var mStatus = { pending_submission:'⏳ En attente', submitted:'📤 Soumis', active:'✅ Actif', failed:'❌ Échoué', cancelled:'🚫 Annulé', expired:'⌛ Expiré' };
      gcHtml += '<div style="font-size:10px;color:var(--muted);margin-bottom:6px">Mandat GC : <strong style="color:#60a5fa">'+(mStatus[data.mandate.status]||data.mandate.status)+'</strong>'+(data.mandate.nextPossibleChargeDate?' · Prochain : '+esc(data.mandate.nextPossibleChargeDate):'')+'</div>';
    }
    if (data.subscription && data.subscription.upcomingPayments && data.subscription.upcomingPayments.length){
      var upHtml = data.subscription.upcomingPayments.slice(0,3).map(function(up){
        return '<span style="display:inline-block;padding:2px 7px;background:rgba(16,185,129,.1);border-radius:4px;font-size:10px;color:#34d399;margin-right:4px">'+esc(up.charge_date)+' · '+EUROc(up.amount/100)+'</span>';
      }).join('');
      gcHtml += '<div style="margin-bottom:6px"><div style="font-size:10px;color:var(--muted);margin-bottom:3px">Prochains prélèvements :</div>'+upHtml+'</div>';
    }
    if (data.payments && data.payments.length){
      var pStatus = { pending_submission:'⏳', submitted:'📤', confirmed:'✅', paid_out:'💰', cancelled:'🚫', failed:'❌', charged_back:'↩' };
      gcHtml += '<div style="font-size:10px;color:var(--muted);margin-bottom:4px">Historique GoCardless ('+data.payments.length+') :</div>';
      gcHtml += '<div style="max-height:120px;overflow-y:auto">';
      data.payments.forEach(function(p){
        gcHtml += '<div style="display:flex;justify-content:space-between;padding:4px 6px;border-radius:4px;background:rgba(255,255,255,.03);margin-bottom:2px">'+
          '<span style="font-size:11px">'+(pStatus[p.status]||'?')+' '+esc(p.chargeDate||'')+'</span>'+
          '<span style="font-size:11px;font-weight:600;color:#34d399">'+EUROc(p.amount)+'</span></div>';
      });
      gcHtml += '</div>';
    }
    if (liveEl){ liveEl.innerHTML = gcHtml; liveEl.style.display = gcHtml ? 'block' : 'none'; }
    if (gcHtml) gcLivePayCache[payId] = gcHtml;
    toast('🔄 GoCardless synchronisé');
    reloadOnePayment(leadId, function(){});
  }).catch(function(e){ toast('❌ '+e.message); });
}

/* ═══ EXPORT CSV ═══ */
document.getElementById('btnExport').addEventListener('click', function(){
  var list = getFiltered();
  var rows = [['Nom','Email','Téléphone','Commerce','Formule','Coach','Closeur','Statut client','Début','Fin','Paiement','Témoignages','Alertes']];
  list.forEach(function(c){
    var pays = paymentsCache[c.id] || [];
    var mainPay = pays.slice().sort(function(a,b){
      return (b.createdAt && b.createdAt.seconds || 0) - (a.createdAt && a.createdAt.seconds || 0);
    })[0];
    var payStr = mainPay ? EURO(mainPay.totalAmount) : '';
    var alerts = computeAlerts(c).map(function(a){ return a.label; }).join(' / ');
    rows.push([
      c.nom||'', c.email||'', c.telephone||'', c.commerce||'',
      c.formule||'', COACH_MAP[c.coachAssigned||c.coach]||'', c.closeurName||c.closeurSlug||'',
      (c.clientStatus||'active'),
      c.accompagnementStart||c.accompagnementDebut||'',
      c.accompagnementEnd||c.accompagnementFin||'',
      payStr, (temoCache[c.id]||[]).length, alerts
    ]);
  });
  var csv = rows.map(function(r){ return r.map(function(v){ return '"'+String(v).replace(/"/g,'""')+'"'; }).join(','); }).join('\n');
  var blob = new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'});
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a'); a.href = url; a.download = 'clients_ambitio.csv'; a.click();
  URL.revokeObjectURL(url);
  toast('📥 Export CSV téléchargé');
});
