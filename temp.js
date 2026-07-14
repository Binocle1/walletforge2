
const API = '/api';
let TOKEN = localStorage.getItem('wf_token');
let me = null;

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}), ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erreur ' + res.status);
  return data;
}
function toast(msg, err) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.style.background = err ? 'var(--danger)' : 'var(--ink)';
  t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 3200);
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

// ---------- auth ----------
function authTab(t) {
  document.getElementById('formLogin').style.display = t === 'login' ? '' : 'none';
  document.getElementById('formReg').style.display = t === 'reg' ? '' : 'none';
  document.getElementById('formForgot').style.display = 'none';
  document.getElementById('formReset').style.display = 'none';
  document.getElementById('tabLogin').classList.toggle('on', t === 'login');
  document.getElementById('tabReg').classList.toggle('on', t === 'reg');
}
function showForgot() {
  document.getElementById('formLogin').style.display = 'none';
  document.getElementById('formForgot').style.display = '';
}
async function forgot() {
  try {
    const r = await api('/auth/forgot-password', { method: 'POST', body: { email: document.getElementById('fEmail').value } });
    toast(r.message);
  } catch(e) { toast(e.message, 1); }
}
async function resetPass() {
  const urlParams = new URLSearchParams(window.location.search);
  const token = urlParams.get('reset');
  try {
    const r = await api('/auth/reset-password', { method: 'POST', body: { token, password: document.getElementById('nPass').value } });
    toast(r.message);
    window.history.replaceState({}, document.title, "/dashboard");
    authTab('login');
  } catch(e) { toast(e.message, 1); }
}
async function login() {
  try {
    const r = await api('/auth/login', { method: 'POST', body: { email: lEmail.value, password: lPass.value } });
    TOKEN = r.token; localStorage.setItem('wf_token', TOKEN); boot();
  } catch (e) { toast(e.message, 1); }
}
async function register() {
  try {
    const r = await api('/auth/register', { method: 'POST', body: {
      business_name: rBiz.value, full_name: rName.value, email: rEmail.value,
      password: rPass.value, country: rCountry.value, currency: rCurrency.value } });
    TOKEN = r.token; localStorage.setItem('wf_token', TOKEN); boot();
    toast('Bienvenue ! Crée ton premier programme de fidélité 🎉');
  } catch (e) { toast(e.message, 1); }
}
function logout() { localStorage.removeItem('wf_token'); location.reload(); }

// ---------- navigation ----------
function go(s) {
  document.querySelectorAll('.section').forEach(x => x.classList.remove('on'));
  document.getElementById('s-' + s).classList.add('on');
  document.querySelectorAll('nav a[data-s]').forEach(a => a.classList.toggle('on', a.dataset.s === s));
  ({ home: loadHome, programs: loadPrograms, customers: loadCustomers, tx: loadTx, stats: loadStats, notifs: loadNotifs, settings: loadBusiness })[s]?.();
}
function openModal(id){document.getElementById(id).classList.add('on')}
function closeModal(id){document.getElementById(id).classList.remove('on')}
window.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal')) e.target.classList.remove('on');
});

// ---------- home ----------
async function loadHome() {
  const s = await api('/stats');
  document.getElementById('statCards').innerHTML = [
    ['Clients', s.total_customers], ['Nouveaux (30j)', s.new_customers_30d],
    ['Taux de retour', (s.return_rate ?? 0) + ' %'], ['Panier moyen', (s.avg_basket ?? 0) + ' €'],
    ['Cartes Apple', s.apple_installs], ['Cartes Google', s.google_installs],
    ['Transactions', s.total_transactions], ['CA déclaré', Number(s.total_amount || 0).toFixed(0) + ' €'],
    ['Notifications', s.notifications_sent], ['Non installées', s.not_installed],
  ].map(([l, v]) => `<div class="card stat"><small>${l}</small><h2>${v ?? 0}</h2></div>`).join('');
  const days = s.tx_by_day || [];
  const max = Math.max(1, ...days.map(d => d.n));
  document.getElementById('sparkline').innerHTML = days.length
    ? days.map(d => `<div title="${d.day} : ${d.n}" style="flex:1;background:var(--pine);border-radius:3px 3px 0 0;height:${(d.n / max) * 100}%"></div>`).join('')
    : '<p style="color:var(--muted);font-size:14px">Aucune transaction pour le moment — scanne ta première carte pour voir la courbe s\'animer.</p>';

  // Load Alerts
  const alerts = await api('/alerts').catch(() => []);
  const card = document.getElementById('alertsCard');
  if (alerts.length > 0) {
    card.style.display = 'block';
    document.getElementById('tAlerts').innerHTML = alerts.map(a => `<tr>
      <td>${new Date(a.created_at).toLocaleString('fr-FR')}</td>
      <td>${esc(a.first_name)} ${esc(a.last_name || '')}<br><small style="color:var(--muted)">${esc(a.serial_number)}</small></td>
      <td><b>${esc(a.type)}</b></td>
      <td>${esc(a.description)}</td>
    </tr>`).join('');
  } else {
    card.style.display = 'none';
  }
}

