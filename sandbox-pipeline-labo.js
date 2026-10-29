/* ═══════════════════════════════════════════════════════════════════════════
   sandbox-pipeline-labo.js — LABO PIPELINE : démarrage (29/10/2026)
   ─────────────────────────────────────────────────────────────────────────
   Chargé UNIQUEMENT par sandbox-pipeline.html, après le faux Firebase
   (sandbox-leads-live-db.js) et l'hôte réel (pipeline-v2-host.js).
   La base est celle du Labo Leads Live : mêmes leads, mêmes RDV, et les
   écritures d'un onglet arrivent dans l'autre. Rien ne part : pas de
   Firestore réel, pas d'appel, pas de SMS.
   Ce qui n'existe pas dans le Labo (Dialer, parcours de close, écoute) est
   simulé par un message. « Poser un RDV » crée un faux RDV NB demain 14 h.
   ES5 strict.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var fb = window.firebase, db = fb.firestore(), FV = fb.firestore.FieldValue, SBX = window.__SBX;
  var ROLE_KEY = 'sbxpl:role';
  function toast(m) { if (window.PipelineV2) window.PipelineV2.toast('🧪 ' + m); }
  function p2(n) { return (n < 10 ? '0' : '') + n; }

  Promise.all([db.collection('_meta').doc('team_members').get(), db.collection('users').doc('u-moi').get()]).then(function (r) {
    var mem = ((r[0].data() || {}).members) || {}, user = r[1].data() || {};
    var list = Object.keys(mem).map(function (k) { return mem[k]; }).sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    window.TEAM_MEMBERS_LIST = list;   /* AlteoreFlow.me() s'en sert pour signer les résultats de RDV */
    window.TEAM_MEMBERS = mem;
    var team = list.filter(function (m) { return m.role !== 'coach' && m.role !== 'csm'; }).map(function (m) {
      return { slug: m.slug, name: m.shortName || m.slug, color: m.color || '#9096ad', pipeline: m.active !== false };
    });
    var moi = mem.moi || { slug: 'moi', shortName: SBX.moi.nom };
    var role = null;
    try { role = localStorage.getItem(ROLE_KEY); } catch (e) {}
    var me = { slug: 'moi', name: moi.shortName || SBX.moi.nom, uid: 'u-moi', role: role || (user.role === 'admin' ? 'admin' : 'sales') };

    var host = window.PipelineV2Host.create({
      db: db, FV: FV, me: me, team: team,
      leadsQuery: db.collection('leads').orderBy('createdAt', 'desc'),
      bookingsQuery: db.collection('bookings'),
      leadsLiveUrl: 'sandbox-leads-live.html',
      logCalls: true,
      ui: {
        call: function (l) { toast('Le Dialer appellerait ' + (l.telephone || 'ce lead')); },
        listen: function () { toast('Écoute de l\'enregistrement : désactivée dans le Labo'); },
        openClose: function (l) { toast('Le parcours de close s\'ouvrirait ici pour ' + l.nom + ' (testable dans le Bac à sable closer)'); },
        openBooking: function (l) {
          var d = new Date(); d.setDate(d.getDate() + 1);
          var parts = String(l.nom || '').split(' ');
          db.collection('bookings').add({
            leadId: l.id, date: d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()), time: '14:00', duration: 45, status: 'confirmed',
            source: 'setter_booking', bookedBySlug: me.slug, bookedByName: me.name, personName: 'Vincent', personId: 'vincent', type: 'call_strat', typeName: 'Appel stratégique',
            prospect: { prenom: parts[0] || '', nom: parts.slice(1).join(' '), email: l.email || '', telephone: l.telephone || '' }, createdAt: FV.serverTimestamp()
          }).then(function () {
            host.setStage(l, 'set', function () { toast('Faux RDV posé demain à 14 h avec Vincent : ' + l.nom + ' passe en SET NB'); });
          });
        },
        callDetail: function (l, c, cb) {
          setTimeout(function () { cb(null, { summary: 'Appel de ' + Math.round(((c && c.duration) || 0) / 60) + ' min (conversation fictive du Labo).', speeches: [{ me: true, text: 'Bonjour, c\'est ' + ((c && c.ownerName) || 'l\'équipe') + ' d\'Alteore.' }, { me: false, text: 'Oui bonjour.' }] }); }, 400);
        },
        generateAi: function (l, cb) {
          var d = window.PipelineV2._derive(l);
          db.collection('leads').doc(l.id).update({ aiLead: {
            niveau: d.fam === 'rdv' ? 'chaud' : d.fam === 'sansuite' || d.fam === 'relance' ? 'tiède' : 'froid', proba: d.fam === 'rdv' ? 70 : d.fam === 'sansuite' ? 45 : 25,
            brief: [d.situ, d.pb.text ? 'Son problème : ' + d.pb.text : 'Aucun problème exprimé : à découvrir au prochain appel.'],
            angle: d.pb.text ? 'Repartir de son problème : « ' + d.pb.text + ' »' : 'Faire parler le prospect de son quotidien de dirigeant.',
            ouverture: 'Bonjour ' + String(l.nom || '').split(' ')[0] + ', je reviens vers vous suite à notre dernier échange.', generatedAt: new Date().toISOString(), key: 'sbx' } }).then(function () { setTimeout(function () { cb(null); }, 600); }, cb);
        }
      },
      onReady: function (h) {
        window.PipelineV2.start(document.getElementById('pv2root'), h);
        bandeau(me);
      }
    });
  }).catch(function (e) {
    document.getElementById('pv2root').innerHTML = '<div class="sbxpl-wait">Le Labo n\'a pas pu démarrer : ' + String(e && e.message || e) + '</div>';
  });

  function bandeau(me) {
    var bd = document.createElement('div');
    bd.className = 'sbxpl-band';
    var roleLabel = function () { return me.role === 'admin' ? 'Vu en admin' : 'Vu en sales'; };
    bd.innerHTML = '<span>🧪 Labo Pipeline · mêmes faux leads que le Labo Leads Live · rien n\'est envoyé</span>' +
      '<button type="button" data-sbx="ll" title="Ouvrir le Labo Leads Live dans un autre onglet">Labo Leads Live ↗</button>' +
      '<button type="button" data-sbx="role" title="Voir le Pipeline comme un admin ou comme un sales">' + roleLabel() + '</button>' +
      '<button type="button" data-sbx="reset" title="Remet les deux Labos à zéro">Réinitialiser</button><button type="button" data-sbx="close">Fermer</button>';
    bd.addEventListener('click', function (e) {
      var b = e.target.closest('[data-sbx]'); if (!b) return;
      var k = b.getAttribute('data-sbx');
      if (k === 'll') { window.open('sandbox-leads-live.html', 'sbx_leads_live'); }
      else if (k === 'role') {
        me.role = me.role === 'admin' ? 'sales' : 'admin';
        try { localStorage.setItem(ROLE_KEY, me.role); } catch (x) {}
        b.textContent = roleLabel(); window.PipelineV2.refresh();
        toast(me.role === 'admin' ? 'Tu vois le Pipeline comme un admin' : 'Tu vois le Pipeline comme un sales : reprise possible après 7 jours sans contact');
      } else if (k === 'reset') {
        if (window.confirm('Remettre les deux Labos (Pipeline et Leads Live) à zéro ?')) SBX.reset();
      } else { window.close(); setTimeout(function () { location.href = 'sales-crm.html'; }, 150); }
    });
    document.body.appendChild(bd);
  }
})();
