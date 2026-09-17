const $ = id => document.getElementById(id);
const stages = ['New', 'Contacted', 'Presented', 'Interested', 'Negotiating', 'Joined', 'Closed'];
// Stage colours run pale to deep across the pipeline, so the column accents read as
// progress rather than as seven unrelated labels. Values are the Alookaran ramp.
// Starts at Primary 200 rather than 100: the column accent is a 2px rule on a near-white
// board, and Primary 100 is invisible there.
const colors = ['#d9c9ff', '#c3a9ff', '#a98ae8', '#8f68d8', '#7a4fc0', '#4c2394', '#35166e'];
const fields = ['name', 'contact', 'phone', 'email', 'location', 'stage', 'ownerId', 'followUp', 'notes'];
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const today = () => { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
const active = lead => !['Joined', 'Closed'].includes(lead.stage);
const due = lead => active(lead) && lead.followUp && lead.followUp <= today();
let state = null, db, syncing = false, selectedConflict, editingVersion, setupAvailable = false;
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('karats-workspace') : null;
function message(text) { (document.querySelector('dialog[open]') || document.querySelector('main')).append($('message')); $('message').textContent = text; $('message').hidden = false; clearTimeout(message.timer); message.timer = setTimeout(() => $('message').hidden = true, 8000); }
async function api(path, data) {
  const response = await fetch('/api/' + path, { method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Karats-Request': '1' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(12000) });
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error || 'Request failed'); error.status = response.status; error.current = result.current; throw error; }
  return result;
}
function transaction(mode, action) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('workspace', mode); const request = action(tx.objectStore('workspace'));
    tx.oncomplete = () => resolve(request?.result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('Saving was interrupted'));
  });
}
const read = () => transaction('readonly', store => store.get('active'));
const save = () => transaction('readwrite', store => store.put(state, 'active'));
const clear = () => transaction('readwrite', store => store.clear());
async function locked(action) {
  if (!navigator.locks) throw new Error('Use a current browser on localhost or HTTPS to save leads safely.');
  return navigator.locks.request('karats-workspace', async () => { state = (await read()) || null; return action(); });
}
const leadViews = { dashboard: 'lead-dashboard', directory: 'lead-directory', pipeline: 'workspace', scoreboard: 'scoreboard' };
function hideWorkspaceViews() { Object.values(leadViews).forEach(id => $(id).hidden = true); $('employee-management').hidden = true; }
function showLogin() { document.body.classList.add('auth-view'); document.body.classList.remove('sidebar-collapsed'); hideWorkspaceViews(); $('login-view').hidden = false; $('topbar-account').hidden = true; $('profile-menu').hidden = true; $('settings-button').hidden = true; $('team-button').hidden = true; $('identity').textContent = 'Sign in to your workspace'; }
function showWorkspace() {
  document.body.classList.remove('auth-view');
  localStorage.setItem('karatsUserRole', state.user.role);
  const mobile = matchMedia('(max-width: 700px)').matches;
  const saved = localStorage.getItem('karatsSidebarCollapsed');
  setSidebar(saved == null ? mobile : saved === '1', false);
  $('login-view').hidden = true; $('topbar-account').hidden = false; $('settings-button').hidden = false; $('team-button').hidden = state.user.role !== 'admin'; document.querySelector('.admin-nav-label').hidden = state.user.role !== 'admin';
  $('identity').innerHTML = `${esc(state.user.name)}<br><span class="hint">${esc(state.user.role === 'admin' ? 'Administrator' : 'Team member')}</span>`;
  const accountRole = state.user.role === 'admin' ? 'Administrator' : 'Staff';
  const initial = state.user.name.trim().charAt(0).toUpperCase();
  $('topbar-profile-name').textContent = state.user.name; $('topbar-profile-role').textContent = accountRole; $('topbar-avatar').textContent = initial;
  $('settings-name').textContent = state.user.name; $('settings-role').textContent = accountRole; $('settings-email').textContent = state.user.email; $('settings-initial').textContent = initial;
  const selection = $('owner-filter').value;
  $('owner-filter').innerHTML = '<option value="">All team members</option>' + state.users.map(user => `<option value="${esc(user.id)}">${esc(user.name)}</option>`).join('');
  $('owner-filter').value = selection;
  render();
  if (location.hash === '#team' && state.user.role === 'admin') {
    setTimeout(showTeam, 0);
  } else navigateLeadView(location.hash.slice(1) in leadViews ? location.hash.slice(1) : 'dashboard', false);
}
function status() { /* Background sync is intentionally silent. */ }
function render() {
  if (!state) return;
  const leads = state.leads;
  const stats = [ ['Total leads', leads.length, 'Across your team'], ['Active opportunities', leads.filter(active).length, 'Conversations in progress'], ['Follow-ups due', leads.filter(due).length, 'Today & overdue'], ['Joined', leads.filter(lead => lead.stage === 'Joined').length, 'Relationships converted'] ];
  $('stats').innerHTML = stats.map(([label, number, caption]) => `<article class="stat"><span class="stat-label">${label}</span><strong>${number}</strong><small>${caption}</small></article>`).join('');
  const query = $('search').value.toLowerCase().trim(), owner = $('owner-filter').value, dueFilter = $('due-filter').value;
  const filtered = leads.filter(lead => [lead.name, lead.contact, lead.phone, lead.location, lead.email].join(' ').toLowerCase().includes(query) && (!owner || lead.ownerId === owner) && (dueFilter === 'all' || (dueFilter === 'due' ? due(lead) : !lead.followUp)));
  $('empty').hidden = leads.length !== 0;
  $('board').hidden = !leads.length;
  $('board').innerHTML = stages.map((stage, index) => {
    const items = filtered.filter(lead => lead.stage === stage).sort((a, b) => (a.followUp || '9999').localeCompare(b.followUp || '9999'));
    return `<section class="column" style="--stage-color:${colors[index]}"><div class="column-head"><h2>${stage}</h2><span class="count">${items.length}</span></div>${items.length ? items.map(lead => {
      const person = state.users.find(user => user.id === lead.ownerId);
      return `<article class="lead-card"><button class="lead-open" data-lead="${esc(lead.id)}">${esc(lead.name)}</button><p>${esc(lead.contact || 'No contact person yet')}</p><p>${esc(lead.location || lead.phone || 'Add contact details')}</p><div class="card-meta"><span>${esc(person?.name || 'Unassigned')}</span><span class="${due(lead) ? 'due' : ''}">${lead.followUp ? esc(lead.followUp.slice(5).split('-').reverse().join('/')) : 'No follow-up'}</span></div>${state.queue.some(item => item.lead.id === lead.id) ? '<div class="pending">Saved on device · awaiting sync</div>' : ''}</article>`;
    }).join('') : '<div class="column-empty">No leads in this stage</div>'}</section>`;
  }).join('');
  const conflictIds = Object.keys(state.conflicts);
  $('conflicts').hidden = !conflictIds.length;
  $('conflicts').innerHTML = '<strong>Updates to review</strong> · Your edits are safe on this device.<br>' + conflictIds.map(id => `<button data-conflict="${esc(id)}">Review ${esc(leads.find(lead => lead.id === id)?.name || 'lead')}</button>`).join('');
  renderManagementViews();
}
function renderManagementViews() {
  if (!state) return;
  const leads = state.leads, statData = [['Total leads', leads.length, 'All recorded opportunities'], ['Active', leads.filter(active).length, 'Currently in progress'], ['Due', leads.filter(due).length, 'Follow-ups requiring attention'], ['Joined', leads.filter(lead => lead.stage === 'Joined').length, 'Converted relationships']];
  $('dashboard-stats').innerHTML = statData.map(([label,value,caption]) => `<article class="stat"><span class="stat-label">${label}</span><strong>${value}</strong><small>${caption}</small></article>`).join('');
  $('dashboard-stages').innerHTML = stages.map(stage => `<div class="stage-summary"><span>${stage}</span><strong>${leads.filter(lead => lead.stage === stage).length}</strong></div>`).join('');
  const recent = [...leads].sort((a,b) => String(b.updatedAt||'').localeCompare(String(a.updatedAt||''))).slice(0,6);
  $('dashboard-recent').innerHTML = recent.length ? recent.map(lead => `<button class="directory-row" data-lead="${esc(lead.id)}"><span><strong>${esc(lead.name)}</strong><small>${esc(state.users.find(user=>user.id===lead.ownerId)?.name||'Unassigned')}</small></span><span class="status-chip">${esc(lead.stage)}</span></button>`).join('') : '<p class="directory-empty">No leads yet.</p>';
  const ownerValue=$('directory-owner').value;
  $('directory-owner').innerHTML='<option value="">All employees</option>'+state.users.map(user=>`<option value="${esc(user.id)}">${esc(user.name)}</option>`).join(''); $('directory-owner').value=ownerValue;
  if (!$('directory-status').options.length || $('directory-status').options.length===1) $('directory-status').innerHTML='<option value="">All statuses</option>'+stages.map(stage=>`<option>${stage}</option>`).join('');
  renderLeadDirectory();
  $('scoreboard-list').innerHTML=state.users.map((user,index)=>{const owned=leads.filter(lead=>lead.ownerId===user.id);return `<article class="score-card"><span class="score-rank">${index+1}</span><div><h2>${esc(user.name)}</h2><p>${esc(user.role==='admin'?'Administrator':'Staff')}</p></div><div><strong>${owned.length}</strong><small>Total leads</small></div><div><strong>${owned.filter(active).length}</strong><small>Active</small></div><div><strong>${owned.filter(lead=>lead.stage==='Joined').length}</strong><small>Joined</small></div></article>`}).join('');
}
function renderLeadDirectory(){
  if(!state)return; const owner=$('directory-owner').value,statusValue=$('directory-status').value,period=$('directory-period').value,now=today(),month=now.slice(0,7);
  const items=state.leads.filter(lead=>{const changed=String(lead.updatedAt||'').slice(0,10);return(!owner||lead.ownerId===owner)&&(!statusValue||lead.stage===statusValue)&&(period==='all'||(period==='month'?changed.startsWith(month):changed===now))}).sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));
  $('lead-directory-list').innerHTML=items.length?items.map(lead=>`<button class="directory-row" data-lead="${esc(lead.id)}"><span><strong>${esc(lead.name)}</strong><small>${esc(state.users.find(user=>user.id===lead.ownerId)?.name||'Unassigned')} · ${esc(lead.contact||lead.location||'No contact details')}</small></span><span><span class="status-chip">${esc(lead.stage)}</span><small>${lead.updatedAt?esc(new Date(lead.updatedAt).toLocaleDateString()):'—'}</small></span></button>`).join(''):'<p class="directory-empty">No leads match these filters.</p>';
}
function navigateLeadView(view, updateHash=true){
  if(!(view in leadViews))view='dashboard'; hideWorkspaceViews(); $(leadViews[view]).hidden=false;
  for(const key of Object.keys(leadViews)) $(`${key==='directory'?'lead-directory':key}-link`)?.classList.toggle('active',key===view);
  $('team-button').classList.remove('active'); if(updateHash)history.replaceState(null,'',`#${view}`); if(view!=='pipeline')renderManagementViews();
}
async function sync() {
  if (syncing || !state || !$('login-view').hidden) return;
  syncing = true; status('Syncing…');
  try {
    await locked(async () => {
      if (!state) return;
      const { user } = await api('me');
      if (user.id !== state.user.id) { const error = new Error('The signed-in account changed. Sign in again.'); error.status = 401; throw error; }
      state.user = user;
      state.users = await api('users');
      for (const item of [...state.queue]) {
        if (state.conflicts[item.lead.id]) continue;
        try {
          const saved = await api('leads', item);
          state.queue = state.queue.filter(op => op.mutationId !== item.mutationId);
          if (!state.queue.some(op => op.lead.id === saved.id)) state.leads = state.leads.map(lead => lead.id === saved.id ? saved : lead);
          await save();
        } catch (error) {
          if (error.status !== 409) throw error;
          state.conflicts[item.lead.id] = error.current;
          await save();
        }
      }
      const remote = await api('leads');
      const dirtyIds = new Set(state.queue.map(item => item.lead.id));
      state.leads = [...remote.filter(lead => !dirtyIds.has(lead.id)), ...state.leads.filter(lead => dirtyIds.has(lead.id))];
      state.lastSync = new Date().toISOString();
      await save();
      status(state.queue.length ? `${state.queue.length} update(s) need review` : 'All changes synced');
      showWorkspace(); channel?.postMessage('updated');
    });
  } catch (error) {
    if (error.status === 401) { showLogin(); status('Sign in to sync'); message('Your saved edits are safe. Sign in to the same account to sync them.'); }
    else if (error.status) { status('Sync needs attention'); message(error.message); }
    else { if (state?.offlineUntil <= Date.now()) { showLogin(); status('Sign in to continue'); } else { status(`Offline · ${state?.queue.length || 0} pending`); render(); } }
  } finally { syncing = false; }
}
async function editLead(id) {
  await locked(async () => {}); if (!state) return showLogin();
  const lead = state.leads.find(item => item.id === id);
  $('lead-form').reset();
  $('lead-stage').innerHTML = stages.map(stage => `<option>${stage}</option>`).join('');
  $('lead-owner').innerHTML = '<option value="">Unassigned</option>' + state.users.map(user => `<option value="${esc(user.id)}">${esc(user.name)}</option>`).join('');
  const values = lead || { id: crypto.randomUUID(), stage: 'New', ownerId: state.user.id };
  for (const field of ['id', ...fields]) $('lead-form').elements.namedItem(field).value = values[field] || '';
  editingVersion = lead?.version || 0;
  $('lead-title').textContent = lead ? lead.name : 'New lead';
  $('lead-history').textContent = lead ? 'Activity history is available when connected.' : '';
  $('lead-dialog').showModal();
  if (lead) {
    try {
      const events = await api('activity?lead=' + encodeURIComponent(id));
      if ($('lead-form').elements.id.value !== id) return;
      $('lead-history').innerHTML = '<h3>Activity</h3>' + events.map(event => `<p>${esc(event.user_name)} · ${esc(event.text)}<br>${esc(new Date(event.created_at).toLocaleString())}</p>`).join('');
    } catch { /* Offline editing remains available. */ }
  }
}
async function saveLead(event) {
  event.preventDefault();
  const button = event.submitter; button.disabled = true;
  try {
    const values = Object.fromEntries(new FormData(event.target));
    values.name = values.name.trim(); if (!values.name) throw new Error('Enter a business name.');
    await locked(async () => {
      if (!state) throw new Error('Sign in before saving.');
      const old = state.leads.find(lead => lead.id === values.id);
      if ((old?.version || 0) !== editingVersion) throw new Error('This lead changed while you were editing. Close and reopen it to review the latest version.');
      const baseVersion = old?.version || 0;
      const lead = { ...values, version: baseVersion + 1, updatedAt: new Date().toISOString() };
      state.leads = [...state.leads.filter(item => item.id !== lead.id), lead];
      state.queue.push({ mutationId: crypto.randomUUID(), baseVersion, lead });
      await save(); render(); channel?.postMessage('updated');
    });
    $('lead-dialog').close(); message('Lead saved on this device.'); void sync();
  } catch (error) { message(error.message); } finally { button.disabled = false; }
}
function reviewConflict(id) {
  selectedConflict = id;
  const mine = state.leads.find(lead => lead.id === id), team = state.conflicts[id];
  if (!mine || !team) return;
  $('conflict-versions').innerHTML = [[ 'Your saved version', mine ], [ 'Team version', team ]].map(([title, lead]) => `<section class="version"><h3>${title}</h3><pre>${fields.map(key => `${key === 'ownerId' ? 'Assigned to' : key}: ${esc(key === 'ownerId' ? state.users.find(user => user.id === lead[key])?.name || 'Unassigned' : lead[key] || '—')}`).join('\n')}</pre></section>`).join('');
  $('conflict-dialog').showModal();
}
async function resolveConflict(useMine) {
  try {
    await locked(async () => {
      const team = state?.conflicts[selectedConflict], mine = state?.leads.find(lead => lead.id === selectedConflict);
      if (!team || !mine) throw new Error('This conflict was already resolved.');
      state.queue = state.queue.filter(item => item.lead.id !== selectedConflict);
      const lead = useMine ? { ...mine, version: team.version + 1 } : team;
      if (useMine) state.queue.push({ mutationId: crypto.randomUUID(), baseVersion: team.version, lead });
      state.leads = state.leads.map(item => item.id === lead.id ? lead : item);
      delete state.conflicts[selectedConflict]; await save(); render(); channel?.postMessage('updated');
    });
    $('conflict-dialog').close(); void sync();
  } catch (error) { message(error.message); }
}
async function login(event) {
  event.preventDefault(); event.submitter.disabled = true;
  try {
    const credentials = Object.fromEntries(new FormData(event.target));
    await locked(async () => {
      if (state?.queue.length && state.user.email.toLowerCase() !== credentials.email.trim().toLowerCase()) throw new Error('Sign in to ' + state.user.email + ' first to sync pending changes before switching accounts.');
      if (setupAvailable) { await api('setup', credentials); setupAvailable = false; configureLogin(); }
      const { user } = await api('login', credentials);
      if (state?.user.id !== user.id) state = { user, users: [user], leads: [], queue: [], conflicts: {} };
      state.user = user; state.offlineUntil = Date.now() + 7 * 86400000; await save();
    });
    event.target.reset(); showWorkspace(); void navigator.storage?.persist(); await sync();
  } catch (error) { message(error.status ? error.message : error.message.includes('Sign in to') ? error.message : 'Unable to sign in. Check the connection and try again.'); }
  finally { event.submitter.disabled = false; }
}
async function logout() {
  try {
    await locked(async () => {
      if (state?.queue.length) throw new Error('Sync or resolve pending changes before signing out. This keeps your unsynced leads safe.');
      await api('logout', {});
      await clear(); state = null;
      // Clear the legacy calculator/profile data too on a shared device.
      for (const key of Object.keys(localStorage)) if (/^karats/i.test(key)) localStorage.removeItem(key);
      channel?.postMessage('signed-out');
    });
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    $('lead-form').reset(); $('board').innerHTML = ''; showLogin(); status('Signed out');
  } catch (error) { message(error.status || error.message.includes('Sync or') ? error.message : 'Connect to the server to securely sign out.'); }
}
function exportLeads() {
  const columns = ['name', 'contact', 'phone', 'email', 'location', 'stage', 'ownerId', 'followUp', 'notes'];
  const cell = value => '"' + String(value || '').replace(/^(?:\s*[=+@-]|[\t\r])/, match => "'" + match).replaceAll('"', '""') + '"';
  const csv = [columns.join(','), ...state.leads.map(lead => columns.map(key => cell(key === 'ownerId' ? state.users.find(user => user.id === lead[key])?.name : lead[key])).join(','))].join('\r\n');
  const url = URL.createObjectURL(new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `karats-leads-${today()}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function showTeam() {
  if (!state || state.user.role !== 'admin') return;
  location.hash = 'team'; hideWorkspaceViews(); $('employee-management').hidden = false;
  Object.keys(leadViews).forEach(key=>$(`${key==='directory'?'lead-directory':key}-link`)?.classList.remove('active')); $('team-button').classList.add('active');
  try { state.users = await api('users'); $('team-list').innerHTML = state.users.map(user => `<article class="employee-row"><span class="employee-avatar">${esc(user.name.trim().charAt(0).toUpperCase())}</span><div><strong>${esc(user.name)}</strong><p>${esc(user.email)}</p></div><span class="employee-role">${esc(user.role === 'admin' ? 'Administrator' : 'Staff')}</span></article>`).join(''); } catch (error) { message(error.status ? error.message : 'Connect to manage employees.'); }
}
function setEmployeeTab(tab) {
  const directory = tab === 'directory'; $('directory-panel').hidden = !directory; $('onboard-panel').hidden = directory;
  $('directory-tab').classList.toggle('active', directory); $('onboard-tab').classList.toggle('active', !directory);
  $('directory-tab').setAttribute('aria-selected', String(directory)); $('onboard-tab').setAttribute('aria-selected', String(!directory));
}
function setTopbarProfileMenu(open){$('profile-menu').hidden=!open;$('profile-trigger').setAttribute('aria-expanded',String(open))}
async function createMember(event) {
  event.preventDefault(); event.submitter.disabled = true;
  try {
    await api('users', Object.fromEntries(new FormData(event.target))); event.target.reset(); await showTeam(); setEmployeeTab('directory'); message('Employee account created.');
  } catch (error) { message(error.status ? error.message : 'Unable to create the account. Check the connection.'); }
  finally { event.submitter.disabled = false; }
}
function configureLogin() {
  $('setup-name').hidden = !setupAvailable;
  $('login-form').elements.name.required = setupAvailable;
  $('login-form').elements.password.minLength = 6;
  $('login-title').textContent = setupAvailable ? 'Set up your workspace' : 'Team sign in';
  $('login-submit').textContent = setupAvailable ? 'Create administrator account' : 'Sign in';
  $('login-hint').textContent = setupAvailable ? 'Create the one administrator account. Use a password of at least 6 characters. Then register staff from Manage team.' : 'Use your separate staff or administrator login. Your first sign-in needs a connection.';
}
function setSidebar(collapsed, remember = true) {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  $('sidebar-toggle').setAttribute('aria-expanded', String(!collapsed));
  $('sidebar-toggle').setAttribute('aria-label', collapsed ? 'Open navigation' : 'Collapse navigation');
  $('sidebar-backdrop').hidden = collapsed || !matchMedia('(max-width: 700px)').matches;
  if (remember) localStorage.setItem('karatsSidebarCollapsed', collapsed ? '1' : '0');
}
async function start() {
  db = await new Promise((resolve, reject) => { const request = indexedDB.open('karats-team', 1); request.onupgradeneeded = () => request.result.createObjectStore('workspace'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  $('login-form').addEventListener('submit', login); $('lead-form').addEventListener('submit', saveLead); $('team-form').addEventListener('submit', createMember);
  const mobileNavigation = matchMedia('(max-width: 700px)');
  const savedSidebar = localStorage.getItem('karatsSidebarCollapsed');
  setSidebar(savedSidebar == null ? mobileNavigation.matches : savedSidebar === '1', false);
  $('sidebar-toggle').onclick = () => setSidebar(!document.body.classList.contains('sidebar-collapsed'));
  $('sidebar-backdrop').onclick = () => setSidebar(true);
  mobileNavigation.addEventListener('change', event => setSidebar(event.matches, false));
  $('add').onclick = $('first-lead').onclick = () => editLead(); document.querySelectorAll('.add-lead-action').forEach(button=>button.onclick=()=>editLead()); $('logout').onclick = logout; $('export').onclick = exportLeads; $('team-button').onclick = showTeam;
  for(const view of Object.keys(leadViews)){const id=view==='directory'?'lead-directory-link':`${view}-link`;$ (id).onclick=event=>{event.preventDefault();navigateLeadView(view)}}
  for(const id of ['directory-owner','directory-period','directory-status'])$(id).addEventListener('change',renderLeadDirectory);
  $('directory-tab').onclick = () => setEmployeeTab('directory'); $('onboard-tab').onclick = () => setEmployeeTab('onboard');
  $('keep-mine').onclick = () => resolveConflict(true); $('keep-team').onclick = () => resolveConflict(false);
  $('settings-button').onclick = () => $('settings-dialog').showModal();
  $('profile-trigger').onclick = event => { event.stopPropagation(); setTopbarProfileMenu($('profile-menu').hidden); };
  for (const id of ['search', 'owner-filter', 'due-filter']) $(id).addEventListener('input', render);
  document.addEventListener('click', event => { const close = event.target.closest('[data-close]'), lead = event.target.closest('[data-lead]'), conflict = event.target.closest('[data-conflict]'); if (close) $(close.dataset.close).close(); if (lead) void editLead(lead.dataset.lead); if (conflict) reviewConflict(conflict.dataset.conflict); if(!event.target.closest('.topbar-profile'))setTopbarProfileMenu(false); });
  document.addEventListener('keydown',event=>{if(event.key==='Escape')setTopbarProfileMenu(false)});
  window.addEventListener('online', sync); window.addEventListener('offline', () => status(`Offline · ${state?.queue.length || 0} pending`));
  channel?.addEventListener('message', async event => { await locked(async () => {}); if (!state || event.data === 'signed-out') { for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close(); showLogin(); } else if ($('login-view').hidden) showWorkspace(); });
  setInterval(() => { if (document.visibilityState === 'visible') void sync(); }, 30000);
  state = (await read()) || null;
  try { setupAvailable = (await api('setup-status')).setupAvailable; configureLogin(); } catch { /* Cached accounts can still work offline. */ }
  try {
    const { user } = await api('me');
    if (state && state.user.id !== user.id && state.queue.length) { showLogin(); status('Sign in to sync saved edits'); return; }
    await locked(async () => { if (!state || state.user.id !== user.id) state = { user, users: [user], leads: [], queue: [], conflicts: {}, offlineUntil: Date.now() + 7 * 86400000 }; state.user = user; await save(); });
    showWorkspace(); void sync();
  } catch (error) {
    if (!error.status && state && state.offlineUntil > Date.now()) { showWorkspace(); status(`Offline · ${state.queue.length} pending`); }
    else { showLogin(); status('Sign in'); }
  }
}
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).catch(() => {});
}
start().catch(() => { status('Storage unavailable'); message('Local storage could not open. Use a browser profile with storage enabled.'); });