// ---------- programs ----------
function pTypeSwitch(){const t=pType.value;pStamps.style.display=t==='stamps'?'':'none';pPoints.style.display=t==='points'?'':'none'}
async function loadPrograms() {
  const list = await api('/programs');
  document.getElementById('programList').innerHTML = list.map(p => `
    <div class="card punch">
      <div style="border-radius:10px;padding:16px;margin-bottom:12px;background:${esc(p.card_design?.bg_color || '#16453a')};color:${esc(p.card_design?.text_color || '#fff')}">
        <b style="font-family:Sora">${esc(p.name)}</b>
        <div style="font-size:13px;opacity:.85;margin-top:4px">${p.type === 'stamps' ? `${p.stamps_required} tampons → ${esc(p.reward_label || 'récompense')}` : `1 € = ${p.points_per_unit} pt · ${p.points_for_reward} pts → ${esc(p.reward_label || 'récompense')}`}</div>
      </div>
      <div class="row" style="justify-content:space-between">
        <span class="pill ${p.active ? 'g' : 'n'}">${p.active ? 'Actif' : 'Inactif'} · ${p.cards} carte(s)</span>
        <div class="row" style="gap:8px">
          <button class="btn sm ghost" onclick="showQr('${p.id}','${esc(p.name)}')">QR d'inscription</button>
          <button class="btn sm ghost" onclick="editAutomations('${p.id}','${esc(p.name)}')">Automatisations</button>
          <button class="btn sm ghost" onclick="toggleProgram('${p.id}',${!p.active})">${p.active ? 'Désactiver' : 'Activer'}</button>
        </div>
      </div>
    </div>`).join('') || '<p style="color:var(--muted)">Aucun programme. Crée ta première carte de fidélité — c\'est parti en 30 secondes.</p>';
}
async function createProgram() {
  try {
    await api('/programs', { method: 'POST', body: {
      name: pName.value, type: pType.value,
      stamps_required: Number(pReq.value), reward_label: pReward.value,
      points_per_unit: Number(pRatio.value), points_for_reward: Number(pGoal.value),
      card_design: { bg_color: pBg.value, text_color: pFg.value } } });
    closeModal('mProgram'); loadPrograms(); toast('Programme créé ✔');
  } catch (e) { toast(e.message, 1); }
}
async function toggleProgram(id, active) {
  await api('/programs/' + id, { method: 'PATCH', body: { active } }); loadPrograms();
}
async function showQr(id, name) {
  const res = await fetch(API + '/programs/' + id + '/qr', { headers: { Authorization: 'Bearer ' + TOKEN } });
  const blob = await res.blob();
  document.getElementById('qrImg').src = URL.createObjectURL(blob);
  document.getElementById('qrTitle').textContent = name;
  const link = location.origin + '/join/' + id;
  const a = document.getElementById('qrLink'); a.href = link; a.textContent = link;
  
  document.getElementById('btnKiosk').onclick = () => window.open(link + '?mode=kiosk', '_blank');
  document.getElementById('btnPdf').onclick = async () => {
    try {
      const r = await fetch(API + '/programs/' + id + '/chevalet', { headers: { Authorization: 'Bearer ' + TOKEN } });
      if (!r.ok) throw new Error('Erreur ' + r.status);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'chevalet.html'; a.click();
      URL.revokeObjectURL(url);
    } catch(e) { toast(e.message, 1); }
  };

  openModal('mQr');
}

