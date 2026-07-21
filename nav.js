/**
 * nav.js — Ambitio Corp Sidebar Navigation
 * Rôles : coach / sales / admin
 * Mis à jour : inclut les pages coaching séparées (dashboard, analyse, agenda)
 */

(function () {

  // Apply saved theme immediately to prevent flash
  if (localStorage.getItem('ambitio_theme') === 'light') document.body.classList.add('light-theme');

  /* ─── Permission keys ─── */
  const PERM_KEYS = [
    'coaching_clients','coaching_dashboard','coaching_communication',
    'sales_crm','sales_dashboard','sales_saisie','sales_dialer',
    'sales_equipe','sales_commissions','sales_projections','booking',
    'csm_dashboard','csm_clients'
  ];

  const ROLE_DEFAULTS = {
    admin: { coaching_clients:'edit',coaching_dashboard:'edit',coaching_communication:'edit',
             sales_crm:'edit',sales_dashboard:'edit',sales_saisie:'edit',sales_dialer:'edit',
             sales_equipe:'edit',sales_commissions:'edit',sales_projections:'edit',booking:'edit',
             csm_dashboard:'edit',csm_clients:'edit' },
    coach: { coaching_clients:'edit',coaching_dashboard:'edit',coaching_communication:'edit',
             sales_crm:'none',sales_dashboard:'none',sales_saisie:'none',sales_dialer:'none',
             sales_equipe:'none',sales_commissions:'none',sales_projections:'none',booking:'none',
             csm_dashboard:'none',csm_clients:'none' },
    sales: { coaching_clients:'none',coaching_dashboard:'none',coaching_communication:'none',
             sales_crm:'edit',sales_dashboard:'edit',sales_saisie:'edit',sales_dialer:'edit',
             sales_equipe:'edit',sales_commissions:'edit',sales_projections:'edit',booking:'edit',
             csm_dashboard:'none',csm_clients:'none' },
    // ─── CSM (Customer Success Manager) ───
    // Voit son dashboard CSM, les clients (coaching + sales-clients), la
    // communication coaching, le coaching dashboard. Les flags signaturesAccess
    // et l'accès paiements sont gérés ailleurs (rule Firestore + flag user).
    csm:   { coaching_clients:'edit',coaching_dashboard:'edit',coaching_communication:'edit',
             sales_crm:'none',sales_dashboard:'none',sales_saisie:'none',sales_dialer:'none',
             sales_equipe:'none',sales_commissions:'none',sales_projections:'none',booking:'none',
             csm_dashboard:'edit',csm_clients:'edit' },
  };

  const PERM_LABELS = {
    coaching_clients:'Clients (Coaching)',coaching_dashboard:'Dashboard (Coaching)',coaching_communication:'Communication',
    sales_crm:'CRM',sales_dashboard:'Dashboard (Sales)',sales_saisie:'Set NB / Close SB / EOD',
    sales_dialer:'Dialer',
    sales_equipe:'Équipe',sales_commissions:'Commissions',sales_projections:'Projections',booking:'Booking',alteoforms:'AlteoForms',
    csm_dashboard:'Dashboard CSM',csm_clients:'Clients (CSM)'
  };

  const ALL_MODULES = [
    // ─── CUSTOMER SUCCESS — visible pour le rôle csm + admin ───
    { id: 'csm-dashboard',     icon: '💎', label: 'Dashboard CSM', href: 'csm-dashboard.html', section: 'Customer Success', perm: 'csm_dashboard' },
    { id: 'csm-clients',       icon: '👥', label: 'Clients',       href: 'csm-clients.html',   section: 'Customer Success', perm: 'csm_clients' },
    { id: 'csm-diagnostic',    icon: '🔍', label: 'Diagnostic',    href: 'csm-diagnostic.html', section: 'Customer Success', perm: 'csm_dashboard' },
    { id: 'coach-clients',       icon: '👥', label: 'Coaching',      href: 'coaching.html',               section: 'Coaching', perm: 'coaching_clients' },
    { id: 'coach-dashboard',     icon: '📊', label: 'Dashboard',     href: 'coaching-dashboard.html',     section: 'Coaching', perm: 'coaching_dashboard' },
    { id: 'sales-dashboard',   icon: '📊', label: 'Dashboard',         href: 'sales-dashboard.html',   section: 'Sales', perm: 'sales_dashboard' },
    { id: 'sales-funnel',      icon: '🎯', label: 'Funnel',            href: 'sales-funnel.html',      section: 'Sales', perm: '_admin' },
    { id: 'sales-crm', icon: '🧩', label: 'CRM', href: '#', section: 'Sales', perm: 'sales_crm', children: [
      { id: 'sales-leads_live',  icon: '🔔', label: 'Leads Live',    href: 'sales-leads.html' },
      { id: 'sales-pipeline',    icon: '▥',  label: 'Pipeline',      href: 'sales-crm.html' },
      { id: 'sales-retargeting', icon: '🔄', label: 'Retargeting',   href: 'sales-retargeting.html' },
      { id: 'sales-suivi',       icon: '📋', label: 'Clients', href: 'sales-clients.html' },
    ]},
    { id: 'sales-saisie',      icon: '✏️', label: 'Set NB / Close SB', href: '#',                      section: 'Sales', perm: 'sales_saisie', children: [
      { id: 'sales-setting',      icon: '📞', label: 'Set NB',       href: 'sales-setting.html' },
      { id: 'sales-closing',      icon: '🎯', label: 'Close SB',     href: 'sales-closing.html' },
      { id: 'sales-eod',          icon: '📝', label: 'EOD',          href: 'sales-eod.html' },
      { id: 'sales-commissions',  icon: '💰', label: 'Commissions',  href: 'sales-commissions.html' },
      { id: 'sales-projections',  icon: '📈', label: 'Projections',  href: 'sales-projections.html' },
      { id: 'sales-equipe',       icon: '👥', label: 'Équipe Sales', href: 'sales-equipe.html' },
    ]},
    { id: 'booking',           icon: '📅', label: 'Booking',     href: 'booking-admin.html',     section: 'Sales', perm: 'booking' },
    { id: 'sales-rdv',         icon: '🗓️', label: 'Rendez-vous',  href: 'sales-rdv.html',         section: 'Sales', perm: 'booking' },
    { id: 'sales-dialer',      icon: '☎️', label: 'Dialer',      href: 'sales-dialer.html',      section: 'Sales', perm: 'sales_dialer' },
    { id: 'signatures',        icon: '✍️', label: 'Signatures',  href: 'sales-signatures.html',  section: 'Sales', perm: 'signatures' },
    { id: 'admin-users',       icon: '🔑', label: 'Utilisateurs', href: 'admin-users.html',      section: 'Admin', perm: '_admin' },
    { id: 'admin-persons',     icon: '👤', label: 'Persons',      href: 'admin-persons.html',    section: 'Admin', perm: '_admin' },
    { id: 'admin-numbers',     icon: '📞', label: 'Numéros',      href: 'admin-numbers.html',     section: 'Admin', perm: '_admin' },
    { id: 'admin-billing',     icon: '🧾', label: 'Facturation',  href: 'admin-facturation.html', section: 'Admin', perm: '_admin' },
    { id: 'admin-dedup',       icon: '🔄', label: 'Dédup Clients', href: 'clients-dedup.html',    section: 'Admin', perm: '_admin' },
    { id: 'alteoforms',        icon: '📝', label: 'AlteoForms',   href: 'alteoforms.html',        section: 'Outils', perm: 'alteoforms' },
    { id: 'payments',          icon: '💳', label: 'Paiements',    href: 'payments.html',          section: 'Outils', perm: 'payments' },
  ];

  const THEMES = {
    coach: {
      label: 'Espace Coaching', emoji: '🎓',
      grad1: '#2d1b69', grad2: '#4c1d95', grad3: '#7c3aed',
      accent: '#a78bfa', accentLight: '#ede9fe',
      accentGlow: 'rgba(167,139,250,0.18)',
      roleBg: 'rgba(167,139,250,0.12)', roleBorder: 'rgba(167,139,250,0.25)',
    },
    sales: {
      label: 'Espace Sales', emoji: '📈',
      grad1: '#3b0a0a', grad2: '#7f1d1d', grad3: '#b91c1c',
      accent: '#fca5a5', accentLight: '#fff1f2',
      accentGlow: 'rgba(252,165,165,0.18)',
      roleBg: 'rgba(252,165,165,0.12)', roleBorder: 'rgba(252,165,165,0.25)',
    },
    admin: {
      label: 'Administration', emoji: '👑',
      grad1: '#0a0e1a', grad2: '#1a2035', grad3: '#1e3a5f',
      accent: '#60a5fa', accentLight: '#eff6ff',
      accentGlow: 'rgba(96,165,250,0.18)',
      roleBg: 'rgba(251,191,36,0.12)', roleBorder: 'rgba(251,191,36,0.25)',
    },
    // ─── Customer Success Manager — émeraude/teal pour différencier ───
    csm: {
      label: 'Customer Success', emoji: '💎',
      grad1: '#042f2e', grad2: '#0f766e', grad3: '#14b8a6',
      accent: '#5eead4', accentLight: '#ccfbf1',
      accentGlow: 'rgba(94,234,212,0.18)',
      roleBg: 'rgba(94,234,212,0.12)', roleBorder: 'rgba(94,234,212,0.25)',
    },
  };

  const ROLE_LABELS = { coach: '🎓 Coach', sales: '📈 Commercial', admin: '👑 Administrateur', csm: '💎 Customer Success' };

  /* ═══ REBRANDING ALTEORE (phase 1 — pilote) ═══════════════════════════
     brand.css redéfinit uniquement les variables CSS (:root) des pages +
     police/scrollbars/focus. Opt-in par page via la liste ci-dessous :
     ajouter un nom de fichier active le rebranding sur cette page, le
     retirer restaure l'apparence d'origine à l'identique. Aucun layout,
     aucune donnée, aucun comportement modifiés. */
  /* Déployé partout SAUF :
       - coaching*.html (exclusion demandée — univers clair conservé)
       - csm-clients.html / csm-dashboard.html (design clair crème par
         construction : basculer en sombre demande un mapping dédié)
       - login.html (écran d'accueil brandé à part) */
  const AL_REBRAND_PAGES = [
    'admin-data-center.html', 'admin-facturation.html', 'admin-invoice-edit.html',
    'admin-numbers.html', 'admin-persons.html', 'admin-users.html',
    'alteoforms.html', 'booking-admin.html', 'clients-dedup.html',
    'csm-diagnostic.html', 'csm-import.html', 'payments.html',
    'sales-clients.html', 'sales-closing.html', 'sales-commissions.html',
    'sales-contact.html', 'sales-crm.html', 'sales-dashboard.html',
    'sales-dialer.html', 'sales-eod.html', 'sales-equipe.html',
    'sales-funnel.html', 'sales-leads.html', 'sales-projections.html',
    'sales-rdv.html', 'sales-retargeting.html', 'sales-saisie.html',
    'sales-setting.html', 'sales-signatures.html', 'sales-suivi-client.html',
  ];
  (function injectBrand() {
    const page = window.location.pathname.split('/').pop() || 'index.html';
    if (AL_REBRAND_PAGES.indexOf(page) < 0) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'brand.css';
    document.head.appendChild(link);
    document.body
      ? document.body.classList.add('al-rebrand')
      : document.addEventListener('DOMContentLoaded', function () { document.body.classList.add('al-rebrand'); });
  })();

  const style = document.createElement('style');
  style.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&display=swap');

    :root { --nav-w: 248px; --nav-w-collapsed: 68px; }

    body.has-sidebar { padding-left: var(--nav-w); transition: padding-left 0.3s cubic-bezier(.4,0,.2,1); }
    body.has-sidebar.sidebar-collapsed { padding-left: var(--nav-w-collapsed); }

    .nav-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:998; backdrop-filter:blur(2px); }
    .nav-overlay.show { display:block; }

    #ambitio-sidebar {
      position:fixed; top:0; left:0; height:100vh; width:var(--nav-w);
      z-index:999; display:flex; flex-direction:column; overflow:hidden;
      transition:width 0.3s cubic-bezier(.4,0,.2,1);
      font-family:'Plus Jakarta Sans',sans-serif;
    }
    #ambitio-sidebar.collapsed { width:var(--nav-w-collapsed); }

    #ambitio-sidebar::before {
      content:''; position:absolute; inset:0;
      background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E");
      opacity:0.4; pointer-events:none; z-index:0;
    }
    #ambitio-sidebar::after {
      content:''; position:absolute; top:-60px; right:-60px;
      width:200px; height:200px; border-radius:50%;
      background:var(--nav-accent-glow,rgba(167,139,250,0.25));
      filter:blur(60px); pointer-events:none; z-index:0;
    }

    .nav-header {
      position:relative; z-index:1; padding:22px 18px 16px;
      display:flex; align-items:center; gap:10px;
      border-bottom:1px solid rgba(255,255,255,0.08); flex-shrink:0;
    }
    .nav-logo {
      width:36px; height:36px; background:rgba(255,255,255,0.15);
      border:1px solid rgba(255,255,255,0.2); border-radius:10px;
      display:flex; align-items:center; justify-content:center;
      font-size:16px; font-weight:800; color:white; flex-shrink:0; backdrop-filter:blur(8px);
    }
    .nav-brand { overflow:hidden; transition:opacity 0.2s,width 0.3s; }
    .nav-brand-title { font-size:15px; font-weight:800; color:white; white-space:nowrap; letter-spacing:-0.3px; }
    .nav-brand-sub { font-size:10px; color:rgba(255,255,255,0.5); font-weight:500; white-space:nowrap; }
    .nav-collapse-btn {
      margin-left:auto; width:28px; height:28px;
      border:1px solid rgba(255,255,255,0.15); border-radius:8px;
      background:rgba(255,255,255,0.08); cursor:pointer;
      display:flex; align-items:center; justify-content:center;
      color:rgba(255,255,255,0.6); font-size:12px; flex-shrink:0; transition:all 0.15s;
    }
    .nav-collapse-btn:hover { background:rgba(255,255,255,0.16); color:white; }

    /* Pill rôle intégrée au header (remplace l'ancien gros bloc rôle) */
    .nav-rolepill {
      display:inline-flex; align-items:center; gap:5px; margin-top:3px;
      padding:2px 8px; border-radius:20px;
      background:var(--nav-role-bg); border:1px solid var(--nav-role-border);
      font-size:10px; font-weight:700; color:var(--nav-accent);
      letter-spacing:0.3px; white-space:nowrap;
    }

    /* ── Sections repliables (accordéons) ── */
    .nav-sec-group { margin-top:6px; }
    .nav-sec-group:first-child { margin-top:0; }
    .nav-sec-head {
      display:flex; align-items:center; gap:7px; padding:7px 8px 7px 10px;
      border-radius:8px; cursor:pointer; user-select:none; transition:background 0.15s;
    }
    .nav-sec-head:hover { background:rgba(255,255,255,0.05); }
    .nav-sec-label {
      font-size:10px; font-weight:800; text-transform:uppercase; letter-spacing:1.3px;
      color:rgba(255,255,255,0.42); white-space:nowrap; overflow:hidden; transition:opacity 0.2s;
    }
    .nav-sec-count {
      font-size:9px; font-weight:700; color:rgba(255,255,255,0.28);
      background:rgba(255,255,255,0.07); padding:1px 6px; border-radius:10px; flex-shrink:0;
    }
    .nav-sec-caret { margin-left:auto; font-size:9px; color:rgba(255,255,255,0.3); transition:transform 0.2s; flex-shrink:0; }
    .nav-sec-group.open .nav-sec-caret { transform:rotate(90deg); }
    .nav-sec-body { display:none; }
    .nav-sec-group.open .nav-sec-body { display:block; animation:navSecReveal 0.18s ease; }
    @keyframes navSecReveal { from { opacity:0; transform:translateY(-3px); } to { opacity:1; transform:none; } }

    .nav-items {
      position:relative; z-index:1; padding:4px 10px; flex:1;
      overflow-y:auto; overflow-x:hidden; scrollbar-width:none;
    }
    .nav-items::-webkit-scrollbar { display:none; }

    .nav-item {
      display:flex; align-items:center; gap:10px; padding:9px 10px;
      border-radius:10px; cursor:pointer; color:rgba(255,255,255,0.6);
      text-decoration:none; font-size:13px; font-weight:600; transition:all 0.15s;
      position:relative; margin-bottom:2px; white-space:nowrap; overflow:hidden;
    }
    .nav-item:hover { background:rgba(255,255,255,0.08); color:rgba(255,255,255,0.9); }
    .nav-item.active { background:var(--nav-accent-glow); color:white; border:1px solid rgba(255,255,255,0.12); }
    .nav-item.active::before {
      content:''; position:absolute; left:0; top:20%; bottom:20%;
      width:3px; background:var(--nav-accent); border-radius:0 3px 3px 0;
    }
    .nav-item-icon { font-size:16px; width:20px; text-align:center; flex-shrink:0; transition:transform 0.15s; }
    .nav-item:hover .nav-item-icon { transform:scale(1.1); }
    .nav-item-label { flex:1; overflow:hidden; text-overflow:ellipsis; transition:opacity 0.2s; }
    .nav-item-badge {
      font-size:10px; font-weight:700; padding:2px 7px; border-radius:20px;
      background:var(--nav-accent-glow); color:var(--nav-accent);
      border:1px solid var(--nav-role-border); flex-shrink:0;
    }
    .nav-item-badge.num { background:var(--nav-accent); color:white; border:none; }

    .nav-parent { cursor:pointer; }
    .nav-parent-caret { font-size:10px; color:rgba(255,255,255,0.35); flex-shrink:0; transition:transform 0.2s; }
    .nav-parent.open .nav-parent-caret { transform:rotate(90deg); }
    .nav-children { display:none; margin-left:19px; padding-left:10px; border-left:1px solid rgba(255,255,255,0.10); }
    .nav-children.open { display:block; }
    .nav-children .nav-item { font-size:12px; padding:7px 10px; opacity:0.85; }
    .nav-children .nav-item.active { opacity:1; }
    #ambitio-sidebar.collapsed .nav-children { display:none !important; }
    #ambitio-sidebar.collapsed .nav-parent-caret { opacity:0; }

    #ambitio-sidebar.collapsed .nav-item-label,
    #ambitio-sidebar.collapsed .nav-item-badge,
    #ambitio-sidebar.collapsed .nav-brand { opacity:0; pointer-events:none; }
    /* Mode réduit : les accordéons n'ont plus de sens (icônes seules + tooltips)
       → en-têtes masqués, tous les items visibles quel que soit l'état plié. */
    #ambitio-sidebar.collapsed .nav-sec-head { display:none; }
    #ambitio-sidebar.collapsed .nav-sec-body { display:block !important; animation:none; }
    #ambitio-sidebar.collapsed .nav-collapse-btn { margin-left:0; }
    #ambitio-sidebar.collapsed .nav-header { justify-content:center; padding:22px 10px 16px; }

    #ambitio-sidebar.collapsed .nav-item:hover::after {
      content:attr(data-label);
      position:absolute; left:calc(var(--nav-w-collapsed) + 8px); top:50%;
      transform:translateY(-50%);
      background:#1a1f36; color:white; font-size:12px; font-weight:600;
      padding:6px 12px; border-radius:8px; white-space:nowrap;
      pointer-events:none; z-index:1000;
      box-shadow:0 4px 16px rgba(0,0,0,0.3); border:1px solid rgba(255,255,255,0.1);
    }

    .nav-footer { position:relative; z-index:1; padding:12px 10px; border-top:1px solid rgba(255,255,255,0.08); flex-shrink:0; }
    .nav-legal { text-align:center; padding:6px 0 2px; font-size:10px; opacity:.25; transition:opacity .2s; }
    .nav-legal:hover { opacity:.5; }
    .nav-legal a { color:inherit; text-decoration:none; }
    .nav-legal a:hover { text-decoration:underline; }
    .sidebar-collapsed .nav-legal { display:none; }
    .nav-profile-btn {
      display:flex; align-items:center; gap:10px; padding:9px 10px; border-radius:10px;
      cursor:pointer; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.1);
      transition:all 0.15s; overflow:hidden; white-space:nowrap;
    }
    .nav-profile-btn:hover { background:rgba(255,255,255,0.1); border-color:rgba(255,255,255,0.18); }
    .nav-avatar {
      width:32px; height:32px; border-radius:9px;
      background:var(--nav-accent-glow); border:1.5px solid var(--nav-role-border);
      display:flex; align-items:center; justify-content:center;
      font-size:13px; font-weight:800; color:white; flex-shrink:0;
    }
    .nav-profile-info { flex:1; overflow:hidden; transition:opacity 0.2s; }
    .nav-profile-name { font-size:12px; font-weight:700; color:white; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .nav-profile-role { font-size:10px; color:rgba(255,255,255,0.4); white-space:nowrap; }
    .nav-profile-caret { font-size:10px; color:rgba(255,255,255,0.4); flex-shrink:0; transition:opacity 0.2s; }
    #ambitio-sidebar.collapsed .nav-profile-info,
    #ambitio-sidebar.collapsed .nav-profile-caret { opacity:0; pointer-events:none; }
    #ambitio-sidebar.collapsed .nav-profile-btn { justify-content:center; padding:9px; }

    .profile-modal-backdrop {
      position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:1100;
      backdrop-filter:blur(4px); display:flex; align-items:center; justify-content:center;
      animation:navFadeIn 0.2s ease;
    }
    @keyframes navFadeIn { from{opacity:0} to{opacity:1} }
    .profile-modal {
      background:#0f0f1a; border:1px solid rgba(255,255,255,0.1); border-radius:20px;
      width:100%; max-width:480px; max-height:85vh; overflow-y:auto;
      box-shadow:0 32px 80px rgba(0,0,0,0.6);
      animation:navSlideUp 0.25s cubic-bezier(.4,0,.2,1); margin:20px;
    }
    @keyframes navSlideUp { from{transform:translateY(20px);opacity:0} to{transform:translateY(0);opacity:1} }
    .pm-header { padding:24px 24px 0; display:flex; align-items:center; justify-content:space-between; }
    .pm-title { font-size:16px; font-weight:800; color:white; font-family:'Plus Jakarta Sans',sans-serif; }
    .pm-close {
      width:32px; height:32px; border:1px solid rgba(255,255,255,0.12); border-radius:8px;
      background:rgba(255,255,255,0.06); cursor:pointer; color:rgba(255,255,255,0.5);
      font-size:14px; display:flex; align-items:center; justify-content:center; transition:all 0.15s;
    }
    .pm-close:hover { background:rgba(255,255,255,0.12); color:white; }
    .pm-avatar-section { padding:20px 24px; display:flex; align-items:center; gap:16px; border-bottom:1px solid rgba(255,255,255,0.06); }
    .pm-avatar-big {
      width:64px; height:64px; border-radius:16px;
      background:var(--nav-accent-glow); border:2px solid var(--nav-role-border);
      display:flex; align-items:center; justify-content:center;
      font-size:26px; font-weight:800; color:white; flex-shrink:0;
    }
    .pm-avatar-info { flex:1; }
    .pm-avatar-name { font-size:18px; font-weight:800; color:white; }
    .pm-avatar-role {
      display:inline-flex; align-items:center; gap:5px; padding:3px 10px; border-radius:20px;
      font-size:11px; font-weight:700; margin-top:4px;
      background:var(--nav-role-bg); border:1px solid var(--nav-role-border); color:var(--nav-accent);
    }
    .pm-body { padding:20px 24px 24px; }
    .pm-section-title {
      font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.8px;
      color:rgba(255,255,255,0.3); margin-bottom:12px; margin-top:20px;
    }
    .pm-section-title:first-child { margin-top:0; }
    .pm-field { margin-bottom:12px; }
    .pm-field label { display:block; font-size:11px; font-weight:700; color:rgba(255,255,255,0.4); text-transform:uppercase; letter-spacing:0.6px; margin-bottom:5px; }
    .pm-field input, .pm-field select, .pm-field textarea {
      width:100%; padding:10px 14px; background:rgba(255,255,255,0.05);
      border:1.5px solid rgba(255,255,255,0.08); border-radius:10px; color:white;
      font-family:'Plus Jakarta Sans',sans-serif; font-size:13px; font-weight:500;
      outline:none; transition:border-color 0.15s,background 0.15s; resize:none;
    }
    .pm-field input::placeholder, .pm-field textarea::placeholder { color:rgba(255,255,255,0.2); }
    .pm-field input:focus, .pm-field select:focus, .pm-field textarea:focus { border-color:var(--nav-accent); background:var(--nav-accent-glow); }
    .pm-field select option { background:#1a1a2e; }
    .pm-row { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    .pm-actions { display:flex; gap:10px; margin-top:20px; padding-top:16px; border-top:1px solid rgba(255,255,255,0.06); }
    .pm-btn { flex:1; padding:11px; border:none; border-radius:10px; font-family:'Plus Jakarta Sans',sans-serif; font-size:13px; font-weight:700; cursor:pointer; transition:all 0.15s; }
    .pm-btn-primary { background:var(--nav-accent); color:#0f0f1a; }
    .pm-btn-primary:hover { opacity:0.9; transform:translateY(-1px); }
    .pm-btn-ghost { background:rgba(255,255,255,0.06); color:rgba(255,255,255,0.6); border:1px solid rgba(255,255,255,0.1); }
    .pm-btn-ghost:hover { background:rgba(255,255,255,0.1); color:white; }
    .pm-logout-btn {
      width:100%; padding:10px; margin-top:8px;
      background:rgba(239,68,68,0.08); border:1px solid rgba(239,68,68,0.2);
      border-radius:10px; color:#fca5a5;
      font-family:'Plus Jakarta Sans',sans-serif; font-size:13px; font-weight:600;
      cursor:pointer; transition:all 0.15s;
    }
    .pm-logout-btn:hover { background:rgba(239,68,68,0.14); }
    .pm-save-toast {
      position:fixed; bottom:24px; left:50%;
      transform:translateX(-50%) translateY(20px);
      background:#1a2e1a; border:1px solid rgba(16,185,129,0.3); color:#6ee7b7;
      font-size:13px; font-weight:600; padding:10px 20px; border-radius:10px;
      z-index:2000; opacity:0; transition:all 0.3s; white-space:nowrap;
    }
    .pm-save-toast.show { opacity:1; transform:translateX(-50%) translateY(0); }

    /* ── Platform Switch slim (admin → sales.alteore.com, footer) ── */
    .nav-ps-slim {
      display:flex; align-items:center; gap:8px; padding:7px 10px; margin-bottom:6px;
      border-radius:9px; cursor:pointer; text-decoration:none;
      font-size:11.5px; font-weight:600; color:rgba(255,255,255,0.55);
      border:1px dashed rgba(255,255,255,0.14); transition:all 0.15s;
      overflow:hidden; white-space:nowrap; position:relative;
    }
    .nav-ps-slim:hover { color:#fca5a5; border-color:rgba(252,165,165,0.4); background:rgba(252,165,165,0.06); }
    .nav-ps-slim-label { flex:1; overflow:hidden; transition:opacity 0.2s; }
    .nav-ps-slim-arrow { font-size:11px; flex-shrink:0; transition:transform 0.15s, opacity 0.2s; }
    .nav-ps-slim:hover .nav-ps-slim-arrow { transform:translate(1px,-1px); }
    #ambitio-sidebar.collapsed .nav-ps-slim { justify-content:center; padding:7px 0; }
    #ambitio-sidebar.collapsed .nav-ps-slim-label,
    #ambitio-sidebar.collapsed .nav-ps-slim-arrow { opacity:0; width:0; pointer-events:none; }
    #ambitio-sidebar.collapsed .nav-ps-slim:hover::after {
      content:attr(data-label);
      position:absolute; left:calc(var(--nav-w-collapsed) + 8px); top:50%;
      transform:translateY(-50%);
      background:#1a1f36; color:white; font-size:12px; font-weight:600;
      padding:6px 12px; border-radius:8px; white-space:nowrap;
      pointer-events:none; z-index:1000;
      box-shadow:0 4px 16px rgba(0,0,0,0.3); border:1px solid rgba(255,255,255,0.1);
    }

    @media (max-width:768px) {
      body.has-sidebar { padding-left:0 !important; }
      #ambitio-sidebar { transform:translateX(-100%); transition:transform 0.3s cubic-bezier(.4,0,.2,1),width 0.3s; }
      #ambitio-sidebar.mobile-open { transform:translateX(0); }
      .nav-mobile-toggle { display:flex !important; }
    }
    .nav-mobile-toggle {
      display:none; position:fixed; top:14px; left:14px; z-index:997;
      width:40px; height:40px; background:#1a1a2e;
      border:1px solid rgba(255,255,255,0.1); border-radius:10px;
      align-items:center; justify-content:center; cursor:pointer; font-size:16px; color:white;
    }

    /* ── Theme Toggle ── */
    .nav-theme-toggle {
      display:flex; align-items:center; gap:8px; padding:8px 10px; margin:0 10px 6px;
      border-radius:10px; cursor:pointer; background:rgba(255,255,255,0.06);
      border:1px solid rgba(255,255,255,0.1); transition:all 0.15s;
    }
    .nav-theme-toggle:hover { background:rgba(255,255,255,0.1); }
    .nav-theme-switch {
      width:36px; height:20px; border-radius:10px; background:rgba(255,255,255,0.15);
      position:relative; transition:background 0.2s; flex-shrink:0;
    }
    .nav-theme-switch::after {
      content:''; position:absolute; top:2px; left:2px; width:16px; height:16px;
      border-radius:50%; background:white; transition:transform 0.2s;
    }
    .nav-theme-toggle.light .nav-theme-switch { background:rgba(245,158,11,0.5); }
    .nav-theme-toggle.light .nav-theme-switch::after { transform:translateX(16px); }
    .nav-theme-label { font-size:11px; font-weight:600; color:rgba(255,255,255,0.5); transition:opacity 0.2s; }
    #ambitio-sidebar.collapsed .nav-theme-label { opacity:0; pointer-events:none; }
    #ambitio-sidebar.collapsed .nav-theme-toggle { justify-content:center; padding:8px; }

    /* ── LIGHT THEME ── */
    body.light-theme {
      --bg: #f5f5f7;
      --bg2: #ffffff;
      --bg3: #f0f0f3;
      --bg4: #e8e8ed;
      --border: rgba(0,0,0,0.08);
      --border2: rgba(0,0,0,0.14);
      --text: rgba(0,0,0,0.88);
      --muted: rgba(0,0,0,0.45);
      --muted2: rgba(0,0,0,0.2);
    }
    body.light-theme .topbar,
    body.light-theme .fiche-top,
    body.light-theme .ld-header,
    body.light-theme .crm-header { background:rgba(255,255,255,0.95); }
    body.light-theme .eod-textarea,
    body.light-theme .eod-panel,
    body.light-theme .crm-card,
    body.light-theme .crm-col-head,
    body.light-theme .ld-card,
    body.light-theme .ct-card,
    body.light-theme .fl-desc,
    body.light-theme .note-item,
    body.light-theme .act-item,
    body.light-theme .file-item { background:var(--bg2); }
    body.light-theme .mindset-slider { background:var(--bg4); }
    body.light-theme input, body.light-theme select, body.light-theme textarea { color:var(--text); }
    body.light-theme .fl-editable,
    body.light-theme .qv-field-input,
    body.light-theme .crm-modal-input,
    body.light-theme .ct-input { background:var(--bg3); color:var(--text); }
    body.light-theme .crm-board { background:var(--bg); }
    body.light-theme .crm-col { border-color:var(--border); }
  `;
  document.head.appendChild(style);

  function getRole() { return window._currentRole || localStorage.getItem('ambitio_role') || 'coach'; }
  function getUserModules() {
    var role = getRole();
    var defaults = ROLE_DEFAULTS[role] || ROLE_DEFAULTS.coach;
    var stored = localStorage.getItem('ambitio_modules');
    if (stored) {
      try {
        var parsed = JSON.parse(stored);
        // ─── Forward compat ───
        // Quand on ajoute de nouvelles perm keys (ex: csm_dashboard ajouté
        // après que les comptes existants ont déjà un snapshot `modules` figé),
        // on hérite automatiquement de la valeur par défaut du rôle pour les
        // clés absentes du snapshot. Évite que les nouveaux modules soient
        // invisibles tant que l'admin n'a pas re-sauvegardé chaque utilisateur.
        Object.keys(defaults).forEach(function(k){
          if (!(k in parsed)) parsed[k] = defaults[k];
        });
        return parsed;
      } catch(e) {}
    }
    return defaults;
  }
  function getUserInfo() {
    const name = window._currentUserName || localStorage.getItem('ambitio_name') || 'Utilisateur';
    return { name, email: window._currentUserEmail || localStorage.getItem('ambitio_email') || '', initials: name.slice(0,1).toUpperCase() };
  }
  function getActivePage() {
    return { path: window.location.pathname.split('/').pop() || 'index.html' };
  }

  function buildSidebar() {
    const role    = getRole();
    const theme   = THEMES[role]  || THEMES.coach;
    const perms   = getUserModules();
    const modules = ALL_MODULES.filter(m => {
      if (m.perm === '_admin') return role === 'admin';
      // "Rendez-vous" (sales-rdv.html) : liste des RDV pris par les clients
      // — module STRICTEMENT commercial.
      //  - coach : masqué (pas concerné par le suivi des RDV)
      //  - csm   : masqué — la CSM voit les RDV depuis booking-admin.html
      //            (vue globale équipe) et n'a rien à faire dans le module
      //            "Mes RDV" qui est l'agenda perso d'un commercial.
      //  - sales/admin : selon la permission 'booking'
      if (m.id === 'sales-rdv') {
        if (role === 'coach' || role === 'csm') return false;
        var pRdv = perms.booking;
        return pRdv && pRdv !== 'none';
      }
      // "Booking" (booking-admin.html) : vue admin globale de l'agenda équipe
      // (tous les RDV de tous les experts + consultations + experts + pages
      // + réglages). La CSM y a accès en lecture seule pour gérer les RDV
      // côté Customer Success (voir les RDV des clients/coachs, annuler ou
      // replanifier à la demande d'un client). Le mode lecture seule est
      // géré dans booking-admin.html côté UI (gating des écritures) et côté
      // Firestore rules (booking_config en read:true, update:admin only).
      if (m.id === 'booking' && role === 'csm') return true;
      if (m.perm === 'alteoforms') {
        if (role === 'admin') return true;
        try { var af=JSON.parse(localStorage.getItem('ambitio_alteoforms_forms')||'[]'); return af.length>0; } catch(e){ return false; }
      }
      if (m.perm === 'payments') {
        // Admin a accès d'office. TOUS les autres rôles (sales, csm, coach)
        // passent par un flag explicite sur users/{uid} — « Accès au module
        // Paiements » (paymentsAccess) OU « 🚀 Déclenchement des
        // prélèvements » (paymentsTrigger) — synchronisé dans localStorage
        // par initAlteoFormsAccessWatch().
        if (role === 'admin') return true;
        return localStorage.getItem('ambitio_payments_access') === '1';
      }
      if (m.perm === 'signatures') {
        // Admin et CSM ont accès signatures par défaut.
        // Pour les autres rôles (sales) : flag explicite via localStorage.
        if (role === 'admin' || role === 'csm') return true;
        return localStorage.getItem('ambitio_signatures_access') === '1';
      }
      var p = perms[m.perm];
      return p && p !== 'none';
    });
    const user    = getUserInfo();
    const { path } = getActivePage();

    document.documentElement.style.setProperty('--nav-accent',      theme.accent);
    document.documentElement.style.setProperty('--nav-accent-glow', theme.accentGlow);
    document.documentElement.style.setProperty('--nav-role-bg',     theme.roleBg);
    document.documentElement.style.setProperty('--nav-role-border', theme.roleBorder);

    const isCollapsed = localStorage.getItem('nav_collapsed') === '1';
    const isLight = localStorage.getItem('ambitio_theme') === 'light';
    if (isLight) document.body.classList.add('light-theme');

    const sidebar = document.createElement('div');
    sidebar.id = 'ambitio-sidebar';
    sidebar.style.background = `linear-gradient(180deg,${theme.grad1} 0%,${theme.grad2} 50%,${theme.grad3} 100%)`;
    if (isCollapsed) sidebar.classList.add('collapsed');

    /* ─── Sections repliables ───────────────────────────────────────────
       Les modules sont regroupés par section et rendus en accordéons :
         - la section contenant la page active est TOUJOURS ouverte ;
         - les autres suivent l'état mémorisé par l'utilisateur dans
           localStorage ('nav_sections_open'), fermées par défaut ;
         - un rôle qui ne voit qu'une seule section (ex : coach) a une
           liste directe, sans en-tête repliable ;
         - en mode réduit, les en-têtes disparaissent et tous les items
           restent accessibles en icônes + tooltips (géré en CSS).       */
    let secState = {};
    try { secState = JSON.parse(localStorage.getItem('nav_sections_open') || '{}') || {}; } catch (e) { secState = {}; }

    const groups = [];
    modules.forEach(m => {
      const secName = m.section || 'Autres';
      let g = groups.find(x => x.name === secName);
      if (!g) { g = { name: secName, items: [] }; groups.push(g); }
      g.items.push(m);
    });

    const renderModule = m => {
      if (m.children) {
        const childActive = m.children.some(c => path === c.href.split('#')[0]);
        let h = `<div class="nav-item nav-parent${childActive?' open':''}" data-id="${m.id}" data-label="${m.label}">
          <span class="nav-item-icon">${m.icon}</span>
          <span class="nav-item-label">${m.label}</span>
          <span class="nav-parent-caret">▸</span>
        </div>`;
        h += `<div class="nav-children${childActive?' open':''}" data-parent="${m.id}">`;
        m.children.forEach(c => {
          const cActive = path === c.href.split('#')[0];
          h += `<a class="nav-item${cActive?' active':''}" href="${c.href}" data-id="${c.id}" data-label="${c.label}">
            <span class="nav-item-icon">${c.icon}</span>
            <span class="nav-item-label">${c.label}</span>
          </a>`;
        });
        h += `</div>`;
        return h;
      }
      const isActive   = path === m.href.split('#')[0];
      const badgeClass = m.badge && /^\d+$/.test(m.badge) ? 'nav-item-badge num' : 'nav-item-badge';
      return `<a class="nav-item${isActive?' active':''}" href="${m.href}" data-id="${m.id}" data-label="${m.label}">
        <span class="nav-item-icon">${m.icon}</span>
        <span class="nav-item-label">${m.label}</span>
        ${m.badge?`<span class="${badgeClass}">${m.badge}</span>`:''}
      </a>`;
    };

    const moduleHasActive = m => m.children
      ? m.children.some(c => path === c.href.split('#')[0])
      : path === m.href.split('#')[0];

    let navHtml = '';
    if (groups.length <= 1) {
      // Une seule section visible : liste directe, pas d'accordéon.
      (groups[0] ? groups[0].items : []).forEach(m => { navHtml += renderModule(m); });
    } else {
      groups.forEach(g => {
        const slug = g.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const hasActive = g.items.some(moduleHasActive);
        const isOpen = hasActive || secState[slug] === true;
        navHtml += `<div class="nav-sec-group${isOpen?' open':''}" data-sec="${slug}">
          <div class="nav-sec-head">
            <span class="nav-sec-label">${g.name}</span>
            <span class="nav-sec-count">${g.items.length}</span>
            <span class="nav-sec-caret">▸</span>
          </div>
          <div class="nav-sec-body">`;
        g.items.forEach(m => { navHtml += renderModule(m); });
        navHtml += `</div></div>`;
      });
    }

    sidebar.innerHTML = `
      <div class="nav-header">
        <div class="nav-logo">A</div>
        <div class="nav-brand">
          <div class="nav-brand-title">Ambitio <span style="opacity:.6">Corp</span></div>
          <div class="nav-rolepill">${ROLE_LABELS[role]||role}</div>
        </div>
        <button class="nav-collapse-btn" id="navCollapseBtn" title="Réduire">◀</button>
      </div>
      <div class="nav-items" id="navItems">${navHtml}</div>
      <div class="nav-footer">
        ${role === 'admin' ? `
        <a class="nav-ps-slim" href="https://sales.alteore.com" target="_blank" rel="noopener noreferrer" data-label="Espace Sales" title="Ouvrir sales.alteore.com dans un nouvel onglet">
          <span>📈</span>
          <span class="nav-ps-slim-label">Espace Sales</span>
          <span class="nav-ps-slim-arrow">↗</span>
        </a>
        ` : ''}
        <div class="nav-theme-toggle${isLight ? ' light' : ''}" id="navThemeToggle" title="Thème clair / sombre">
          <div class="nav-theme-switch"></div>
          <span class="nav-theme-label">${isLight ? '☀️ Clair' : '🌙 Sombre'}</span>
        </div>
        <div class="nav-profile-btn" id="navProfileBtn">
          <div class="nav-avatar">${user.initials}</div>
          <div class="nav-profile-info">
            <div class="nav-profile-name">${user.name}</div>
            <div class="nav-profile-role">${user.email}</div>
          </div>
          <span class="nav-profile-caret">⚙</span>
        </div>
        <div class="nav-legal"><a href="/privacy.html" target="_blank">Confidentialité</a> · <a href="/terms.html" target="_blank">Conditions</a></div>
      </div>`;

    document.body.appendChild(sidebar);
    document.body.classList.add('has-sidebar');
    if (isCollapsed) document.body.classList.add('sidebar-collapsed');

    const mobileToggle = document.createElement('button');
    mobileToggle.className = 'nav-mobile-toggle';
    mobileToggle.innerHTML = '☰';
    document.body.appendChild(mobileToggle);

    const overlay = document.createElement('div');
    overlay.className = 'nav-overlay';
    document.body.appendChild(overlay);

    mobileToggle.addEventListener('click', () => { sidebar.classList.toggle('mobile-open'); overlay.classList.toggle('show'); });
    overlay.addEventListener('click', () => { sidebar.classList.remove('mobile-open'); overlay.classList.remove('show'); });

    const collapseBtn = document.getElementById('navCollapseBtn');
    if (isCollapsed) collapseBtn.innerHTML = '▶';
    collapseBtn.addEventListener('click', () => {
      const c = sidebar.classList.toggle('collapsed');
      document.body.classList.toggle('sidebar-collapsed', c);
      collapseBtn.innerHTML = c ? '▶' : '◀';
      localStorage.setItem('nav_collapsed', c ? '1' : '0');
    });

    document.getElementById('navProfileBtn').addEventListener('click', openProfileModal);

    // Toggle sections repliables — état mémorisé par section (localStorage).
    // NB : la section de la page active est ré-ouverte de force au prochain
    // rendu même si l'utilisateur l'a fermée (voir génération navHtml).
    sidebar.querySelectorAll('.nav-sec-head').forEach(head => {
      head.addEventListener('click', () => {
        const grp = head.parentElement;
        const open = grp.classList.toggle('open');
        try {
          const st = JSON.parse(localStorage.getItem('nav_sections_open') || '{}') || {};
          st[grp.dataset.sec] = open;
          localStorage.setItem('nav_sections_open', JSON.stringify(st));
        } catch (e) {}
      });
    });

    // Toggle sub-nav parents
    sidebar.querySelectorAll('.nav-parent').forEach(parent => {
      parent.addEventListener('click', () => {
        const id = parent.dataset.id;
        const children = sidebar.querySelector('[data-parent="' + id + '"]');
        if (children) {
          parent.classList.toggle('open');
          children.classList.toggle('open');
        }
      });
    });

    // Theme toggle
    document.getElementById('navThemeToggle').addEventListener('click', () => {
      const isNowLight = document.body.classList.toggle('light-theme');
      localStorage.setItem('ambitio_theme', isNowLight ? 'light' : 'dark');
      const toggle = document.getElementById('navThemeToggle');
      toggle.classList.toggle('light', isNowLight);
      toggle.querySelector('.nav-theme-label').innerHTML = isNowLight ? '☀️ Clair' : '🌙 Sombre';
    });
  }

  function openProfileModal() {
    const role  = getRole();
    const theme = THEMES[role] || THEMES.coach;
    const user  = getUserInfo();
    // Parse défensif : localStorage peut contenir une valeur corrompue
    // (vieille version, conflit multi-tab, bug navigateur). On tolère et
    // repart sur un objet vide plutôt que de crash l'ouverture du modal.
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem('ambitio_profile') || '{}') || {};
    } catch (_) { saved = {}; }

    const backdrop = document.createElement('div');
    backdrop.className = 'profile-modal-backdrop';
    backdrop.style.setProperty('--nav-accent',      theme.accent);
    backdrop.style.setProperty('--nav-accent-glow', theme.accentGlow);
    backdrop.style.setProperty('--nav-role-bg',     theme.roleBg);
    backdrop.style.setProperty('--nav-role-border', theme.roleBorder);

    const opt = (val, s) => `<option value="${val}" ${saved.dept===val?'selected':''}>${s}</option>`;

    backdrop.innerHTML = `
      <div class="profile-modal">
        <div class="pm-header">
          <div class="pm-title">Mon profil</div>
          <button class="pm-close" id="pmClose">✕</button>
        </div>
        <div class="pm-avatar-section">
          <div class="pm-avatar-big">${user.initials}</div>
          <div class="pm-avatar-info">
            <div class="pm-avatar-name">${user.name}</div>
            <div class="pm-avatar-role">${ROLE_LABELS[role]||role}</div>
          </div>
        </div>
        <div class="pm-body">
          <div class="pm-section-title">Informations personnelles</div>
          <div class="pm-row">
            <div class="pm-field"><label>Prénom</label><input type="text" id="pmFirstname" value="${saved.firstname||''}" placeholder="Prénom"/></div>
            <div class="pm-field"><label>Nom</label><input type="text" id="pmLastname" value="${saved.lastname||''}" placeholder="Nom"/></div>
          </div>
          <div class="pm-field"><label>Email professionnel</label><input type="email" id="pmEmail" value="${saved.email||user.email}" placeholder="prenom@ambitiocorp.com"/></div>
          <div class="pm-field"><label>Téléphone</label><input type="tel" id="pmPhone" value="${saved.phone||''}" placeholder="+33 6 00 00 00 00"/></div>
          <div class="pm-section-title">Poste & équipe</div>
          <div class="pm-row">
            <div class="pm-field"><label>Titre</label><input type="text" id="pmTitle" value="${saved.title||''}" placeholder="Coach senior / BDR..."/></div>
            <div class="pm-field"><label>Département</label>
              <select id="pmDept">
                <option value="">Choisir...</option>
                ${opt('coaching','Coaching')}${opt('sales','Sales')}${opt('ops','Ops')}${opt('marketing','Marketing')}
              </select>
            </div>
          </div>
          <div class="pm-field"><label>LinkedIn</label><input type="url" id="pmLinkedin" value="${saved.linkedin||''}" placeholder="https://linkedin.com/in/..."/></div>
          <div class="pm-section-title">Préférences</div>
          <div class="pm-field"><label>Bio courte</label><textarea id="pmBio" rows="3" placeholder="Quelques mots sur toi...">${saved.bio||''}</textarea></div>
          <div class="pm-row">
            <div class="pm-field"><label>Langue</label>
              <select id="pmLang">
                <option value="fr" ${saved.lang!=='en'?'selected':''}>Français</option>
                <option value="en" ${saved.lang==='en'?'selected':''}>English</option>
              </select>
            </div>
            <div class="pm-field"><label>Fuseau horaire</label>
              <select id="pmTz">
                <option value="europe_paris" ${saved.tz!=='utc'?'selected':''}>Europe/Paris</option>
                <option value="utc" ${saved.tz==='utc'?'selected':''}>UTC</option>
                <option value="america_ny">America/New_York</option>
              </select>
            </div>
          </div>
          <div class="pm-actions">
            <button class="pm-btn pm-btn-ghost" id="pmCancel">Annuler</button>
            <button class="pm-btn pm-btn-primary" id="pmSave">💾 Sauvegarder</button>
          </div>
          <button class="pm-logout-btn" id="pmLogout">→ Se déconnecter</button>
        </div>
      </div>
      <div class="pm-save-toast" id="pmToast">✅ Profil sauvegardé !</div>`;

    document.body.appendChild(backdrop);

    const close = () => backdrop.remove();
    document.getElementById('pmClose').addEventListener('click', close);
    document.getElementById('pmCancel').addEventListener('click', close);
    backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });

    document.getElementById('pmSave').addEventListener('click', () => {
      const p = {};
      ['Firstname','Lastname','Email','Phone','Title','Dept','Linkedin','Bio','Lang','Tz'].forEach(k => {
        p[k.toLowerCase()] = document.getElementById('pm'+k).value;
      });
      localStorage.setItem('ambitio_profile', JSON.stringify(p));
      const toast = document.getElementById('pmToast');
      toast.classList.add('show');
      setTimeout(() => { toast.classList.remove('show'); setTimeout(close, 300); }, 1800);
    });

    document.getElementById('pmLogout').addEventListener('click', async () => {
      if (window._signOut && window._auth) await window._signOut(window._auth);
      ['ambitio_role','ambitio_name','ambitio_email','ambitio_modules'].forEach(k => localStorage.removeItem(k));
      window.location.href = 'login.html';
    });
  }

  function init() {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildSidebar);
    else buildSidebar();
  }

  window.AmbitioNav = {
    setAlteoFormsAccess(formIds) {
      if (formIds && formIds.length > 0) {
        localStorage.setItem('ambitio_alteoforms_forms', JSON.stringify(formIds));
      } else {
        localStorage.removeItem('ambitio_alteoforms_forms');
      }
      buildSidebar();
    },

    setRole(role, name, email, modules) {
      localStorage.setItem('ambitio_role', role);
      if (name)  localStorage.setItem('ambitio_name', name);
      if (email) localStorage.setItem('ambitio_email', email);
      if (modules) localStorage.setItem('ambitio_modules', JSON.stringify(modules));
      else localStorage.removeItem('ambitio_modules');
      window._currentRole = role; window._currentUserName = name; window._currentUserEmail = email;
    },
    PERM_KEYS, ROLE_DEFAULTS, PERM_LABELS,
    getUserModules,
    rebuild() {
      document.getElementById('ambitio-sidebar')?.remove();
      document.querySelectorAll('.nav-mobile-toggle,.nav-overlay').forEach(e => e.remove());
      document.body.classList.remove('has-sidebar','sidebar-collapsed');
      buildSidebar();
    },
    openProfile: openProfileModal,
  };

  init();
})();

/* ═══════════════════════════════════════════════════════════════════════
   TEAM MEMBERS — Source unique de vérité pour l'équipe sales
   ───────────────────────────────────────────────────────────────────────
   Lit le doc _meta/team_members et expose :
     • window.TEAM_MEMBERS         → { slug: memberObj }
     • window.TEAM_MEMBERS_LIST    → array trié par order
     • window.TEAM_MEMBERS_ACTIVE  → array trié, actifs uniquement

   Utilisation depuis n'importe quelle page :
     await window.loadTeamMembers();
     const guillaume = window.TEAM_MEMBERS.guillaume;
     for (const m of window.TEAM_MEMBERS_ACTIVE) { ... }

   Expose aussi un événement 'team-members-loaded' pour les pages qui
   doivent re-rendre après le chargement.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  window.TEAM_MEMBERS = {};
  window.TEAM_MEMBERS_LIST = [];
  window.TEAM_MEMBERS_ACTIVE = [];
  window._teamMembersLoadPromise = null;
  window._teamMembersLastLoadAt = 0;

  /**
   * Charge (ou recharge) la liste des membres équipe depuis Firestore.
   * Cache 5 min sauf si force=true.
   * @param {boolean} force - bypass le cache
   * @returns {Promise<Array>} - liste triée des membres
   */
  window.loadTeamMembers = async function (force) {
    const now = Date.now();
    const CACHE_MS = 5 * 60 * 1000; // 5 minutes
    if (!force && window._teamMembersLoadPromise && (now - window._teamMembersLastLoadAt) < CACHE_MS) {
      return window._teamMembersLoadPromise;
    }
    // Détection du SDK Firebase utilisé par la page :
    //   - "compat" : sales-* et certaines pages admin (v9.23 compat) →
    //     firebase.firestore() global est dispo.
    //   - "modular" : coaching-*, admin-users/persons, csm-*, login.html (v10) →
    //     les pages exposent window._db, window._doc, window._getDoc, etc.
    var sdkMode = null;
    if (typeof firebase !== 'undefined' && firebase.firestore) {
      sdkMode = 'compat';
    } else if (window._db && window._getDoc && window._doc) {
      sdkMode = 'modular';
    } else {
      console.warn('[loadTeamMembers] Aucun SDK Firebase détecté (ni compat global, ni modular via window._db).');
      return null;
    }
    window._teamMembersLastLoadAt = now;
    window._teamMembersLoadPromise = (async () => {
      var dispatched = false;
      var fireEvent = function (count, ok, error) {
        if (dispatched) return;
        dispatched = true;
        window.dispatchEvent(new CustomEvent('team-members-loaded', {
          detail: { count: count || 0, activeCount: (window.TEAM_MEMBERS_ACTIVE || []).length, ok: !!ok, error: error || null, sdk: sdkMode }
        }));
      };
      try {
        var snap;
        if (sdkMode === 'compat') {
          const db = firebase.firestore();
          snap = await db.collection('_meta').doc('team_members').get();
        } else {
          // modular : snap.exists est une METHODE (pas une propriété comme en compat)
          snap = await window._getDoc(window._doc(window._db, '_meta', 'team_members'));
        }
        // Compat : snap.exists (boolean). Modular : snap.exists() (function).
        var docExists = (typeof snap.exists === 'function') ? snap.exists() : snap.exists;
        if (!docExists) {
          console.warn('[loadTeamMembers] Doc _meta/team_members introuvable. Lance migrate-team-members.js.');
          window.TEAM_MEMBERS = {};
          window.TEAM_MEMBERS_LIST = [];
          window.TEAM_MEMBERS_ACTIVE = [];
          fireEvent(0, false, 'doc-not-found');
          return [];
        }
        const data = snap.data() || {};
        const rawMembers = data.members;
        const map = {};
        const list = [];

        // Le champ `members` peut être stocké soit comme un OBJET (map slug→memberObj),
        // soit comme un ARRAY (Firestore le convertit parfois automatiquement, surtout
        // si les valeurs sont écrites via certains SDK ou si on a fait set() avec un array).
        // On gère les 2 cas en se basant TOUJOURS sur le champ `slug` interne de chaque
        // membre, qui doit être présent dans tous les cas.
        if (Array.isArray(rawMembers)) {
          // Cas ARRAY : on itère et on prend le slug interne de chaque entrée
          for (let i = 0; i < rawMembers.length; i++) {
            const entry = rawMembers[i];
            if (!entry || typeof entry !== 'object') continue;
            const slug = entry.slug || ('m' + i);
            const m = Object.assign({ slug: slug }, entry);
            map[slug] = m;
            list.push(m);
          }
        } else if (rawMembers && typeof rawMembers === 'object') {
          // Cas OBJET : itération classique sur les clés
          Object.keys(rawMembers).forEach(function (slug) {
            const entry = rawMembers[slug];
            if (!entry || typeof entry !== 'object') return;
            // Si l'entry contient déjà un slug interne, on le préfère à la clé externe
            // (au cas où la clé externe soit numérique parce que Firestore a array-ified)
            const realSlug = entry.slug || slug;
            const m = Object.assign({ slug: realSlug }, entry);
            map[realSlug] = m;
            list.push(m);
          });
        } else {
          console.warn('[loadTeamMembers] Champ `members` absent ou format invalide:', rawMembers);
        }

        list.sort(function (a, b) { return (a.order || 999) - (b.order || 999); });
        window.TEAM_MEMBERS = map;
        window.TEAM_MEMBERS_LIST = list;
        window.TEAM_MEMBERS_ACTIVE = list.filter(function (m) { return m.active !== false; });
        fireEvent(list.length, true);
        return list;
      } catch (e) {
        console.error('[loadTeamMembers] erreur', e);
        // Init structures vides pour que les helpers downstream fonctionnent
        if (!window.TEAM_MEMBERS) window.TEAM_MEMBERS = {};
        if (!window.TEAM_MEMBERS_LIST) window.TEAM_MEMBERS_LIST = [];
        if (!window.TEAM_MEMBERS_ACTIVE) window.TEAM_MEMBERS_ACTIVE = [];
        // CRITIQUE : fire l'event MÊME en cas d'erreur, sinon les pages
        // qui attendent team-members-loaded restent bloquées à vie sans
        // jamais déclencher leur logique de fallback. La présence de
        // detail.ok === false leur permet de réagir spécifiquement.
        fireEvent(0, false, e && e.message ? e.message : String(e));
        return [];
      }
    })();
    return window._teamMembersLoadPromise;
  };

  /**
   * Helper synchrone : retourne un membre par slug, ou un fallback "inconnu".
   * Si le membre n'existe pas, retourne un objet placeholder pour éviter les
   * crashes côté UI quand on affiche un assignedTo dont le membre a été
   * complètement supprimé (cas exceptionnel).
   */
  window.getTeamMember = function (slug) {
    if (!slug) return null;
    if (window.TEAM_MEMBERS[slug]) return window.TEAM_MEMBERS[slug];
    return {
      slug: slug,
      shortName: slug,
      displayName: slug,
      initials: (slug[0] || '?').toUpperCase(),
      color: '#6b7280',
      active: false,
      _missing: true
    };
  };

  /**
   * Retourne les options "coach" pour les dropdowns coaching.
   *
   * Source de vérité : _meta/team_members via window.TEAM_MEMBERS_ACTIVE.
   * Inclut tous les membres actifs dont le rôle est `coach` OU `admin`
   * (les admins comme Adrien/Emily restent éligibles comme coach par
   * design — alignement avec l'état historique).
   *
   * Tri par `order` (déjà appliqué sur TEAM_MEMBERS_ACTIVE par
   * loadTeamMembers).
   *
   * Format de retour : array d'objets normalisés
   *   [{ slug, label, color, shortName, displayName, role }, ...]
   *
   * Utilisation typique :
   *   var coaches = window.getCoachOptions();
   *   coaches.forEach(function(c){
   *     h += '<option value="'+c.slug+'">'+c.label+'</option>';
   *   });
   *
   * Si TEAM_MEMBERS n'est pas encore chargé (premier render avant
   * onAuthStateChanged), retourne un array vide. Les pages doivent
   * écouter l'event `team-members-loaded` pour re-render.
   */
  // Fallback hardcoded — équipe coaching connue au 12 mai 2026.
  // Sert de filet de sécurité si TEAM_MEMBERS n'a pas pu être chargé
  // (race au premier paint, rules Firestore pas encore propagées,
  // erreur réseau transitoire, etc.). Permet aux dropdowns de ne JAMAIS
  // être vides en production. Lorsque le dynamique fonctionne, c'est
  // toujours lui qui prime.
  var _COACH_FALLBACK = [
    { slug: 'thomas',  label: 'Thomas',  color: '#3b82f6', shortName: 'Thomas',  displayName: 'Thomas',  role: 'coach' },
    { slug: 'edouard', label: 'Edouard', color: '#10b981', shortName: 'Edouard', displayName: 'Edouard', role: 'coach' },
    { slug: 'flore',   label: 'Flore',   color: '#a855f7', shortName: 'Flore',   displayName: 'Flore',   role: 'coach' },
    { slug: 'emily',   label: 'Emily',   color: '#f59e0b', shortName: 'Emily',   displayName: 'Emily',   role: 'admin' },
    { slug: 'adrien',  label: 'Adrien',  color: '#6366f1', shortName: 'Adrien',  displayName: 'Adrien',  role: 'admin' }
  ];

  window.getCoachOptions = function () {
    // 1. Mode normal : TEAM_MEMBERS chargé avec succès
    if (window.TEAM_MEMBERS_ACTIVE && window.TEAM_MEMBERS_ACTIVE.length) {
      var EXCLUDED_ROLES = { sales: 1, setter: 1, closer: 1, closing: 1, csm: 1 };
      var filtered = window.TEAM_MEMBERS_ACTIVE.filter(function (m) {
        if (!m.role) return true;
        var r = String(m.role).toLowerCase();
        return !EXCLUDED_ROLES[r];
      });
      if (filtered.length) {
        return filtered.map(function (m) {
          return {
            slug: m.slug,
            label: m.displayName || m.shortName || m.slug,
            color: m.color || '#6b7280',
            shortName: m.shortName || m.displayName || m.slug,
            displayName: m.displayName || m.shortName || m.slug,
            role: m.role || ''
          };
        });
      }
    }
    // 2. Fallback : équipe hardcoded — débloque toujours l'UX
    return _COACH_FALLBACK.slice();
  };

  /**
   * Normalise un nom de coach brut vers son `displayName` canonique
   * tel que défini dans _meta/team_members.
   *
   * Remplace les anciennes regex hardcodées (mick/edou/emil/adri)
   * éparpillées dans coaching.html, coaching-dashboard.html, etc.
   * Pivote dynamiquement sur TEAM_MEMBERS : si on ajoute "Flore" dans
   * admin-users.html, elle est reconnue automatiquement partout.
   *
   * Algorithme :
   *   1. Strip + lowercase + retire accents pour comparaison.
   *   2. Pour chaque membre actif : compare avec displayName, shortName
   *      et slug (chacun aussi normalisé). Match exact OU préfixe d'un
   *      côté ou de l'autre (ex: "Edou" matche "Edouard", "Edouard C"
   *      matche "Edouard").
   *   3. Si match → retourne le `displayName` canonique du membre.
   *   4. Sinon → fallback historique : capitalize le premier mot
   *      (préserve les valeurs legacy stockées dans Firestore qui
   *      référencent un membre supprimé ou un nom libre).
   */
  window.normalizeCoach = function (raw) {
    if (!raw) return '';
    var s = String(raw).trim();
    if (!s) return '';
    var sl = s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    // 1. Lookup dynamique sur TEAM_MEMBERS (mode normal)
    if (window.TEAM_MEMBERS_LIST && window.TEAM_MEMBERS_LIST.length) {
      for (var i = 0; i < window.TEAM_MEMBERS_LIST.length; i++) {
        var m = window.TEAM_MEMBERS_LIST[i];
        if (m.active === false) continue;
        var candidates = [m.displayName, m.shortName, m.slug].filter(Boolean);
        for (var j = 0; j < candidates.length; j++) {
          var c = String(candidates[j]).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          if (!c) continue;
          if (c === sl || c.startsWith(sl) || sl.startsWith(c)) {
            return m.displayName || m.shortName || m.slug;
          }
        }
      }
    }
    // 2. Fallback : match contre l'équipe hardcoded (Thomas/Edouard/Flore/Emily/Adrien)
    for (var k = 0; k < _COACH_FALLBACK.length; k++) {
      var fb = _COACH_FALLBACK[k];
      var fbc = fb.label.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (fbc === sl || fbc.startsWith(sl) || sl.startsWith(fbc)) return fb.label;
    }
    // 3. Capitalize first word (legacy / nom libre)
    var first = s.split(/[\s.]/)[0];
    return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
  };

  window.getCoachColor = function (rawName) {
    if (!rawName) return '#94a3b8';
    var canon = window.normalizeCoach(rawName);
    if (!canon) return '#94a3b8';
    // 1. Couleur depuis TEAM_MEMBERS
    if (window.TEAM_MEMBERS_LIST && window.TEAM_MEMBERS_LIST.length) {
      for (var i = 0; i < window.TEAM_MEMBERS_LIST.length; i++) {
        var m = window.TEAM_MEMBERS_LIST[i];
        if (!m) continue;
        var label = m.displayName || m.shortName || m.slug;
        if (label === canon && m.color) return m.color;
      }
    }
    // 2. Couleur depuis fallback hardcoded
    for (var k = 0; k < _COACH_FALLBACK.length; k++) {
      if (_COACH_FALLBACK[k].label === canon) return _COACH_FALLBACK[k].color;
    }
    return '#94a3b8';
  };

  // Auto-load dual-SDK : attend qu'un des deux SDK Firebase soit prêt
  // ET qu'un utilisateur soit authentifié avant de query Firestore.
  //
  // - Compat (sales-*) : `firebase.auth().currentUser` + `firebase.firestore()`
  // - Modular (coaching-*, admin-*, csm-*) : pages exposent window._db et
  //   posent window._firebaseReady = true APRÈS leur onAuthStateChanged.
  //   On poll ce flag.
  //
  // Sans cette attente, loadTeamMembers() peut tourner alors que l'auth n'est
  // pas encore montée → permission-denied côté Firestore → fail silencieux.
  function _startTeamMembersLoad() {
    var _hasLoaded = false;
    var tryLoad = function (reason) {
      if (_hasLoaded) return false;
      // Cas A : SDK compat avec auth prête
      if (typeof firebase !== 'undefined' && firebase.firestore && firebase.auth && firebase.auth().currentUser) {
        _hasLoaded = true;
        window.loadTeamMembers();
        initAlteoFormsAccessWatch();
        return true;
      }
      // Cas B : SDK modulaire avec auth confirmée (flag posé par la page)
      if (window._db && window._getDoc && window._doc && window._firebaseReady) {
        _hasLoaded = true;
        window.loadTeamMembers();
        initAlteoFormsAccessWatch();
        return true;
      }
      return false;
    };

    // Premier essai immédiat (cas où tout est déjà prêt au moment du DOMContentLoaded)
    if (tryLoad('initial')) return;

    // S'abonner à onAuthStateChanged côté compat si dispo
    if (typeof firebase !== 'undefined' && firebase.auth) {
      try { firebase.auth().onAuthStateChanged(function () { tryLoad('compat-auth-change'); }); } catch (_) {}
    }

    // Poll régulier — couvre :
    //   - Le cas modulaire (qui n'expose pas d'API global pour s'abonner à l'auth
    //     sans avoir importé onAuthStateChanged dans cette IIFE).
    //   - Le cas compat où Firebase n'est pas encore initialisé.
    // S'arrête dès que _hasLoaded = true. Timeout dur à 15s pour éviter un poll infini.
    var pollStart = Date.now();
    var pollId = setInterval(function () {
      if (tryLoad('poll')) { clearInterval(pollId); return; }
      if (Date.now() - pollStart > 15000) {
        clearInterval(pollId);
        console.warn('[nav.js] team-members non chargé après 15s. SDK détecté:',
          (typeof firebase !== 'undefined' && firebase.firestore) ? 'compat' :
          (window._db ? 'modular (auth en attente)' : 'aucun'));
      }
    }, 200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _startTeamMembersLoad);
  } else {
    _startTeamMembersLoad();
  }

  function initAlteoFormsAccessWatch() {
    if (typeof firebase === 'undefined' || !firebase.auth) return;
    firebase.auth().onAuthStateChanged(async function(user) {
      if (!user) { localStorage.removeItem('ambitio_alteoforms_forms'); return; }
      var role = localStorage.getItem('ambitio_role') || 'coach';
      if (role === 'admin') return; // admin always has access
      try {
        var snap = await firebase.firestore().collection('users').doc(user.uid).get();
        var userData = snap.exists ? snap.data() : {};
        var formIds = userData.alteoformsFormIds || [];
        var prev = localStorage.getItem('ambitio_alteoforms_forms');
        var next = JSON.stringify(formIds);
        var payAccess = (userData.paymentsAccess === true || userData.paymentsTrigger === true) ? '1' : '0';
        var prevPay = localStorage.getItem('ambitio_payments_access') || '0';
        var sigAccess = userData.signaturesAccess === true ? '1' : '0';
        var prevSig = localStorage.getItem('ambitio_signatures_access') || '0';
        var changed = prev !== next || prevPay !== payAccess || prevSig !== sigAccess;
        if (formIds.length > 0) localStorage.setItem('ambitio_alteoforms_forms', next);
        else localStorage.removeItem('ambitio_alteoforms_forms');
        if (payAccess === '1') localStorage.setItem('ambitio_payments_access', '1');
        else localStorage.removeItem('ambitio_payments_access');
        if (sigAccess === '1') localStorage.setItem('ambitio_signatures_access', '1');
        else localStorage.removeItem('ambitio_signatures_access');
        if (changed && typeof buildSidebar === 'function') buildSidebar();
      } catch(e) { console.warn('[nav] alteoforms access check:', e); }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // INBOX WIDGET — auto-injection conditionnelle
  // Le widget de notifications SMS/appels est chargé uniquement pour les
  // rôles `sales` et `admin`. Les coachs ne le voient jamais.
  //
  // L'injection se fait au plus tôt (au load de nav.js) pour que les notifs
  // soient présentes même sur les pages coaching consultées par un admin.
  // Le filtrage final par rôle est fait DANS inbox-widget.js (via
  // onAuthStateChanged + lookup users/{uid}.role), donc on peut l'injecter
  // sans risque ici.
  // ─────────────────────────────────────────────────────────────────────────
  function injectInboxWidget() {
    if (window.__inboxWidgetInjected) return;
    window.__inboxWidgetInjected = true;

    // CSS
    if (!document.querySelector('link[data-inbox-widget]')) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'inbox-widget.css';
      link.setAttribute('data-inbox-widget', '1');
      document.head.appendChild(link);
    }
    // JS
    if (!document.querySelector('script[data-inbox-widget]')) {
      var script = document.createElement('script');
      script.src = 'inbox-widget.js';
      script.defer = true;
      script.setAttribute('data-inbox-widget', '1');
      document.head.appendChild(script);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectInboxWidget);
  } else {
    injectInboxWidget();
  }
})();

