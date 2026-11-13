// Formula Home — shared platform helpers (auth state, nav, messages thread, formatting)
// legal link under every footer (app.js loads at the end of <body> on every page)
(function(){
  document.querySelectorAll('.foot-bottom').forEach(function(fb){
    if(fb.nextElementSibling && fb.nextElementSibling.classList.contains('foot-legal')) return;
    fb.insertAdjacentHTML('afterend', '<div class="foot-legal"><a href="legal.html" data-i18n="p.legal">Terms &amp; legal notice</a> · <a href="privacy.html" data-i18n="p.privacy">Privacy policy</a></div>');
  });
})();
const FH = (function(){
  const sb = supabaseClient;
  const KNOWN = ['not_authenticated','listing_unavailable','own_listing','past_dates','bad_dates','too_long','min_nights','bad_guests','no_price','dates_blocked','dates_taken','duplicate_request','too_many_requests','forbidden','bad_state','not_found','not_accepted','not_completed','bad_rating','already_reviewed','bad_action','status_locked','not_paid','already_paid','pay_expired','no_listing','unknown_country'];

  function circuitOf(name){ try{ return (window.RACES || []).find(r => r.circuit === name) || null; }catch(e){ return null; } }
  // Opens a map only on demand (modal) centred on one listing, with its circuit marked.
  function showMap(o){
    if(!window.L) return;
    const ov = document.createElement('div'); ov.className = 'map-modal';
    ov.innerHTML = '<div class="map-box" role="dialog" aria-modal="true"><button class="map-close" type="button" aria-label="Close">×</button><div class="map-title"></div><div class="map-canvas"></div></div>';
    ov.querySelector('.map-title').textContent = o.title || '';
    document.body.appendChild(ov);
    let m = null;
    const onKey = (e) => { if(e.key === 'Escape') close(); };
    function close(){ document.removeEventListener('keydown', onKey); if(m) m.remove(); ov.remove(); }
    ov.addEventListener('click', (e) => { if(e.target === ov || e.target.closest('.map-close')) close(); });
    document.addEventListener('keydown', onKey);
    m = L.map(ov.querySelector('.map-canvas')).setView([o.lat, o.lng], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors', maxZoom: 18 }).addTo(m);
    L.marker([o.lat, o.lng]).addTo(m).bindPopup(esc(o.title || '')).openPopup();
    const c = o.circuit;
    if(c && c.lat != null){
      L.marker([c.lat, c.lng], { icon: L.divIcon({ className: '', html: '<div style="width:16px;height:16px;background:#e3151f;border:2px solid #fff;border-radius:50%;"></div>', iconSize: [16, 16] }) }).addTo(m).bindPopup('<b>' + esc(c.circuit || c.name || '') + '</b>');
      m.fitBounds(L.latLngBounds([[o.lat, o.lng], [c.lat, c.lng]]).pad(0.4), { maxZoom: 14 });
    }
    setTimeout(() => m.invalidateSize(), 60);
  }

  function demoOn(){
    try{
      const q = new URLSearchParams(location.search).get('demo');
      if(q === '1') sessionStorage.removeItem('fh_demo');
      if(q === '0') sessionStorage.setItem('fh_demo', '0');
      return sessionStorage.getItem('fh_demo') !== '0';
    }catch(e){ return new URLSearchParams(location.search).get('demo') !== '0'; }
  }

  // Calls the "payments" Edge Function (Stripe). Returns { data, error }.
  async function pay(action, extra){
    const { data, error } = await sb.functions.invoke('payments', { body: Object.assign({ action }, extra || {}) });
    if(error){
      let msg = error.message;
      try { const j = await error.context.json(); if(j && j.error) msg = j.error; } catch(e){}
      return { data: null, error: { message: msg } };
    }
    return { data, error: null };
  }
  function payBadge(ps){ return '<span class="badge b-pay-' + esc(ps) + '">' + esc(t('pay.st.' + ps)) + '</span>'; }
  function testBanner(){ return '<div class="test-banner">' + esc(t('pay.testBanner')) + '</div>'; }

  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function errText(e){
    const m = (e && e.message) || String(e || '');
    for(const k of KNOWN){ if(m.indexOf(k) >= 0) return t('err.' + k); }
    if(/Invalid login/i.test(m)) return t('err.invalid_login');
    if(/not confirmed/i.test(m)) return t('err.not_confirmed');
    if(/already registered|already been registered/i.test(m)) return t('err.already_registered');
    if(/Password should be|at least 8/i.test(m)) return t('err.weak_password');
    if(/rate limit|too many/i.test(m)) return t('err.rate_limit');
    return m;
  }

  let _user; let _userLoaded = false;
  async function user(){
    if(_userLoaded) return _user;
    const { data } = await sb.auth.getSession();
    _user = (data && data.session && data.session.user) || null;
    _userLoaded = true;
    return _user;
  }
  sb.auth.onAuthStateChange((evt, session) => { _user = (session && session.user) || null; _userLoaded = true; });

  async function profile(){
    const u = await user(); if(!u) return null;
    const { data } = await sb.from('profiles').select('id, full_name, phone, is_admin').eq('id', u.id).maybeSingle();
    return data;
  }
  function pageName(){ return location.pathname.split('/').pop() || 'index.html'; }
  async function requireAuth(){
    const u = await user();
    if(!u){ location.href = 'auth.html?next=' + encodeURIComponent(pageName() + location.search); return null; }
    return u;
  }

  // dates are plain YYYY-MM-DD strings (no timezone shifts)
  function parseD(s){ return new Date(s + 'T00:00:00'); }
  function today(){ const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); }
  function fmtD(s){
    const lang = getLang() === 'zh' ? 'zh-CN' : getLang();
    return parseD(s).toLocaleDateString(lang, { day:'numeric', month:'short', year:'numeric' });
  }
  function nightsBetween(a, b){ return Math.round((parseD(b) - parseD(a)) / 86400000); }
  function money(amount, cur){
    try { return new Intl.NumberFormat(undefined, { style:'currency', currency: cur, maximumFractionDigits: 0 }).format(amount); }
    catch(e){ return Math.round(amount) + ' ' + cur; }
  }

  function toast(el, msg, ok){
    if(!el) return;
    el.textContent = msg || '';
    el.className = 'status-msg ' + (ok ? 'ok' : 'err');
  }
  function badge(status){ return '<span class="badge b-' + esc(status) + '">' + esc(t('st.' + status)) + '</span>'; }

  // ---- nav: inject account link ----
  async function initNav(){
    const u = await user();
    let admin = false;
    if(u){ const p = await profile(); admin = !!(p && p.is_admin); }
    const href = u ? 'account.html' : 'auth.html';
    const key = u ? 'p.account' : 'p.login';
    const right = document.querySelector('.nav-right');
    const mobile = document.getElementById('mobile-menu');
    if(right && !right.querySelector('.fh-acct')){
      if(admin){ const a = document.createElement('a'); a.className = 'btn btn-ghost btn-small fh-acct'; a.href = 'admin.html'; a.setAttribute('data-i18n','p.admin'); right.appendChild(a); }
      const a = document.createElement('a'); a.className = 'btn btn-small fh-acct'; a.href = href; a.setAttribute('data-i18n', key); right.appendChild(a);
    }
    if(mobile && !mobile.querySelector('.fh-acct')){
      if(admin){ const a = document.createElement('a'); a.className = 'fh-acct'; a.href = 'admin.html'; a.setAttribute('data-i18n','p.admin'); mobile.appendChild(a); }
      const a = document.createElement('a'); a.className = 'fh-acct'; a.href = href; a.setAttribute('data-i18n', key); mobile.appendChild(a);
    }
    applyI18n();
  }

  // ---- language / currency / burger wiring shared by every page ----
  function wire(){
    const burger = document.getElementById('burger');
    if(burger) burger.addEventListener('click', () => document.getElementById('mobile-menu').classList.toggle('open'));
    applyI18n();
    const langSelects = [document.getElementById('lang-select'), document.getElementById('lang-select-mobile')].filter(Boolean);
    const curSelects = [document.getElementById('currency-select'), document.getElementById('currency-select-mobile')].filter(Boolean);
    langSelects.forEach(sel => { sel.value = getLang(); sel.addEventListener('change', () => {
      setLang(sel.value); langSelects.forEach(s => s.value = sel.value);
      if(typeof window.onLangChange === 'function') window.onLangChange();
    }); });
    curSelects.forEach(sel => { sel.value = getDisplayCurrency(); sel.addEventListener('change', () => {
      setDisplayCurrency(sel.value); curSelects.forEach(s => s.value = sel.value);
      if(typeof window.onCurrencyChange === 'function') window.onCurrencyChange();
    }); });
    if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initNav); else initNav();
  }

  // ---- messages thread (booking chat) ----
  function thread(el, bookingId, canWrite){
    el.innerHTML = '<div class="th-list" aria-live="polite"></div>' +
      (canWrite ? '<form class="th-form"><input type="text" maxlength="2000" required placeholder="' + esc(t('p.th.ph')) + '"><button class="btn btn-small" type="submit">' + esc(t('p.th.send')) + '</button></form>' : '');
    const list = el.querySelector('.th-list');
    let timer = null, me = null, lastCount = -1;
    async function load(){
      const { data, error } = await sb.from('messages').select('id, sender_id, body, created_at').eq('booking_id', bookingId).order('created_at', { ascending: true });
      if(error){ list.textContent = errText(error); return; }
      if(data.length === lastCount) return;
      lastCount = data.length;
      list.innerHTML = data.length ? data.map(m => '<div class="th-msg ' + (m.sender_id === me ? 'mine' : 'theirs') + '"><div class="th-body">' + esc(m.body) + '</div><div class="th-time">' + esc(new Date(m.created_at).toLocaleString(getLang() === 'zh' ? 'zh-CN' : getLang(), { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' })) + '</div></div>').join('') : '<div class="th-empty">' + esc(t('p.th.empty')) + '</div>';
      list.scrollTop = list.scrollHeight;
    }
    (async () => {
      const u = await user(); me = u && u.id;
      await load();
      timer = setInterval(() => { if(!document.body.contains(el)) { clearInterval(timer); return; } load(); }, 8000);
    })();
    const form = el.querySelector('.th-form');
    if(form){
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = form.querySelector('input'); const body = input.value.trim(); if(!body) return;
        input.disabled = true;
        const { error } = await sb.from('messages').insert({ booking_id: bookingId, sender_id: me, body });
        input.disabled = false;
        if(error){ list.insertAdjacentHTML('beforeend', '<div class="th-empty">' + esc(errText(error)) + '</div>'); return; }
        input.value = ''; lastCount = -1; await load();
      });
    }
    return { stop(){ clearInterval(timer); } };
  }

  // ---- image helper: resize to max 1600px JPEG before upload ----
  function resizeImage(file, maxSide){
    return new Promise((resolve, reject) => {
      const img = new Image(); const url = URL.createObjectURL(file);
      img.onload = () => {
        const k = Math.min(1, (maxSide || 1600) / Math.max(img.width, img.height));
        const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        c.toBlob(b => { URL.revokeObjectURL(url); b ? resolve(b) : reject(new Error('image')); }, 'image/jpeg', 0.82);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image')); };
      img.src = url;
    });
  }

  // columns safe to read publicly from listings (never contact data)
  const LISTING_COLS = 'id, created_at, name, title, city, country, circuit, lat, lng, price_per_night, currency, capacity, description, house_rules, rules, amenities, min_nights, photo_urls, owner_id, status, is_demo, host_bio, host_langs, host_since, host_photo';


  // simple checkbox options for hosts (key, icon). Labels live in i18n as 'ft.<key>'
  const RULES = [['no_smoking','🚭'],['no_pets','🐾'],['no_parties','🎉'],['quiet_hours','🌙'],['no_extra_guests','👥'],['shoes_off','👟']];
  const AMENITIES = [['parking','🚗'],['pets_ok','🐶'],['wifi','📶'],['ac','❄️'],['kitchen','🍳'],['washer','🧺'],['tv','📺'],['breakfast','☕'],['pool','🏊'],['shuttle','🚌'],['near_circuit','🏁'],['private_bath','🚿']];
  function featureChips(keys, defs){
    const set = new Set(keys || []);
    return defs.filter(d => set.has(d[0])).map(d => '<span class="ft-chip"><span class="ft-ic">' + d[1] + '</span>' + esc(window.t ? window.t('ft.' + d[0]) : d[0]) + '</span>').join('');
  }

  // rating helpers (1-5 scale, Booking-style label)
  function ratingKey(avg){ return avg >= 4.5 ? 'p.rt.great' : avg >= 4 ? 'p.rt.verygood' : avg >= 3 ? 'p.rt.good' : 'p.rt.fair'; }
  function ratingBadge(avg, n){
    if(!n) return '<span class="rt-new">' + esc(window.t('p.rt.new')) + '</span>';
    return '<span class="rt-badge"><span class="rt-score">' + Number(avg).toFixed(1) + '</span><span class="rt-txt"><b>' + esc(window.t(ratingKey(avg))) + '</b><small>' + esc(window.t('p.rt.count', { n })) + '</small></span></span>';
  }
  async function ratingMap(){
    try { const r = await sb.rpc('host_rating_summary'); const m = {}; (r.data || []).forEach(x => { m[x.host_id] = { avg: Number(x.avg_rating), n: x.review_count }; }); return m; } catch(e){ return {}; }
  }

  // contact details as safe HTML (method/value of a host, or email/phone of a guest)
  function contactHtml(c){
    if(!c) return '';
    const parts = [];
    if(c.name) parts.push('<b>' + esc(c.name) + '</b>');
    if(c.method && c.value){
      const v = String(c.value); let href = '#', label = v;
      if(c.method === 'whatsapp'){ href = 'https://wa.me/' + v.replace(/[^\d]/g, ''); label = 'WhatsApp ' + v; }
      else if(c.method === 'email'){ href = 'mailto:' + v; label = v; }
      else if(c.method === 'instagram'){ href = 'https://instagram.com/' + v.replace('@', ''); label = 'Instagram ' + v; }
      parts.push('<a href="' + esc(href) + '" target="_blank" rel="noopener" style="text-decoration:underline">' + esc(label) + '</a>');
    }
    if(c.email && !(c.method === 'email')) parts.push('<a href="mailto:' + esc(c.email) + '" style="text-decoration:underline">' + esc(c.email) + '</a>');
    if(c.phone) parts.push('<a href="tel:' + esc(String(c.phone).replace(/[^\d+]/g, '')) + '" style="text-decoration:underline">' + esc(c.phone) + '</a>');
    return parts.join(' · ');
  }
  function safeNext(n){ return /^[a-z0-9_\-]+\.html(\?[a-z0-9_=&\-%.]*)?$/i.test(n || '') ? n : 'account.html'; }

  return { showMap, circuitOf, demoOn, pay, payBadge, testBanner, initNav, contactHtml, safeNext, sb, esc, errText, user, profile, requireAuth, today, parseD, fmtD, nightsBetween, money, toast, badge, wire, thread, resizeImage, LISTING_COLS, RULES, AMENITIES, featureChips, ratingBadge, ratingMap, ratingKey };
})();