let currentProgramId = null;
async function editAutomations(id, name) {
  try {
    currentProgramId = id;
    document.getElementById('maTitle').textContent = 'Automatisations - ' + name;
    const p = await api('/programs/' + id);
    const auto = p.automations || {};
    document.getElementById('maWelcomeOn').checked = !!auto.welcome?.active;
    document.getElementById('maWelcomeMsg').value = auto.welcome?.msg || '';
    document.getElementById('maWelcomeBonus').checked = !!auto.welcome?.bonus;
    document.getElementById('maBdayOn').checked = !!auto.birthday?.active;
    document.getElementById('maBdayMsg').value = auto.birthday?.msg || '';
    document.getElementById('maWinbackOn').checked = !!auto.winback?.active;
    document.getElementById('maWinbackMsg').value = auto.winback?.msg || '';
    document.getElementById('maReviewOn').checked = !!auto.review?.active;
    document.getElementById('maReviewMsg').value = auto.review?.msg || '';
    const multi = auto.multi_rewards || [];
    document.getElementById('maMultiRewards').value = multi.map(r => `${r.threshold} | ${r.label}`).join('\n');
    openModal('mAutomations');
  } catch(e) { toast(e.message, 1); }
}

async function saveAutomations() {
  try {
    const multi_rewards = document.getElementById('maMultiRewards').value
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.includes('|'))
      .map(line => {
        const [threshold, label] = line.split('|').map(s => s.trim());
        return { threshold: Number(threshold) || 1, label };
      })
      .sort((a, b) => a.threshold - b.threshold);

    const automations = {
      welcome: { 
        active: document.getElementById('maWelcomeOn').checked, 
        msg: document.getElementById('maWelcomeMsg').value,
        bonus: document.getElementById('maWelcomeBonus').checked
      },
      birthday: { active: document.getElementById('maBdayOn').checked, msg: document.getElementById('maBdayMsg').value },
      winback: { active: document.getElementById('maWinbackOn').checked, msg: document.getElementById('maWinbackMsg').value },
      review: { active: document.getElementById('maReviewOn').checked, msg: document.getElementById('maReviewMsg').value },
      multi_rewards
    };
    await api('/programs/' + currentProgramId, { method: 'PATCH', body: { automations } });
    closeModal('mAutomations');
    toast('Automatisations enregistrées ✔');
  } catch(e) { toast(e.message, 1); }
}

