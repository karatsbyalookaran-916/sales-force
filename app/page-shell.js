(() => {
  const params = new URLSearchParams(location.search);
  if (params.has('embed')) return;
  const isPresentation = /Karats-Elite-Plan-Brochure-source\.html$/i.test(location.pathname);
  const isCalculator = /Karats-Smart-Capital-Calculator\.html$/i.test(location.pathname);
  if (!isPresentation && !isCalculator) return;
  document.body.classList.add('karats-shell-page');
  const lane = document.createElement('aside');
  lane.className = 'karats-page-lane'; lane.id = 'karatsPageLane'; lane.setAttribute('aria-label', 'KARATS navigation');
  lane.innerHTML = `<div class="karats-page-brand"><button class="karats-page-brand-mark karats-page-toggle" type="button" aria-controls="karatsPageLane" aria-expanded="true" aria-label="Collapse navigation">K</button><a class="karats-page-brand-copy" href="/" aria-label="KARATS home">KARATS<small>TEAM WORKSPACE</small></a></div><div class="karats-page-nav-label">WORKSPACE</div><nav class="karats-page-nav"><a href="/"><span class="karats-page-icon">▣</span><span class="karats-page-nav-text">Lead pipeline</span></a><a href="/Karats-Elite-Plan-Brochure-source.html#presentation" class="${isPresentation ? 'active' : ''}"><span class="karats-page-icon">◇</span><span class="karats-page-nav-text">Presentation</span></a><a href="/Karats-Smart-Capital-Calculator.html" class="${isCalculator ? 'active' : ''}"><span class="karats-page-icon">▦</span><span class="karats-page-nav-text">Capital calculator</span></a><a href="/#team" class="karats-manage-team" hidden><span class="karats-page-icon">♧</span><span class="karats-page-nav-text">Employee management</span></a></nav>`;
  const toggle = lane.querySelector('.karats-page-toggle');
  const backdrop = document.createElement('button');
  backdrop.className = 'karats-page-backdrop'; backdrop.type = 'button'; backdrop.setAttribute('aria-label', 'Close navigation');
  document.body.prepend(backdrop); document.body.prepend(lane);
  const mobile = () => matchMedia('(max-width: 700px)').matches;
  function setCollapsed(collapsed, remember = true) {
    document.body.classList.toggle('karats-lane-collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'Open navigation' : 'Collapse navigation');
    backdrop.classList.toggle('visible', mobile() && !collapsed);
    if (remember) localStorage.setItem('karatsSidebarCollapsed', collapsed ? '1' : '0');
    window.dispatchEvent(new Event('resize'));
  }
  const stored = localStorage.getItem('karatsSidebarCollapsed');
  setCollapsed(stored == null ? mobile() : stored === '1', false);
  toggle.addEventListener('click', () => setCollapsed(!document.body.classList.contains('karats-lane-collapsed')));
  backdrop.addEventListener('click', () => setCollapsed(true));
  const media = matchMedia('(max-width: 700px)');
  media.addEventListener('change', event => setCollapsed(event.matches, false));
  const teamLink = lane.querySelector('.karats-manage-team');
  const showTeamFor = user => { teamLink.hidden = user?.role !== 'admin'; };
  if (localStorage.getItem('karatsUserRole') === 'admin') teamLink.hidden = false;
  const readOfflineRole = () => { try {
    const request = indexedDB.open('karats-team', 1);
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('workspace')) { database.close(); return; }
      const read = database.transaction('workspace').objectStore('workspace').get('active');
      read.onsuccess = () => { showTeamFor(read.result?.user); database.close(); };
      read.onerror = () => database.close();
    };
  } catch { /* Keep the rest of navigation available without browser storage. */ } };
  fetch('/api/me', { headers: { 'X-Karats-Request': '1' } })
    .then(response => response.ok ? response.json() : Promise.reject())
    .then(result => showTeamFor(result.user))
    .catch(readOfflineRole);
})();
