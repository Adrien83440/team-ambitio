/**
 * nav.js — Ambitio Corp Sidebar Navigation
 * Rôles : coach / sales / admin
 * Mis à jour : inclut les pages coaching séparées (dashboard, analyse, agenda)
 */

(function () {

  const MODULES = {

    coach: [
      { id: 'clients',   icon: '👥', label: 'Clients',   href: 'coaching.html' },
      { id: 'dashboard', icon: '📊', label: 'Dashboard', href: 'coaching-dashboard.html' },
      { id: 'analyse',   icon: '📈', label: 'Analyse',   href: 'coaching-analyse.html' },
      { id: 'agenda',    icon: '📅', label: 'Agenda',    href: 'coaching-agenda.html' },
    ],

    sales: [
      { id: 'dashboard',   icon: '📊', label: 'Dashboard',         href: 'sales-dashboard.html' },
      { id: 'closing',     icon: '🎯', label: 'Closing',           href: 'sales-closing.html' },
      { id: 'setting',     icon: '📞', label: 'Setting',           href: 'sales-setting.html' },
      { id: 'equipe',      icon: '👥', label: 'Équipe',            href: 'sales-equipe.html' },
      { id: 'commissions', icon: '💰', label: 'Commissions',       href: 'sales-commissions.html' },
      { id: 'projections', icon: '📈', label: 'Projections',       href: 'sales-projections.html' },
      { id: 'saisie',      icon: '✏️', label: 'Saisie des données', href: 'sales-saisie.html' },
    ],

    admin: [
      { id: 'coach-clients',   icon: '👥', label: 'Clients',   href: 'coaching.html',           section: 'Coaching' },
      { id: 'coach-dashboard', icon: '📊', label: 'Dashboard', href: 'coaching-dashboard.html', section: 'Coaching' },
      { id: 'coach-analyse',   icon: '📈', label: 'Analyse',   href: 'coaching-analyse.html',   section: 'Coaching' },
      { id: 'coach-agenda',    icon: '📅', label: 'Agenda',    href: 'coaching-agenda.html',    section: 'Coaching' },
      { id: 'sales-dashboard',   icon: '📊', label: 'Dashboard',   href: 'sales-dashboard.html',   section: 'Sales' },
      { id: 'sales-closing',     icon: '🎯', label: 'Closing',     href: 'sales-closing.html',     section: 'Sales' },
      { id: 'sales-setting',     icon: '📞', label: 'Setting',     href: 'sales-setting.html',     section: 'Sales' },
      { id: 'sales-equipe',      icon: '👥', label: 'Équipe',      href: 'sales-equipe.html',      section: 'Sales' },
      { id: 'sales-commissions', icon: '💰', label: 'Commissions', href: 'sales-commissions.html', section: 'Sales' },
      { id: 'sales-projections', icon: '📈', label: 'Projections', href: 'sales-projections.html', section: 'Sales' },
      { id: 'sales-saisie',      icon: '✏️', label: 'Saisie',      href: 'sales-saisie.html',      section: 'Sales' },
      { id: 'import', icon: '🔗', label: 'Import Notion', href: 'import-notion.html', section: 'Outils' },
    ],
  };

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
  };

  const ROLE_LABELS = { coach: '🎓 Coach', sales: '📈 Commercial', admin: '👑 Administrateur' };

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

    .nav-role-section { position:relative; z-index:1; padding:10px 14px; flex-shrink:0; }
    .nav-role-badge {
      display:flex; align-items:center; gap:8px; padding:8px 10px; border-radius:10px;
      background:var(--nav-role-bg); border:1px solid var(--nav-role-border);
      overflow:hidden; transition:all 0.2s;
    }
    .nav-role-icon { font-size:16px; flex-shrink:0; width:20px; text-align:center; }
    .nav-role-text { overflow:hidden; transition:opacity 0.2s; }
    .nav-role-label { font-size:10px; font-weight:700; color:var(--nav-accent); text-transform:uppercase; letter-spacing:0.8px; white-space:nowrap; }
    .nav-role-name { font-size:12px; font-weight:600; color:rgba(255,255,255,0.8); white-space:nowrap; margin-top:1px; }

    .nav-section-label {
      position:relative; z-index:1; padding:8px 18px 4px;
      font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:1px;
      color:rgba(255,255,255,0.3); overflow:hidden; transition:opacity 0.2s; flex-shrink:0;
    }

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

    #ambitio-sidebar.collapsed .nav-item-label,
    #ambitio-sidebar.collapsed .nav-item-badge,
    #ambitio-sidebar.collapsed .nav-brand,
    #ambitio-sidebar.collapsed .nav-role-text,
    #ambitio-sidebar.collapsed .nav-section-label { opacity:0; pointer-events:none; }
    #ambitio-sidebar.collapsed .nav-role-badge { justify-content:center; }
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
  `;
  document.head.appendChild(style);

  function getRole() { return window._currentRole || localStorage.getItem('ambitio_role') || 'coach'; }
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
    const modules = MODULES[role] || MODULES.coach;
    const user    = getUserInfo();
    const { path } = getActivePage();

    document.documentElement.style.setProperty('--nav-accent',      theme.accent);
    document.documentElement.style.setProperty('--nav-accent-glow', theme.accentGlow);
    document.documentElement.style.setProperty('--nav-role-bg',     theme.roleBg);
    document.documentElement.style.setProperty('--nav-role-border', theme.roleBorder);

    const isCollapsed = localStorage.getItem('nav_collapsed') === '1';

    const sidebar = document.createElement('div');
    sidebar.id = 'ambitio-sidebar';
    sidebar.style.background = `linear-gradient(180deg,${theme.grad1} 0%,${theme.grad2} 50%,${theme.grad3} 100%)`;
    if (isCollapsed) sidebar.classList.add('collapsed');

    let navHtml = '', lastSection = null;
    modules.forEach(m => {
      if (m.section && m.section !== lastSection) {
        navHtml += `<div class="nav-section-label" style="margin-top:${lastSection?'12px':'0'}">${m.section}</div>`;
        lastSection = m.section;
      }
      const isActive   = path === m.href.split('#')[0];
      const badgeClass = m.badge && /^\d+$/.test(m.badge) ? 'nav-item-badge num' : 'nav-item-badge';
      navHtml += `<a class="nav-item${isActive?' active':''}" href="${m.href}" data-id="${m.id}" data-label="${m.label}">
        <span class="nav-item-icon">${m.icon}</span>
        <span class="nav-item-label">${m.label}</span>
        ${m.badge?`<span class="${badgeClass}">${m.badge}</span>`:''}
      </a>`;
    });

    sidebar.innerHTML = `
      <div class="nav-header">
        <div class="nav-logo">A</div>
        <div class="nav-brand">
          <div class="nav-brand-title">Ambitio <span style="opacity:.6">Corp</span></div>
          <div class="nav-brand-sub">${theme.label}</div>
        </div>
        <button class="nav-collapse-btn" id="navCollapseBtn" title="Réduire">◀</button>
      </div>
      <div class="nav-role-section">
        <div class="nav-role-badge">
          <span class="nav-role-icon">${theme.emoji}</span>
          <div class="nav-role-text">
            <div class="nav-role-label">${theme.label}</div>
            <div class="nav-role-name">${ROLE_LABELS[role]||role}</div>
          </div>
        </div>
      </div>
      <div class="nav-items" id="navItems">${navHtml}</div>
      <div class="nav-footer">
        <div class="nav-profile-btn" id="navProfileBtn">
          <div class="nav-avatar">${user.initials}</div>
          <div class="nav-profile-info">
            <div class="nav-profile-name">${user.name}</div>
            <div class="nav-profile-role">${user.email}</div>
          </div>
          <span class="nav-profile-caret">⚙</span>
        </div>
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
  }

  function openProfileModal() {
    const role  = getRole();
    const theme = THEMES[role] || THEMES.coach;
    const user  = getUserInfo();
    const saved = JSON.parse(localStorage.getItem('ambitio_profile') || '{}');

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
      ['ambitio_role','ambitio_name','ambitio_email'].forEach(k => localStorage.removeItem(k));
      window.location.href = 'login.html';
    });
  }

  function init() {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildSidebar);
    else buildSidebar();
  }

  window.AmbitioNav = {
    setRole(role, name, email) {
      localStorage.setItem('ambitio_role', role);
      if (name)  localStorage.setItem('ambitio_name', name);
      if (email) localStorage.setItem('ambitio_email', email);
      window._currentRole = role; window._currentUserName = name; window._currentUserEmail = email;
    },
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