// ---------- customers ----------
async function loadCustomers() {
  const q = document.getElementById('custSearch').value;
  const list = await api('/customers' + (q ? '?q=' + encodeURIComponent(q) : ''));
  document.querySelector('#custTable tbody').innerHTML = list.map(c => {
    const p = c.passes[0] || {};
    const wallet = { apple: '<span class="pill g"> Apple</span>', google: '<span class="pill g">Google</span>',
      both: '<span class="pill g">Les deux</span>', none: '<span class="pill n">Non installée</span>' }[p.wallet || 'none'];
    return `<tr>
      <td><b>${esc(c.first_name)} ${esc(c.last_name || '')}</b><br><small style="color:var(--muted)">via ${esc(c.source)}</small></td>
      <td style="font-size:13px">${esc(c.email || '')}<br>${esc(c.phone || '')}</td>
      <td>${esc(p.program || '—')}</td>
      <td>${p.type === 'stamps' ? (p.stamps ?? 0) + ' tampons' : Number(p.points ?? 0) + ' pts'}${p.rewards > 0 ? ` <span class="pill a">${p.rewards} 🎁</span>` : ''}</td>
      <td>${p.type === 'stamps' ? (c.stamps_total || 0) : c.visits}</td>
      <td style="font-size:13px">${c.last_visit ? new Date(c.last_visit).toLocaleDateString('fr-FR') : '—'}</td>
      <td>${wallet}</td>
      <td><button class="btn sm ghost" onclick="showClient('${c.id}')">Détails</button>
          <button class="btn sm ghost" onclick="exportCust('${c.id}')">Export</button>
          <button class="btn sm ghost" style="color:var(--danger)" onclick="anonCust('${c.id}')">Anonymiser</button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" style="color:var(--muted)">Aucun client pour le moment. Affiche ton QR d\'inscription en caisse.</td></tr>';
}
function exportCust(id) {
  fetch(API + '/customers/' + id + '/export', { headers: { Authorization: 'Bearer ' + TOKEN } })
    .then(r => r.blob()).then(b => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'export-client.json'; a.click(); });
}
async function anonCust(id) {
  if (!confirm('Anonymiser ce client (RGPD) ? Cette action est irréversible.')) return;
  await api('/customers/' + id, { method: 'DELETE' }); loadCustomers(); toast('Client anonymisé');
}

let currentClientId = null;
async function showClient(id) {
  try {
    currentClientId = id;
    const c = await api('/customers/' + id);
    document.getElementById('mcName').textContent = c.first_name + ' ' + (c.last_name || '');
    document.getElementById('mcContact').textContent = (c.email || '') + (c.phone ? ' · ' + c.phone : '');
    const p = c.passes[0] || {};
    document.getElementById('mcStats').innerHTML = `
      <div class="card stat"><small>Points/Tamp.</small><h2>${p.type==='stamps' ? (p.stamps||0) : Number(p.points||0)}</h2></div>
      <div class="card stat"><small>Récompenses</small><h2>${p.rewards || 0}</h2></div>
      <div class="card stat"><small>Coches/Visites</small><h2>${p.type === 'stamps' ? (c.stamps_total || 0) : (c.visits || 0)}</h2></div>
      <div class="card stat"><small>Dépensé</small><h2>${Number(c.total_spent||0).toFixed(0)} €</h2></div>
    `;
    if (p.serial) {
      document.getElementById('mcLink').value = window.location.origin + '/card/' + p.serial;
    } else {
      document.getElementById('mcLink').value = 'Aucune carte active';
    }
    document.getElementById('mcNotifMsg').value = '';
    openModal('mClient');
  } catch(e) { toast(e.message, 1); }
}

function copyCardLink() {
  const link = document.getElementById('mcLink').value;
  if (link && link.startsWith('http')) {
    navigator.clipboard.writeText(link);
    toast('Lien copié dans le presse-papier !');
  }
}

async function sendNotifClient() {
  const msg = document.getElementById('mcNotifMsg').value;
  if(!msg) return toast("Message vide", 1);
  try {
    const res = await api('/customers/' + currentClientId + '/notify', { method:'POST', body:{message:msg}});
    toast('Notification envoyée à ' + res.passesUpdated + ' appareils !');
    closeModal('mClient');
  } catch(e) { toast(e.message, 1); }
}

async function sendNotifAll() {
  const msg = document.getElementById('mnaMsg').value;
  const target = document.getElementById('mnaTarget').value;
  if(!msg) return toast("Message vide", 1);
  try {
    const res = await api('/customers/notify_all', { method:'POST', body:{message:msg, target:target}});
    toast('Notification envoyée à ' + res.totalSent + ' appareils !');
    closeModal('mNotifyAll');
    document.getElementById('mnaMsg').value = '';
  } catch(e) { toast(e.message, 1); }
}

// ---------- transactions ----------
async function loadTx() {
  const list = await api('/transactions');
  const labels = { purchase: 'Achat', add_stamp: 'Tampon +', remove_stamp: 'Tampon −', add_points: 'Points +',
    remove_points: 'Points −', reward_redeemed: 'Récompense utilisée', adjustment: 'Ajustement' };
  document.querySelector('#txTable tbody').innerHTML = list.map(t => `<tr>
    <td style="font-size:13px">${new Date(t.created_at).toLocaleString('fr-FR')}</td>
    <td>${esc(t.first_name)} ${esc(t.last_name || '')}</td>
    <td>${esc(t.program_name)}</td>
    <td>${labels[t.type] || esc(t.type)}</td>
    <td>${t.amount ? Number(t.amount).toFixed(2) + ' €' : '—'}</td>
    <td>${t.stamps_delta ? t.stamps_delta + ' tampon' : ''}${Number(t.points_delta) ? Number(t.points_delta) + ' pts' : ''}</td>
    <td style="font-size:13px">${esc(t.staff_name || '—')}</td>
  </tr>`).join('') || '<tr><td colspan="7" style="color:var(--muted)">Aucune transaction.</td></tr>';
}

// ---------- statistiques ----------
async function loadStats() {
  const s = await api('/stats');
  document.getElementById('stCa').textContent = Number(s.total_amount||0).toFixed(2) + ' €';
  document.getElementById('stCust').textContent = s.total_customers || 0;
  document.getElementById('stNewCust').textContent = '+' + (s.new_customers_30d||0) + ' ces 30 derniers j';
  document.getElementById('stRewards').textContent = s.rewards_redeemed || 0;
  document.getElementById('stWallets').textContent = (s.apple_installs||0) + ' / ' + (s.google_installs||0) + ' / ' + (s.not_installed||0);
  
  // Tableau Top 5
  document.querySelector('#stTopCust tbody').innerHTML = (s.top_customers || []).map(c => `
    <tr>
      <td><b>${esc(c.first_name)} ${esc(c.last_name || '')}</b></td>
      <td>${Number(c.spent).toFixed(0)} €</td>
      <td>${c.stamps} t.</td>
    </tr>
  `).join('') || '<tr><td colspan="3">Aucun client</td></tr>';

  document.querySelector('#stTopVendors tbody').innerHTML = (s.vendor_stats || []).map(v => `
    <tr>
      <td><b>${esc(v.full_name || v.username)}</b></td>
      <td>${v.tx_count}</td>
      <td>${v.total_amount > 0 ? Number(v.total_amount).toFixed(0) + ' €' : ''} ${v.total_stamps > 0 ? `(${v.total_stamps} t.)` : ''}</td>
    </tr>
  `).join('') || '<tr><td colspan="3">Aucune activité</td></tr>';

  // Graphique
  const chart = document.getElementById('stChart');
  chart.innerHTML = '';
  if (s.tx_by_day && s.tx_by_day.length > 0) {
    const maxN = Math.max(...s.tx_by_day.map(d => d.n), 1);
    
    // Remplir les trous des 30 derniers jours
    const days = [];
    for(let i=29; i>=0; i--) {
      const d = new Date(); d.setDate(d.getDate()-i);
      const iso = d.toISOString().split('T')[0];
      const exist = s.tx_by_day.find(x => x.day.startsWith(iso));
      days.push({ day: iso, n: exist ? exist.n : 0 });
    }

    days.forEach(d => {
      const pct = (d.n / maxN) * 100;
      const bar = document.createElement('div');
      bar.style.flex = '1'; bar.style.backgroundColor = 'var(--pine)'; bar.style.height = pct + '%';
      bar.style.borderRadius = '3px 3px 0 0'; bar.style.minHeight = '2px';
      bar.title = `${d.n} passages le ${new Date(d.day).toLocaleDateString()}`;
      chart.appendChild(bar);
    });
    document.getElementById('stChartStart').textContent = new Date(days[0].day).toLocaleDateString('fr-FR', {day:'numeric', month:'short'});
    document.getElementById('stChartEnd').textContent = new Date(days[days.length-1].day).toLocaleDateString('fr-FR', {day:'numeric', month:'short'});
  } else {
    chart.innerHTML = '<div style="margin:auto;color:var(--muted)">Aucune activité récente</div>';
  }
}

// ---------- notifications ----------
async function loadNotifs() {
  const list = await api('/notifications');
  const typeLbl = { transactional: 'Transaction', automation: 'Automatique', manual: 'Manuel' };
  const statLbl = { simulated: '<span class="pill n">En attente / Simulé</span>', sent: '<span class="pill g">Envoyé</span>', failed: '<span class="pill a" style="background:#fcebe9;color:var(--danger)">Échec</span>' };
  const wLbl = { apple: 'Apple', google: 'Google', both: 'Les deux', none: 'Aucun' };
  document.querySelector('#notifTable tbody').innerHTML = list.map(n => `<tr>
    <td style="font-size:13px">${new Date(n.created_at).toLocaleString('fr-FR')}</td>
    <td>${esc(n.first_name)} ${esc(n.last_name || '')}</td>
    <td>${esc(n.message)}</td>
    <td>${typeLbl[n.type] || esc(n.type)}</td>
    <td>${wLbl[n.wallet_status] || esc(n.wallet_status)}</td>
    <td>${statLbl[n.status] || esc(n.status)}</td>
  </tr>`).join('') || '<tr><td colspan="6" style="color:var(--muted)">Aucune notification.</td></tr>';
}

// ---------- settings ----------
async function loadTeam() {
  const users = await api('/auth/users');
  document.getElementById('scannerLink').value = window.location.origin + '/scanner?t=' + (me.tenant_id || '');
  document.querySelector('#teamTable tbody').innerHTML = users.map(u => `<tr>
    <td>${esc(u.full_name)}</td>
    <td>${esc(u.username || u.email)}</td>
    <td>${esc(u.role)}</td>
    <td><button class="btn sm ghost" style="color:var(--danger)" onclick="delTeam('${u.id}')">Supprimer</button></td>
  </tr>`).join('');
}
async function addTeamMember() {
  try {
    await api('/auth/invite', { method: 'POST', body: {
      full_name: document.getElementById('tmName').value,
      username: document.getElementById('tmUser').value,
      password: document.getElementById('tmPass').value,
      role: document.getElementById('tmRole').value
    }});
    closeModal('mTeam'); toast('Membre ajouté'); loadTeam();
  } catch(e) { toast(e.message, 1); }
}
async function delTeam(id) {
  if(!confirm('Supprimer ce membre ?')) return;
  try { await api('/auth/users/'+id, {method:'DELETE'}); loadTeam(); } catch(e){ toast(e.message,1); }
}

function copyScannerLink() {
  const link = document.getElementById('scannerLink').value;
  if (link && link.startsWith('http')) {
    navigator.clipboard.writeText(link);
    toast('Lien copié dans le presse-papier !');
  }
}

async function loadBusiness() {
  const b = await api('/programs/business/profile');
  bName.value = b.name || ''; bColor.value = b.brand_color || '#16453a'; bText.value = b.text_color || '#ffffff';
  bPhone.value = b.phone || ''; bSite.value = b.website || ''; bReview.value = b.google_review_url || '';
  bLinks.value = (b.back_links || []).map(l => l.label + ' | ' + l.url).join('\n');
  const loc = await api('/programs/business/location').catch(()=>({}));
  bAddress.value = loc.address || ''; bLat.value = loc.latitude || ''; bLng.value = loc.longitude || ''; bRelText.value = loc.relevant_text || '';
  
  if (b.logo_url) {
    document.getElementById('bLogoPreview').src = b.logo_url;
    document.getElementById('bLogoPreview').style.display = 'block';
  }
  
  loadTeam();
}
async function saveBusiness() {
  const back_links = bLinks.value.split('\n').filter(Boolean).map(l => {
    const [label, url] = l.split('|').map(s => s.trim()); return { label, url };
  });
  await api('/programs/business/profile', { method: 'PATCH', body: {
    name: bName.value, brand_color: bColor.value, text_color: bText.value,
    phone: bPhone.value, website: bSite.value, google_review_url: bReview.value, back_links } });
    
  await api('/programs/business/location', { method: 'PATCH', body: {
    address: bAddress.value, latitude: bLat.value ? Number(bLat.value) : null, longitude: bLng.value ? Number(bLng.value) : null, relevant_text: bRelText.value } });
    
  toast('Commerce mis à jour ✔');
}

async function uploadLogo() {
  const file = document.getElementById('bLogo').files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('logo', file);
  
  try {
    const r = await fetch(API + '/upload/logo', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + TOKEN },
      body: formData
    });
    const res = await r.json();
    if (!r.ok) throw new Error(res.error || 'Erreur upload');
    document.getElementById('bLogoPreview').src = res.logo_url;
    document.getElementById('bLogoPreview').style.display = 'block';
    toast('Logo mis à jour avec succès');
  } catch(e) { toast(e.message, 1); }
}

// ---------- boot ----------
async function boot() {
  try {
    me = await api('/auth/me');
    document.getElementById('auth').style.display = 'none';
    document.getElementById('app').style.display = 'grid';
    const st = await api('/status');
    document.getElementById('cfgStatus').innerHTML =
      `<span>${st.apple_wallet ? '🟢' : '🟠'} Apple Wallet ${st.apple_wallet ? '' : '(certifs à installer)'}</span>` +
      `<span>${st.google_wallet ? '🟢' : '🟠'} Google Wallet</span>` +
      `<span>${st.stripe ? '🟢' : '🟠'} Stripe</span>`;
    loadHome();
  } catch { localStorage.removeItem('wf_token'); TOKEN = null; }
}
if (TOKEN) {
  boot();
} else {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.has('reset')) {
    document.getElementById('formLogin').style.display = 'none';
    document.getElementById('formReg').style.display = 'none';
    document.getElementById('formForgot').style.display = 'none';
    document.getElementById('formReset').style.display = '';
  }
}
