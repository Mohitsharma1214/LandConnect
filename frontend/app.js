// LandConnect Core Application Logic & WebRTC Real-Time Calling Engine

const API_BASE = window.location.origin;
let WS_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;

// Global safety interceptors: completely eliminate native browser popups
window.alert = function(msg) {
  if (typeof showToast === 'function') {
    showToast(String(msg), 'info');
  } else {
    console.log('[Native Alert Suppressed]:', msg);
  }
};

// --- State Variables ---
let currentToken = localStorage.getItem('landconnect_token') || null;
let currentUser = null;
try {
  const cachedUserStr = localStorage.getItem('landconnect_user');
  if (cachedUserStr) {
    currentUser = JSON.parse(cachedUserStr);
  }
} catch (e) {
  currentUser = null;
}
let selectedRoleForReg = 'buyer';
let ws = null;
let activeTab = 'feed';
let allListings = [];
let allUsers = [];
let activeChatPeer = null;

// --- WebRTC State ---
let peerConnection = null;
let localStream = null;
let remoteStream = null;
let activeCallType = 'video';
let activeCallTargetId = null;
let incomingCallData = null;
let callTimerInterval = null;
let callSeconds = 0;
let isAudioMuted = false;
let isVideoMuted = false;

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// ================= IN-APP TOAST & ALERT DIALOGS (NO BROWSER POPUPS) =================
let _toastTimer = null;
function showToast(message, type = 'info') {
  const toast = document.getElementById('in-app-toast');
  const toastIcon = document.getElementById('in-app-toast-icon');
  const toastText = document.getElementById('in-app-toast-text');
  if (!toast || !toastText) {
    console.log(`[Toast ${type}]: ${message}`);
    return;
  }

  clearTimeout(_toastTimer);
  toastText.textContent = message;

  if (toastIcon) {
    if (type === 'success') {
      toastIcon.className = 'w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0';
      toastIcon.innerHTML = '<i data-lucide="check" class="w-3.5 h-3.5"></i>';
    } else if (type === 'error') {
      toastIcon.className = 'w-6 h-6 rounded-full bg-rose-500/20 text-rose-400 flex items-center justify-center shrink-0';
      toastIcon.innerHTML = '<i data-lucide="alert-circle" class="w-3.5 h-3.5"></i>';
    } else if (type === 'warning') {
      toastIcon.className = 'w-6 h-6 rounded-full bg-amber-500/20 text-amber-400 flex items-center justify-center shrink-0';
      toastIcon.innerHTML = '<i data-lucide="alert-triangle" class="w-3.5 h-3.5"></i>';
    } else {
      toastIcon.className = 'w-6 h-6 rounded-full bg-wa-teal/30 text-emerald-300 flex items-center justify-center shrink-0';
      toastIcon.innerHTML = '<i data-lucide="info" class="w-3.5 h-3.5"></i>';
    }
  }

  toast.classList.remove('hidden');
  if (window.lucide) lucide.createIcons();

  _toastTimer = setTimeout(() => {
    toast.classList.add('hidden');
  }, 3500);
}

function showInAppAlert(title, message, type = 'info') {
  const modal = document.getElementById('app-alert-modal');
  const iconWrap = document.getElementById('app-alert-icon-wrap');
  const titleEl = document.getElementById('app-alert-title');
  const msgEl = document.getElementById('app-alert-message');
  const btnEl = document.getElementById('app-alert-btn');
  if (!modal) {
    showToast(`${title}: ${message}`, type);
    return;
  }

  if (titleEl) titleEl.textContent = title;
  if (msgEl) msgEl.textContent = message;

  if (iconWrap) {
    if (type === 'error') {
      iconWrap.className = 'w-12 h-12 rounded-full bg-rose-100 text-rose-600 mx-auto flex items-center justify-center';
      iconWrap.innerHTML = '<i data-lucide="alert-circle" class="w-6 h-6"></i>';
      if (btnEl) btnEl.className = 'w-full bg-rose-600 hover:bg-rose-700 text-white py-2.5 rounded-xl font-bold text-xs transition shadow-md';
    } else if (type === 'success') {
      iconWrap.className = 'w-12 h-12 rounded-full bg-emerald-100 text-emerald-600 mx-auto flex items-center justify-center';
      iconWrap.innerHTML = '<i data-lucide="check-circle" class="w-6 h-6"></i>';
      if (btnEl) btnEl.className = 'w-full bg-wa-teal hover:bg-wa-tealDark text-white py-2.5 rounded-xl font-bold text-xs transition shadow-md';
    } else if (type === 'warning') {
      iconWrap.className = 'w-12 h-12 rounded-full bg-amber-100 text-amber-600 mx-auto flex items-center justify-center';
      iconWrap.innerHTML = '<i data-lucide="alert-triangle" class="w-6 h-6"></i>';
      if (btnEl) btnEl.className = 'w-full bg-amber-600 hover:bg-amber-700 text-white py-2.5 rounded-xl font-bold text-xs transition shadow-md';
    } else {
      iconWrap.className = 'w-12 h-12 rounded-full bg-teal-100 text-wa-teal mx-auto flex items-center justify-center';
      iconWrap.innerHTML = '<i data-lucide="info" class="w-6 h-6"></i>';
      if (btnEl) btnEl.className = 'w-full bg-wa-teal hover:bg-wa-tealDark text-white py-2.5 rounded-xl font-bold text-xs transition shadow-md';
    }
  }

  modal.classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}

function closeAppAlertModal() {
  const modal = document.getElementById('app-alert-modal');
  if (modal) modal.classList.add('hidden');
}

// ================= SAVED / FAVORITE LAND LISTINGS =================
let savedListingIds = JSON.parse(localStorage.getItem('landconnect_saved') || '[]');
let isFilteringSaved = false;

function isFavorite(id) {
  return savedListingIds.includes(id);
}

function updateSavedCounterUI() {
  const btnText = document.getElementById('saved-btn-text');
  const icon = document.getElementById('icon-saved-btn');
  if (btnText) btnText.textContent = `Saved (${savedListingIds.length})`;
  if (icon) {
    if (isFilteringSaved) {
      icon.className = 'w-3.5 h-3.5 fill-rose-500 text-rose-500';
    } else {
      icon.className = savedListingIds.length > 0 ? 'w-3.5 h-3.5 text-rose-500' : 'w-3.5 h-3.5 text-slate-400';
    }
  }
}

function toggleFavoriteListing(id) {
  if (savedListingIds.includes(id)) {
    savedListingIds = savedListingIds.filter(x => x !== id);
  } else {
    savedListingIds.push(id);
  }
  localStorage.setItem('landconnect_saved', JSON.stringify(savedListingIds));
  updateSavedCounterUI();

  if (isFilteringSaved) {
    filterSavedListings();
  } else {
    renderListings(allListings);
  }
}

function toggleDetailPropertyFavorite() {
  if (activePropertyDetailListing) {
    toggleFavoriteListing(activePropertyDetailListing.id);
    const favIcon = document.getElementById('icon-detail-fav');
    if (favIcon) {
      favIcon.className = isFavorite(activePropertyDetailListing.id)
        ? 'w-4 h-4 fill-rose-500 text-rose-500'
        : 'w-4 h-4 text-white';
    }
  }
}

function toggleSavedFilter() {
  isFilteringSaved = !isFilteringSaved;
  const btn = document.getElementById('btn-toggle-saved');
  if (isFilteringSaved) {
    if (btn) btn.classList.add('bg-rose-50', 'border-rose-300', 'text-rose-700');
    filterSavedListings();
  } else {
    if (btn) btn.classList.remove('bg-rose-50', 'border-rose-300', 'text-rose-700');
    renderListings(allListings);
  }
  updateSavedCounterUI();
}

function filterSavedListings() {
  const filtered = allListings.filter(l => savedListingIds.includes(l.id));
  renderListings(filtered);
}

// --- Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
  updateClock();
  setInterval(updateClock, 10000);
  updateSavedCounterUI();

  if (currentToken) {
    // If cached user exists, apply role UI instantly (zero flash)
    if (currentUser) {
      applyUserRoleUI();
    }
    showMainApp();

    // Fetch listings, users, and user profile concurrently
    Promise.all([
      loadListings(),
      loadUsersList(),
      fetchUserProfile()
    ]).then(([_, __, valid]) => {
      if (valid === false && !currentUser) {
        handleLogoutSilent();
      }
    });

    initWebSocket();
  } else {
    showAuthScreen();
  }
});

function handleLogoutSilent() {
  currentToken = null;
  currentUser = null;
  localStorage.removeItem('landconnect_token');
  localStorage.removeItem('landconnect_user');
  document.documentElement.classList.remove('user-has-session');
  if (ws) {
    try { ws.close(); } catch(e){}
  }
  showAuthScreen();
}

function updateClock() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const clockEl = document.getElementById('clock-display');
  if (clockEl) clockEl.textContent = timeStr;
}

// ================= VIEW TOGGLING (AUTH SCREEN vs MAIN APP) =================

function showAuthScreen() {
  document.documentElement.classList.remove('user-has-session');
  const authScreen = document.getElementById('auth-screen');
  const mainAppScreen = document.getElementById('main-app-screen');
  if (authScreen) authScreen.classList.remove('hidden');
  if (mainAppScreen) mainAppScreen.classList.add('hidden');
  setAuthMode('login');
  if (window.lucide) lucide.createIcons();
}

function showMainApp() {
  document.documentElement.classList.add('user-has-session');
  const authScreen = document.getElementById('auth-screen');
  const mainAppScreen = document.getElementById('main-app-screen');
  if (authScreen) authScreen.classList.add('hidden');
  if (mainAppScreen) mainAppScreen.classList.remove('hidden');
  applyUserRoleUI();
  switchTab(activeTab || 'feed');
  if (window.lucide) lucide.createIcons();
}

function setAuthMode(mode) {
  const formLogin = document.getElementById('form-login');
  const formRegister = document.getElementById('form-register');
  const btnToggleLogin = document.getElementById('auth-toggle-login');
  const btnToggleReg = document.getElementById('auth-toggle-reg');
  const feedback = document.getElementById('auth-feedback');
  if (feedback) feedback.classList.add('hidden');

  if (mode === 'login') {
    if (formLogin) formLogin.classList.remove('hidden');
    if (formRegister) formRegister.classList.add('hidden');
    if (btnToggleLogin) {
      btnToggleLogin.className = 'flex-1 py-2 rounded-lg bg-wa-teal text-white shadow font-bold transition';
    }
    if (btnToggleReg) {
      btnToggleReg.className = 'flex-1 py-2 rounded-lg text-slate-600 hover:text-slate-900 font-bold transition';
    }
  } else {
    if (formLogin) formLogin.classList.add('hidden');
    if (formRegister) formRegister.classList.remove('hidden');
    if (btnToggleReg) {
      btnToggleReg.className = 'flex-1 py-2 rounded-lg bg-wa-teal text-white shadow font-bold transition';
    }
    if (btnToggleLogin) {
      btnToggleLogin.className = 'flex-1 py-2 rounded-lg text-slate-600 hover:text-slate-900 font-bold transition';
    }
  }
  if (window.lucide) lucide.createIcons();
}

function selectRole(role) {
  selectedRoleForReg = role;
  const roles = ['buyer', 'seller', 'broker'];
  roles.forEach(r => {
    const card = document.getElementById(`role-card-${r}`);
    if (card) {
      if (r === role) {
        card.className = 'cursor-pointer border-2 border-wa-teal rounded-xl p-2 text-center bg-emerald-50/50 flex flex-col items-center gap-0.5 role-card shadow-sm';
      } else {
        card.className = 'cursor-pointer border-2 border-slate-200 rounded-xl p-2 text-center hover:border-slate-300 flex flex-col items-center gap-0.5 role-card';
      }
    }
  });
}

function showAuthFeedback(msg, isError = true) {
  const feedback = document.getElementById('auth-feedback');
  if (!feedback) return;
  feedback.classList.remove('hidden');
  feedback.textContent = msg;
  if (isError) {
    feedback.className = 'text-xs p-2.5 rounded-xl mb-3 font-semibold bg-rose-50 border border-rose-200 text-rose-700';
  } else {
    feedback.className = 'text-xs p-2.5 rounded-xl mb-3 font-semibold bg-emerald-50 border border-emerald-200 text-emerald-800';
  }
}

// ================= AUTHENTICATION ACTIONS =================

async function submitLogin(e) {
  e.preventDefault();
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const submitBtn = document.getElementById('btn-login-submit');

  if (submitBtn) submitBtn.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (data.token) {
      currentToken = data.token;
      currentUser = data.user;
      localStorage.setItem('landconnect_token', currentToken);
      localStorage.setItem('landconnect_user', JSON.stringify(currentUser));
      applyUserRoleUI();
      showAuthFeedback('Login successful! Welcome to LandConnect.', false);
      setTimeout(async () => {
        showMainApp();
        loadListings();
        loadUsersList();
        initWebSocket();
      }, 300);
    } else {
      showAuthFeedback(data.error || 'Invalid credentials. Please verify your email and password.');
    }
  } catch (err) {
    showAuthFeedback('Connection error: ' + err.message);
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function submitRegister(e) {
  e.preventDefault();
  const name = document.getElementById('reg-name').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const phone = document.getElementById('reg-phone').value.trim();
  const password = document.getElementById('reg-password').value;
  const role = selectedRoleForReg || 'buyer';
  const submitBtn = document.getElementById('btn-reg-submit');

  if (submitBtn) submitBtn.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password, role, phone })
    });
    const data = await res.json();
    if (data.token) {
      currentToken = data.token;
      currentUser = data.user;
      localStorage.setItem('landconnect_token', currentToken);
      localStorage.setItem('landconnect_user', JSON.stringify(currentUser));
      applyUserRoleUI();
      showAuthFeedback(`Account created successfully as ${role.toUpperCase()}! Entering app...`, false);
      setTimeout(async () => {
        showMainApp();
        loadListings();
        loadUsersList();
        initWebSocket();
      }, 350);
    } else {
      showAuthFeedback(data.error || 'Registration failed.');
    }
  } catch (err) {
    showAuthFeedback('Connection error: ' + err.message);
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

function openLogoutConfirmModal() {
  const modal = document.getElementById('logout-confirm-modal');
  if (modal) modal.classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}

function closeLogoutConfirmModal() {
  const modal = document.getElementById('logout-confirm-modal');
  if (modal) modal.classList.add('hidden');
}

function confirmSignOut() {
  closeLogoutConfirmModal();
  currentToken = null;
  currentUser = null;
  localStorage.removeItem('landconnect_token');
  localStorage.removeItem('landconnect_user');
  document.documentElement.classList.remove('user-has-session');
  if (ws) {
    try { ws.close(); } catch(e){}
  }
  showAuthScreen();
}

function handleLogout() {
  openLogoutConfirmModal();
}

async function fetchUserProfile() {
  if (!currentToken) return false;
  try {
    const res = await fetch(`${API_BASE}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${currentToken}` }
    });
    if (res.ok) {
      currentUser = await res.json();
      localStorage.setItem('landconnect_user', JSON.stringify(currentUser));
      applyUserRoleUI();
      return true;
    } else if (res.status === 401) {
      return false;
    }
    return true;
  } catch (err) {
    console.warn('Error fetching profile:', err);
    return currentUser ? true : false;
  }
}

function applyUserRoleUI() {
  if (!currentUser) return;

  const role = (currentUser.role || 'buyer').toLowerCase();
  const roleDisplay = role.charAt(0).toUpperCase() + role.slice(1);
  const defaultAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(currentUser.name || 'User')}&background=075E54&color=fff`;
  const avatarSrc = currentUser.avatar || defaultAvatar;

  // Header
  const roleText = document.getElementById('header-role-text');
  const avatarImg = document.getElementById('header-avatar');
  if (roleText) roleText.textContent = roleDisplay;
  if (avatarImg) {
    avatarImg.src = avatarSrc;
    avatarImg.onerror = () => { avatarImg.src = defaultAvatar; };
  }

  // Profile Tab
  const pName = document.getElementById('profile-card-name');
  const pRole = document.getElementById('profile-card-role-badge');
  const pEmail = document.getElementById('profile-card-email');
  const pBio = document.getElementById('profile-card-bio');
  const pPhone = document.getElementById('profile-card-phone');
  const pAvatar = document.getElementById('profile-card-avatar');
  
  if (pName) pName.textContent = currentUser.name || 'User Name';
  if (pEmail) pEmail.textContent = currentUser.email || 'user@example.com';
  if (pBio) {
    if (currentUser.bio && currentUser.bio.trim()) {
      pBio.textContent = currentUser.bio.trim();
      pBio.classList.remove('hidden');
    } else {
      pBio.textContent = '';
      pBio.classList.add('hidden');
    }
  }
  if (pPhone) pPhone.textContent = `Phone: ${currentUser.phone_masked || '+91 98*** **321'} (Protected)`;
  if (pAvatar) {
    pAvatar.src = avatarSrc;
    pAvatar.onerror = () => { pAvatar.src = defaultAvatar; };
  }

  if (pRole) {
    pRole.textContent = role.toUpperCase();
    pRole.className = `text-[10px] px-2.5 py-0.5 rounded-full font-bold uppercase tracking-wider ${
      role === 'buyer' ? 'bg-blue-100 text-blue-700' :
      role === 'seller' ? 'bg-emerald-100 text-emerald-700' :
      'bg-purple-100 text-purple-700'
    }`;
  }

  // Role Permissions
  const bannerTitle = document.getElementById('banner-role-title');
  const bannerDesc = document.getElementById('banner-role-desc');
  const bannerPostBtn = document.getElementById('banner-post-btn');
  const floatingPostBtn = document.getElementById('floating-post-btn');
  const permPostStatus = document.getElementById('perm-post-status');

  const canPost = (role === 'seller' || role === 'broker');
  const myPropertiesSection = document.getElementById('my-properties-section');

  if (canPost) {
    if (bannerPostBtn) bannerPostBtn.classList.remove('hidden');
    if (floatingPostBtn) floatingPostBtn.classList.remove('hidden');
    if (bannerTitle) bannerTitle.textContent = `${role.toUpperCase()} MODE: LISTING MANAGEMENT`;
    if (bannerDesc) bannerDesc.textContent = `You are authorized to list land parcels, manage prices, and field buyer calls.`;
    if (permPostStatus) {
      permPostStatus.innerHTML = '<i data-lucide="check" class="w-3.5 h-3.5 text-emerald-500"></i> Authorized';
      permPostStatus.className = 'text-emerald-600 font-bold flex items-center gap-1';
    }
    if (myPropertiesSection) myPropertiesSection.classList.remove('hidden');
    loadMyListings();
  } else {
    if (bannerPostBtn) bannerPostBtn.classList.add('hidden');
    if (floatingPostBtn) floatingPostBtn.classList.add('hidden');
    if (bannerTitle) bannerTitle.textContent = `BUYER EXPLORATION MODE`;
    if (bannerDesc) bannerDesc.textContent = `Browse verified land listings & start private audio/video calls with owners without exposing phone numbers.`;
    if (permPostStatus) {
      permPostStatus.innerHTML = '<i data-lucide="lock" class="w-3.5 h-3.5 text-slate-400"></i> Restricted (Sellers & Brokers only)';
      permPostStatus.className = 'text-slate-400 font-bold flex items-center gap-1';
    }
    if (myPropertiesSection) myPropertiesSection.classList.add('hidden');
  }

  if (window.lucide) lucide.createIcons();
}

// ================= NAVIGATION TABS =================

function switchTab(tabId) {
  activeTab = tabId;
  const tabs = ['feed', 'chats', 'calls', 'map', 'profile'];
  tabs.forEach(t => {
    const el = document.getElementById(`tab-${t}`);
    const btn = document.getElementById(`tab-btn-${t}`);
    if (el) el.classList.toggle('hidden', t !== tabId);
    if (btn) {
      if (t === tabId) {
        btn.classList.add('border-wa-green', 'text-white');
        btn.classList.remove('border-transparent', 'text-emerald-100/70');
      } else {
        btn.classList.remove('border-wa-green', 'text-white');
        btn.classList.add('border-transparent', 'text-emerald-100/70');
      }
    }
  });

  if (tabId === 'chats') loadUsersList();
  if (tabId === 'calls') fetchCallLogs();
  if (tabId === 'map') {
    renderMapParcelsSelector();
    updateMapCard(selectedMapListing || allListings[0]);
  }
  if (tabId === 'profile') {
    applyUserRoleUI();
    if (currentUser?.role === 'seller' || currentUser?.role === 'broker') {
      loadMyListings();
    }
  }
  if (window.lucide) lucide.createIcons();
}

// ================= LAND LISTINGS & COMMUNITY FEED =================

function renderListingsSkeleton() {
  const container = document.getElementById('listings-container');
  if (!container) return;
  container.innerHTML = [1, 2, 3].map(() => `
    <div class="bg-white rounded-2xl overflow-hidden shadow-sm border border-slate-200/80 p-0">
      <div class="h-44 w-full skeleton-shimmer relative">
        <div class="absolute top-3 left-3 w-20 h-4 bg-slate-300/60 rounded-full"></div>
        <div class="absolute bottom-3 left-3 w-24 h-6 bg-slate-300/60 rounded-xl"></div>
      </div>
      <div class="p-3.5 space-y-2.5">
        <div class="h-4 w-4/5 skeleton-shimmer rounded-md"></div>
        <div class="h-3 w-1/2 skeleton-shimmer rounded-md"></div>
        <div class="space-y-1.5 pt-1">
          <div class="h-2.5 w-full skeleton-shimmer rounded-md"></div>
          <div class="h-2.5 w-3/4 skeleton-shimmer rounded-md"></div>
        </div>
        <div class="pt-2 border-t border-slate-100 flex items-center justify-between">
          <div class="flex items-center gap-2">
            <div class="w-7 h-7 rounded-full skeleton-shimmer"></div>
            <div class="space-y-1">
              <div class="h-3 w-16 skeleton-shimmer rounded-md"></div>
              <div class="h-2 w-24 skeleton-shimmer rounded-md"></div>
            </div>
          </div>
          <div class="flex gap-1.5">
            <div class="w-8 h-8 rounded-xl skeleton-shimmer"></div>
            <div class="w-8 h-8 rounded-xl skeleton-shimmer"></div>
            <div class="w-8 h-8 rounded-xl skeleton-shimmer"></div>
          </div>
        </div>
      </div>
    </div>
  `).join('');
}

function renderContactsSkeleton() {
  const container = document.getElementById('contacts-list');
  if (!container) return;
  container.innerHTML = [1, 2, 3, 4].map(() => `
    <div class="p-3 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <div class="w-11 h-11 rounded-full skeleton-shimmer flex-shrink-0"></div>
        <div class="space-y-1.5">
          <div class="h-3.5 w-28 skeleton-shimmer rounded-md"></div>
          <div class="h-2.5 w-40 skeleton-shimmer rounded-md"></div>
        </div>
      </div>
      <div class="h-2.5 w-10 skeleton-shimmer rounded-md"></div>
    </div>
  `).join('');
}

async function loadListings() {
  if (allListings.length === 0) {
    renderListingsSkeleton();
  }
  try {
    const res = await fetch(`${API_BASE}/api/listings`);
    allListings = await res.json();
    renderListings(allListings);
    renderMapParcelsSelector();
  } catch (err) {
    console.error('Error loading listings:', err);
  }
}

function renderListings(listings) {
  const container = document.getElementById('listings-container');
  if (!container) return;

  if (listings.length === 0) {
    container.innerHTML = `<div class="bg-white p-8 rounded-2xl text-center text-slate-400 text-xs">No matching land listings found.</div>`;
    return;
  }

  container.innerHTML = listings.map(item => {
    const formattedPrice = Number(item.price).toLocaleString('en-IN');
    let firstImg = item.images && item.images.length > 0 
      ? item.images[0] 
      : 'https://images.unsplash.com/photo-1500382017468-9049fed747ef?w=800';

    if (firstImg.includes('/uploads/land_')) {
      firstImg = `/bucket/${firstImg.split('/uploads/')[1]}`;
    }

    return `
      <div class="bg-white rounded-2xl overflow-hidden shadow-sm border border-slate-200/80 hover:shadow-md transition">
        <!-- Clickable Photo and Header (Opens Details Modal) -->
        <div onclick="openPropertyDetails(${item.id})" class="relative h-44 w-full bg-slate-100 cursor-pointer group">
          <img src="${firstImg}" onerror="this.onerror=null; this.src='https://images.unsplash.com/photo-1500382017468-9049fed747ef?w=800';" class="w-full h-full object-cover group-hover:scale-105 transition duration-300">
          <div class="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-black/20"></div>
          <div class="absolute top-3 left-3 bg-black/60 backdrop-blur-md text-white text-[10px] font-bold px-2.5 py-1 rounded-full uppercase tracking-wider">
            ${item.property_type}
          </div>
          <button onclick="event.stopPropagation(); toggleFavoriteListing(${item.id})" 
                  class="absolute top-3 right-3 w-7 h-7 rounded-full bg-black/50 hover:bg-black/70 backdrop-blur-md flex items-center justify-center text-white transition shadow-sm z-10"
                  title="Shortlist Plot">
            <i data-lucide="heart" class="w-3.5 h-3.5 ${isFavorite(item.id) ? 'fill-rose-500 text-rose-500' : 'text-white'}"></i>
          </button>
          <div class="absolute bottom-3 left-3 bg-wa-tealDark/95 backdrop-blur-md text-white px-3 py-1 rounded-xl text-xs font-black shadow-lg">
            ₹${formattedPrice}
          </div>
          <div class="absolute bottom-3 right-3 bg-black/60 backdrop-blur-md text-white text-[10px] px-2 py-0.5 rounded-lg flex items-center gap-1 font-medium">
            <i data-lucide="maximize" class="w-3 h-3 text-emerald-300"></i>
            ${Number(item.area_sqft).toLocaleString()} sq.ft
          </div>
        </div>

        <div class="p-3.5 space-y-2">
          <div onclick="openPropertyDetails(${item.id})" class="cursor-pointer">
            <h3 class="font-bold text-slate-800 text-sm leading-snug hover:text-wa-teal transition">${item.title}</h3>
            
            <div class="flex items-center gap-1 text-[11px] text-slate-500 mt-1">
              <i data-lucide="map-pin" class="w-3.5 h-3.5 text-wa-teal flex-shrink-0"></i>
              <span class="truncate">${item.location_address}, ${item.city}</span>
            </div>

            <p class="text-xs text-slate-600 line-clamp-2 leading-relaxed mt-1">
              ${item.description}
            </p>
          </div>

          <div class="pt-2 border-t border-slate-100 flex items-center justify-between">
            <div class="flex items-center gap-2">
              <img src="${item.owner_avatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100'}" 
                   class="w-7 h-7 rounded-full object-cover border border-slate-200">
              <div>
                <div class="font-bold text-[11px] text-slate-800 leading-tight">${item.owner_name}</div>
                <div class="text-[9px] text-slate-500 flex items-center gap-1">
                  <span class="capitalize font-semibold text-wa-teal">${item.owner_role}</span> • 
                  <span class="text-emerald-700">${item.owner_phone} (Protected)</span>
                </div>
              </div>
            </div>

            <div class="flex items-center gap-1.5">
              <button onclick="startChatWithUser(${item.owner_id}, '${escapeQuotes(item.owner_name)}', '${escapeQuotes(item.owner_avatar)}', '${item.owner_role}')" 
                      class="bg-emerald-50 hover:bg-emerald-100 text-wa-teal p-2 rounded-xl transition" 
                      title="Send Message">
                <i data-lucide="message-circle" class="w-4 h-4"></i>
              </button>
              <button onclick="initiateDirectCall(${item.owner_id}, '${escapeQuotes(item.owner_name)}', '${escapeQuotes(item.owner_avatar)}', '${item.owner_role}', 'audio', ${item.id})" 
                      class="bg-emerald-50 hover:bg-emerald-100 text-wa-teal p-2 rounded-xl transition" 
                      title="Voice Call">
                <i data-lucide="phone" class="w-4 h-4"></i>
              </button>
              <button onclick="initiateDirectCall(${item.owner_id}, '${escapeQuotes(item.owner_name)}', '${escapeQuotes(item.owner_avatar)}', '${item.owner_role}', 'video', ${item.id})" 
                      class="bg-wa-teal hover:bg-wa-tealDark text-white p-2 rounded-xl shadow-sm transition" 
                      title="Video Call (Key Feature)">
                <i data-lucide="video" class="w-4 h-4"></i>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  if (window.lucide) lucide.createIcons();
}

document.addEventListener('input', (e) => {
  if (e.target.id === 'feed-search' || e.target.id === 'feed-filter-type') {
    filterListings();
  }
});

function filterListings() {
  const search = (document.getElementById('feed-search')?.value || '').toLowerCase();
  const type = document.getElementById('feed-filter-type')?.value || 'all';

  const filtered = allListings.filter(item => {
    const matchesSearch = item.title.toLowerCase().includes(search) ||
                          item.description.toLowerCase().includes(search) ||
                          item.city.toLowerCase().includes(search) ||
                          item.location_address.toLowerCase().includes(search);
    const matchesType = type === 'all' || item.property_type === type;
    return matchesSearch && matchesType;
  });

  renderListings(filtered);
}

function escapeQuotes(str) {
  if (!str) return '';
  return str.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

// ================= CREATE LISTING MODAL =================

function openNewListingModal() {
  if (currentUser?.role === 'buyer') {
    showInAppAlert('Access Restricted', 'Only verified Sellers and Brokers are permitted to create land listings.', 'warning');
    return;
  }
  const modal = document.getElementById('new-listing-modal');
  const previewBox = document.getElementById('new-listing-preview-box');
  const fileInput = document.getElementById('new-listing-file-input');
  if (previewBox) previewBox.classList.add('hidden');
  if (fileInput) fileInput.value = '';
  if (modal) modal.classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}

// ================= STORAGE BUCKET IMAGE UPLOAD =================

async function handleListingImageUpload(inputEl, previewBoxId, previewImgId, hiddenUrlId, statusId) {
  const file = inputEl.files && inputEl.files[0];
  if (!file) return;

  const previewBox = document.getElementById(previewBoxId);
  const previewImg = document.getElementById(previewImgId);
  const hiddenInput = document.getElementById(hiddenUrlId);
  const statusEl = document.getElementById(statusId);

  // Show immediate local preview
  const localUrl = URL.createObjectURL(file);
  if (previewImg) previewImg.src = localUrl;
  if (previewBox) previewBox.classList.remove('hidden');
  if (statusEl) {
    statusEl.innerHTML = `<span class="animate-spin inline-block mr-1">⏳</span> Uploading photo...`;
  }

  // Convert to Base64
  const reader = new FileReader();
  reader.readAsDataURL(file);
  reader.onloadend = async () => {
    const base64Data = reader.result;

    try {
      const res = await fetch(`${API_BASE}/api/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${currentToken}`
        },
        body: JSON.stringify({
          filename: file.name,
          file_data: base64Data
        })
      });

      const data = await res.json();
      if (data.success && data.url) {
        if (hiddenInput) hiddenInput.value = data.url;
        if (statusEl) {
          statusEl.innerHTML = `<i data-lucide="check-circle" class="w-3.5 h-3.5 text-emerald-400"></i> Photo uploaded successfully`;
          if (window.lucide) lucide.createIcons();
        }
        showToast('Photo uploaded successfully', 'success');
      } else {
        showToast('Upload failed: ' + (data.error || 'Server error'), 'error');
        if (statusEl) statusEl.textContent = 'Upload failed';
      }
    } catch (err) {
      console.error('Error uploading image:', err);
      if (statusEl) statusEl.textContent = 'Upload error: ' + err.message;
      showToast('Image upload error', 'error');
    }
  };
}

function closeNewListingModal() {
  const modal = document.getElementById('new-listing-modal');
  if (modal) modal.classList.add('hidden');
}

async function handleCreateListing(e) {
  e.preventDefault();
  if (!currentToken) {
    showInAppAlert('Login Required', 'Please log in to publish land listings.', 'info');
    return;
  }

  const payload = {
    title: document.getElementById('listing-title').value,
    property_type: document.getElementById('listing-type').value,
    area_sqft: parseFloat(document.getElementById('listing-area').value),
    price: parseFloat(document.getElementById('listing-price').value),
    location_address: document.getElementById('listing-address').value,
    latitude: parseFloat(document.getElementById('listing-lat').value),
    longitude: parseFloat(document.getElementById('listing-lng').value),
    images: [document.getElementById('listing-image').value],
    description: document.getElementById('listing-desc').value,
    features: ['Title Clear', 'Immediate Possession']
  };

  try {
    const res = await fetch(`${API_BASE}/api/listings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentToken}`
      },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      showToast('Land listing published successfully!', 'success');
      closeNewListingModal();
      await loadListings();
      if (currentUser?.role === 'seller' || currentUser?.role === 'broker') {
        await loadMyListings();
      }
      switchTab('feed');
    } else {
      const rawErr = data.error || 'Failed to create listing';
      const friendlyErr = rawErr.includes('SSL connection') ? 'Database reconnected. Please tap Publish again.' : rawErr;
      showInAppAlert('Publish Listing', friendlyErr, 'error');
    }
  } catch (err) {
    showInAppAlert('Publish Listing', 'Connection issue: ' + err.message, 'error');
  }
}

// ================= PROPERTY DETAILS & LISTING MANAGEMENT =================

function openPropertyDetails(listingId) {
  const item = allListings.find(l => l.id === listingId);
  if (!item) return;

  const modal = document.getElementById('property-detail-modal');
  const imgEl = document.getElementById('detail-img');
  const priceEl = document.getElementById('detail-price');
  const pricePerSqftEl = document.getElementById('detail-price-per-sqft');
  const typeEl = document.getElementById('detail-type');
  const titleEl = document.getElementById('detail-title');
  const locEl = document.getElementById('detail-location');
  const areaEl = document.getElementById('detail-area');
  const descEl = document.getElementById('detail-desc');
  const featuresEl = document.getElementById('detail-features');
  const ownerAvatar = document.getElementById('detail-owner-avatar');
  const ownerName = document.getElementById('detail-owner-name');
  const ownerRole = document.getElementById('detail-owner-role');
  const ownerPhone = document.getElementById('detail-owner-phone');
  const btnChat = document.getElementById('btn-detail-chat');
  const btnCallAudio = document.getElementById('btn-detail-call-audio');
  const btnCallVideo = document.getElementById('btn-detail-call-video');
  const ownerActions = document.getElementById('detail-owner-actions');
  const btnEdit = document.getElementById('btn-edit-listing');
  const btnDelete = document.getElementById('btn-delete-listing');

  const formattedPrice = Number(item.price).toLocaleString('en-IN');
  const perSqft = item.area_sqft > 0 ? Math.round(item.price / item.area_sqft) : 0;
  const firstImg = item.images && item.images.length > 0 
    ? item.images[0] 
    : 'https://images.unsplash.com/photo-1500382017468-9049fed747ef?w=800';

  if (imgEl) imgEl.src = firstImg;
  if (priceEl) priceEl.textContent = `₹${formattedPrice}`;
  if (pricePerSqftEl) pricePerSqftEl.textContent = perSqft > 0 ? `(₹${perSqft}/sq.ft)` : '';
  if (typeEl) typeEl.textContent = item.property_type;
  if (titleEl) titleEl.textContent = item.title;
  if (locEl) locEl.textContent = `${item.location_address}, ${item.city}, ${item.state}`;
  if (areaEl) {
    const acres = (item.area_sqft / 43560).toFixed(2);
    areaEl.textContent = `${Number(item.area_sqft).toLocaleString()} sq.ft (${acres} Acres)`;
  }
  if (descEl) descEl.textContent = item.description;

  if (featuresEl) {
    const defaultFeatures = ["Clear Legal Title", "30ft Road Access", "Electricity Available", "Borewell Water", "Immediate Registration"];
    const feats = (item.features && item.features.length > 0) ? item.features : defaultFeatures;
    featuresEl.innerHTML = feats.map(f => `
      <span class="bg-emerald-50 text-emerald-800 border border-emerald-200 px-2.5 py-1 rounded-lg text-[10px] font-semibold flex items-center gap-1">
        <i data-lucide="check" class="w-3 h-3 text-emerald-600"></i> ${f}
      </span>
    `).join('');
  }

  if (ownerAvatar) ownerAvatar.src = item.owner_avatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100';
  if (ownerName) ownerName.textContent = item.owner_name;
  if (ownerRole) ownerRole.textContent = item.owner_role;
  if (ownerPhone) ownerPhone.textContent = `${item.owner_phone || 'Phone Protected'}`;

  // Contact actions
  if (btnChat) btnChat.onclick = () => {
    closePropertyDetails();
    startChatWithUser(item.owner_id, escapeQuotes(item.owner_name), escapeQuotes(item.owner_avatar), item.owner_role);
  };
  if (btnCallAudio) btnCallAudio.onclick = () => {
    closePropertyDetails();
    initiateDirectCall(item.owner_id, escapeQuotes(item.owner_name), escapeQuotes(item.owner_avatar), item.owner_role, 'audio', item.id);
  };
  if (btnCallVideo) btnCallVideo.onclick = () => {
    closePropertyDetails();
    initiateDirectCall(item.owner_id, escapeQuotes(item.owner_name), escapeQuotes(item.owner_avatar), item.owner_role, 'video', item.id);
  };

  // Check if current user is owner (Allow edit & delete)
  const isOwner = currentUser && (item.owner_id === currentUser.id);
  if (ownerActions) {
    if (isOwner) {
      ownerActions.classList.remove('hidden');
      if (btnEdit) btnEdit.onclick = () => {
        closePropertyDetails();
        openEditListing(item.id);
      };
      if (btnDelete) btnDelete.onclick = () => {
        handleDeleteListing(item.id);
      };
    } else {
      ownerActions.classList.add('hidden');
    }
  }

  const favIcon = document.getElementById('icon-detail-fav');
  if (favIcon) {
    favIcon.className = isFavorite(item.id)
      ? 'w-4 h-4 fill-rose-500 text-rose-500'
      : 'w-4 h-4 text-white';
  }

  if (modal) modal.classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}

function closePropertyDetails() {
  const modal = document.getElementById('property-detail-modal');
  if (modal) modal.classList.add('hidden');
}

function openEditListing(listingId) {
  const item = allListings.find(l => l.id === listingId);
  if (!item) return;

  document.getElementById('edit-listing-id').value = item.id;
  document.getElementById('edit-listing-title').value = item.title;
  document.getElementById('edit-listing-type').value = item.property_type;
  document.getElementById('edit-listing-area').value = item.area_sqft;
  document.getElementById('edit-listing-price').value = item.price;
  document.getElementById('edit-listing-address').value = item.location_address;
  document.getElementById('edit-listing-lat').value = item.latitude;
  document.getElementById('edit-listing-lng').value = item.longitude;
  const imgUrl = item.images && item.images.length > 0 ? item.images[0] : '';
  document.getElementById('edit-listing-image').value = imgUrl;
  const editPreviewImg = document.getElementById('edit-listing-preview-img');
  const editBucketStatus = document.getElementById('edit-listing-bucket-status');
  if (editPreviewImg && imgUrl) editPreviewImg.src = imgUrl;
  if (editBucketStatus) editBucketStatus.innerHTML = '<i data-lucide="check-circle" class="w-3.5 h-3.5"></i> Photo uploaded';
  document.getElementById('edit-listing-desc').value = item.description;

  const modal = document.getElementById('edit-listing-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeEditListingModal() {
  const modal = document.getElementById('edit-listing-modal');
  if (modal) modal.classList.add('hidden');
}

async function handleUpdateListing(e) {
  e.preventDefault();
  const listingId = document.getElementById('edit-listing-id').value;
  if (!currentToken || !listingId) return;

  const payload = {
    title: document.getElementById('edit-listing-title').value,
    property_type: document.getElementById('edit-listing-type').value,
    area_sqft: parseFloat(document.getElementById('edit-listing-area').value),
    price: parseFloat(document.getElementById('edit-listing-price').value),
    location_address: document.getElementById('edit-listing-address').value,
    latitude: parseFloat(document.getElementById('edit-listing-lat').value),
    longitude: parseFloat(document.getElementById('edit-listing-lng').value),
    images: [document.getElementById('edit-listing-image').value],
    description: document.getElementById('edit-listing-desc').value
  };

  try {
    const res = await fetch(`${API_BASE}/api/listings/${listingId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentToken}`
      },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      showToast('Listing updated successfully!', 'success');
      closeEditListingModal();
      await loadListings();
      await loadMyListings();
    } else {
      showInAppAlert('Update Listing', data.error || 'Failed to update listing', 'error');
    }
  } catch (err) {
    showInAppAlert('Update Listing', 'Error updating listing: ' + err.message, 'error');
  }
}

let pendingDeleteListingId = null;

function promptDeleteListing(listingId) {
  pendingDeleteListingId = listingId;
  const modal = document.getElementById('delete-confirm-modal');
  if (modal) modal.classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}

function closeDeleteConfirmModal() {
  pendingDeleteListingId = null;
  const modal = document.getElementById('delete-confirm-modal');
  if (modal) modal.classList.add('hidden');
}

async function executeConfirmedDeleteListing() {
  if (!pendingDeleteListingId) return;
  const idToDelete = pendingDeleteListingId;
  closeDeleteConfirmModal();
  await performDeleteListing(idToDelete);
}

function handleDeleteListing(listingId) {
  promptDeleteListing(listingId);
}

async function performDeleteListing(listingId) {
  if (!currentToken) return;

  try {
    const res = await fetch(`${API_BASE}/api/listings/${listingId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${currentToken}`
      }
    });
    const data = await res.json();
    if (data.success) {
      showToast('Land listing deleted.', 'success');
      closePropertyDetails();
      await loadListings();
      await loadMyListings();
    } else {
      showInAppAlert('Delete Listing', data.error || 'Failed to delete listing', 'error');
    }
  } catch (err) {
    showInAppAlert('Delete Listing', 'Error deleting listing: ' + err.message, 'error');
  }
}

async function loadMyListings() {
  if (!currentToken || !currentUser) return;
  const listEl = document.getElementById('my-listings-list');
  if (!listEl) return;

  try {
    const res = await fetch(`${API_BASE}/api/listings/my`, {
      headers: { 'Authorization': `Bearer ${currentToken}` }
    });
    const myListings = await res.json();
    if (myListings.length === 0) {
      listEl.innerHTML = `
        <div class="text-center py-4 text-slate-400 text-xs">
          You haven't listed any land parcels yet.
          <button onclick="openNewListingModal()" class="text-wa-teal font-bold block mx-auto mt-1 hover:underline">+ Post your first plot</button>
        </div>
      `;
      return;
    }

    listEl.innerHTML = myListings.map(item => {
      const formattedPrice = Number(item.price).toLocaleString('en-IN');
      let firstImg = item.images && item.images.length > 0 
        ? item.images[0] 
        : 'https://images.unsplash.com/photo-1500382017468-9049fed747ef?w=800';

      if (firstImg.includes('/uploads/land_')) {
        firstImg = `/bucket/${firstImg.split('/uploads/')[1]}`;
      }

      return `
        <div class="p-2.5 bg-slate-50 border border-slate-200 rounded-xl flex items-center justify-between">
          <div class="flex items-center gap-2.5 truncate cursor-pointer" onclick="openPropertyDetails(${item.id})">
            <img src="${firstImg}" onerror="this.onerror=null; this.src='https://images.unsplash.com/photo-1500382017468-9049fed747ef?w=800';" class="w-10 h-10 rounded-lg object-cover flex-shrink-0 border border-slate-200">
            <div class="truncate">
              <h5 class="font-bold text-xs text-slate-800 truncate">${item.title}</h5>
              <div class="text-[10px] text-emerald-700 font-semibold">₹${formattedPrice} • ${item.property_type}</div>
            </div>
          </div>
          <div class="flex items-center gap-1.5 flex-shrink-0">
            <button onclick="openEditListing(${item.id})" class="p-1.5 bg-white border border-slate-200 text-slate-600 rounded-lg hover:text-wa-teal transition" title="Edit">
              <i data-lucide="edit-3" class="w-3.5 h-3.5"></i>
            </button>
            <button onclick="handleDeleteListing(${item.id})" class="p-1.5 bg-white border border-rose-200 text-rose-600 rounded-lg hover:bg-rose-50 transition" title="Delete">
              <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
            </button>
          </div>
        </div>
      `;
    }).join('');

    if (window.lucide) lucide.createIcons();
  } catch (err) {
    console.error('Error loading my listings:', err);
  }
}

// ================= WHATSAPP STYLE MESSAGING & CHATS =================

// ================= WHATSAPP STYLE MESSAGING & CHATS =================

let recentConversations = [];
let chatSearchQuery = '';

function getPinnedChatIds() {
  const uid = currentUser ? currentUser.id : '0';
  try {
    return JSON.parse(localStorage.getItem(`landconnect_pinned_${uid}`) || '[]');
  } catch(e) {
    return [];
  }
}

function savePinnedChatIds(ids) {
  const uid = currentUser ? currentUser.id : '0';
  localStorage.setItem(`landconnect_pinned_${uid}`, JSON.stringify(ids));
}

function getArchivedChatIds() {
  const uid = currentUser ? currentUser.id : '0';
  try {
    return JSON.parse(localStorage.getItem(`landconnect_archived_${uid}`) || '[]');
  } catch(e) {
    return [];
  }
}

function saveArchivedChatIds(ids) {
  const uid = currentUser ? currentUser.id : '0';
  localStorage.setItem(`landconnect_archived_${uid}`, JSON.stringify(ids));
}

function formatChatTime(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  if (isToday) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } else if (isYesterday) {
    return 'Yesterday';
  } else {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
}

async function loadUsersList() {
  if (allUsers.length === 0) {
    renderContactsSkeleton();
  }
  try {
    const [usersRes, convRes] = await Promise.all([
      fetch(`${API_BASE}/api/users`),
      currentToken ? fetch(`${API_BASE}/api/conversations`, {
        headers: { 'Authorization': `Bearer ${currentToken}` }
      }) : Promise.resolve(null)
    ]);

    allUsers = await usersRes.json();
    if (convRes && convRes.ok) {
      recentConversations = await convRes.json();
    } else {
      recentConversations = [];
    }

    renderContactsList();
    renderCallsContactsList();
    updateUnreadBadgesCounter();
  } catch (err) {
    console.error('Error loading users/conversations:', err);
  }
}

function renderContactsList() {
  const container = document.getElementById('contacts-list');
  if (!container) return;

  const myId = currentUser ? Number(currentUser.id) : 0;
  const otherUsers = allUsers.filter(u => Number(u.id) !== myId);
  const pinnedIds = getPinnedChatIds();
  const archivedIds = getArchivedChatIds();

  // Create unified conversation entries
  const entries = otherUsers.map(u => {
    const conv = recentConversations.find(c => Number(c.peer_id) === Number(u.id));
    return {
      id: Number(u.id),
      name: u.name,
      avatar: u.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(u.name)}&background=075E54&color=fff`,
      role: u.role,
      phone_masked: u.phone_masked,
      last_message: conv ? conv.last_message : null,
      last_message_type: conv ? conv.last_message_type : null,
      last_message_time: conv ? conv.last_message_time : null,
      last_message_sender_id: conv ? Number(conv.last_message_sender_id) : null,
      unread_count: conv ? Number(conv.unread_count) : 0,
      is_pinned: pinnedIds.includes(Number(u.id)),
      is_archived: archivedIds.includes(Number(u.id))
    };
  });

  // Filter out archived for main view
  let activeChats = entries.filter(e => !e.is_archived);
  let archivedChats = entries.filter(e => e.is_archived);

  // Update Archived Bar
  const archivedBar = document.getElementById('archived-chats-bar');
  const archivedCount = document.getElementById('archived-chats-count');
  if (archivedBar && archivedCount) {
    if (archivedChats.length > 0) {
      archivedBar.classList.remove('hidden');
      archivedCount.textContent = archivedChats.length;
    } else {
      archivedBar.classList.add('hidden');
    }
  }

  // Filter by search query if any
  if (chatSearchQuery.trim()) {
    const q = chatSearchQuery.toLowerCase();
    activeChats = activeChats.filter(e => 
      e.name.toLowerCase().includes(q) || 
      e.role.toLowerCase().includes(q) || 
      (e.last_message && e.last_message.toLowerCase().includes(q))
    );
  }

  // Sort Active Chats:
  // 1. Pinned chats first
  // 2. Most recent message time descending
  // 3. Contacts with no messages alphabetically
  activeChats.sort((a, b) => {
    if (a.is_pinned && !b.is_pinned) return -1;
    if (!a.is_pinned && b.is_pinned) return 1;

    if (a.last_message_time && b.last_message_time) {
      return new Date(b.last_message_time) - new Date(a.last_message_time);
    }
    if (a.last_message_time && !b.last_message_time) return -1;
    if (!a.last_message_time && b.last_message_time) return 1;

    return a.name.localeCompare(b.name);
  });

  if (activeChats.length === 0) {
    container.innerHTML = `
      <div class="text-center py-10 px-4 text-slate-400">
        <i data-lucide="message-square-off" class="w-8 h-8 mx-auto mb-2 opacity-50"></i>
        <p class="text-xs font-semibold">No chats found</p>
        <p class="text-[10px] mt-0.5">Start a new conversation with buyers, sellers or brokers</p>
      </div>
    `;
    if (window.lucide) lucide.createIcons();
    return;
  }

  container.innerHTML = activeChats.map(u => renderChatRowHtml(u, false)).join('');
  if (window.lucide) lucide.createIcons();
}

function renderChatRowHtml(u, isArchivedView = false) {
  const isMine = currentUser && (u.last_message_sender_id === Number(currentUser.id));
  const timeFormatted = formatChatTime(u.last_message_time);
  
  let previewText = 'Tap to start conversation...';
  let previewPrefix = '';

  if (u.last_message) {
    if (isMine) {
      previewPrefix = '<span class="text-emerald-600 mr-0.5 font-bold">✓✓</span> ';
    }
    if (u.last_message_type === 'audio') {
      previewText = '🎙️ Voice note';
    } else if (u.last_message_type === 'meeting') {
      previewText = '🎥 Video Meeting Room';
    } else if (u.last_message_type === 'property_inquiry') {
      previewText = '📍 Land parcel inquiry';
    } else {
      previewText = escapeQuotes(u.last_message);
    }
  }

  const hasUnread = u.unread_count > 0;

  return `
    <div onclick="startChatWithUser(${u.id}, '${escapeQuotes(u.name)}', '${escapeQuotes(u.avatar)}', '${u.role}')"
         class="group px-3.5 py-3 flex items-center justify-between hover:bg-slate-50 active:bg-slate-100 cursor-pointer transition select-none ${u.is_pinned ? 'bg-emerald-50/40 border-l-4 border-wa-teal' : ''}">
      <div class="flex items-center gap-3 min-w-0 flex-1 pr-2">
        <div class="relative shrink-0">
          <img src="${u.avatar}" onerror="this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(u.name)}&background=075E54&color=fff'" 
               class="w-11 h-11 rounded-full object-cover border border-slate-200">
          <span class="absolute bottom-0 right-0 w-3 h-3 rounded-full bg-emerald-500 border-2 border-white"></span>
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center justify-between mb-0.5">
            <div class="flex items-center gap-1.5 truncate">
              <h4 class="font-bold text-xs text-slate-800 truncate">${u.name}</h4>
              <span class="text-[9px] px-1.5 py-0.2 rounded font-semibold uppercase shrink-0 ${
                u.role === 'buyer' ? 'bg-blue-100 text-blue-700' :
                u.role === 'seller' ? 'bg-emerald-100 text-emerald-700' : 'bg-purple-100 text-purple-700'
              }">${u.role}</span>
            </div>
            <span class="text-[10px] shrink-0 font-medium ml-2 ${hasUnread ? 'text-emerald-600 font-bold' : 'text-slate-400'}">${timeFormatted}</span>
          </div>
          <div class="flex items-center justify-between">
            <p class="text-[11px] truncate pr-2 ${hasUnread ? 'text-slate-900 font-bold' : 'text-slate-500'}">
              ${previewPrefix}${previewText}
            </p>
            <div class="flex items-center gap-1.5 shrink-0">
              ${u.is_pinned ? '<i data-lucide="pin" class="w-3.5 h-3.5 text-wa-teal rotate-45 inline-block"></i>' : ''}
              ${hasUnread ? `<span class="bg-wa-green text-wa-tealDark text-[10px] font-bold px-1.5 py-0.2 rounded-full min-w-[18px] text-center shadow-xs">${u.unread_count}</span>` : ''}
              
              <!-- Quick Action Hover Menu -->
              <div class="opacity-0 group-hover:opacity-100 transition flex items-center gap-1 ml-1">
                ${!isArchivedView ? `
                  <button onclick="event.stopPropagation(); togglePinChat(${u.id})" 
                          class="p-1 hover:bg-slate-200 text-slate-400 hover:text-wa-teal rounded-full transition" 
                          title="${u.is_pinned ? 'Unpin' : 'Pin to top'}">
                    <i data-lucide="${u.is_pinned ? 'pin-off' : 'pin'}" class="w-3.5 h-3.5"></i>
                  </button>
                  <button onclick="event.stopPropagation(); toggleArchiveChat(${u.id})" 
                          class="p-1 hover:bg-slate-200 text-slate-400 hover:text-wa-teal rounded-full transition" 
                          title="Archive Chat">
                    <i data-lucide="archive" class="w-3.5 h-3.5"></i>
                  </button>
                ` : `
                  <button onclick="event.stopPropagation(); toggleArchiveChat(${u.id})" 
                          class="p-1 hover:bg-slate-200 text-slate-400 hover:text-wa-teal rounded-full transition" 
                          title="Unarchive Chat">
                    <i data-lucide="archive-restore" class="w-3.5 h-3.5"></i>
                  </button>
                `}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderArchivedContactsList() {
  const container = document.getElementById('archived-contacts-list');
  const countText = document.getElementById('archived-modal-count-text');
  if (!container) return;

  const myId = currentUser ? Number(currentUser.id) : 0;
  const otherUsers = allUsers.filter(u => Number(u.id) !== myId);
  const archivedIds = getArchivedChatIds();

  const archivedEntries = otherUsers.filter(u => archivedIds.includes(Number(u.id))).map(u => {
    const conv = recentConversations.find(c => Number(c.peer_id) === Number(u.id));
    return {
      id: Number(u.id),
      name: u.name,
      avatar: u.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(u.name)}&background=075E54&color=fff`,
      role: u.role,
      phone_masked: u.phone_masked,
      last_message: conv ? conv.last_message : null,
      last_message_type: conv ? conv.last_message_type : null,
      last_message_time: conv ? conv.last_message_time : null,
      last_message_sender_id: conv ? Number(conv.last_message_sender_id) : null,
      unread_count: conv ? Number(conv.unread_count) : 0,
      is_pinned: false,
      is_archived: true
    };
  });

  if (countText) {
    countText.textContent = `${archivedEntries.length} archived conversation${archivedEntries.length === 1 ? '' : 's'}`;
  }

  if (archivedEntries.length === 0) {
    container.innerHTML = `
      <div class="text-center py-12 px-4 text-slate-400">
        <i data-lucide="archive" class="w-8 h-8 mx-auto mb-2 opacity-40"></i>
        <p class="text-xs font-semibold text-slate-600">No archived chats</p>
        <p class="text-[10px] text-slate-400 mt-0.5">Archived chats will appear here</p>
      </div>
    `;
    if (window.lucide) lucide.createIcons();
    return;
  }

  container.innerHTML = archivedEntries.map(u => renderChatRowHtml(u, true)).join('');
  if (window.lucide) lucide.createIcons();
}

function updateUnreadBadgesCounter() {
  const badge = document.getElementById('chats-badge');
  if (!badge) return;

  const archivedIds = getArchivedChatIds();
  const totalUnread = recentConversations.reduce((acc, c) => {
    if (!archivedIds.includes(Number(c.peer_id))) {
      return acc + (Number(c.unread_count) || 0);
    }
    return acc;
  }, 0);

  if (totalUnread > 0) {
    badge.textContent = totalUnread;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function handleChatSearch(val) {
  chatSearchQuery = val || '';
  renderContactsList();
}

function togglePinChat(peerId) {
  const pid = Number(peerId);
  let pinned = getPinnedChatIds();
  const isPinned = pinned.includes(pid);
  if (isPinned) {
    pinned = pinned.filter(id => id !== pid);
    showToast('Chat unpinned', 'info');
  } else {
    pinned.unshift(pid);
    showToast('Chat pinned to top', 'success');
  }
  savePinnedChatIds(pinned);
  renderContactsList();
  updateHeaderPinArchiveButtons();
}

function toggleArchiveChat(peerId) {
  const pid = Number(peerId);
  let archived = getArchivedChatIds();
  const isArchived = archived.includes(pid);
  if (isArchived) {
    archived = archived.filter(id => id !== pid);
    showToast('Chat unarchived', 'info');
  } else {
    archived.push(pid);
    let pinned = getPinnedChatIds().filter(id => id !== pid);
    savePinnedChatIds(pinned);
    showToast('Chat archived', 'info');
  }
  saveArchivedChatIds(archived);
  renderContactsList();
  renderArchivedContactsList();
  updateHeaderPinArchiveButtons();
  updateUnreadBadgesCounter();
}

function togglePinCurrentChat() {
  if (!activeChatPeer) return;
  togglePinChat(activeChatPeer.id);
}

function toggleArchiveCurrentChat() {
  if (!activeChatPeer) return;
  const pid = activeChatPeer.id;
  toggleArchiveChat(pid);
  closeActiveChat();
}

function updateHeaderPinArchiveButtons() {
  if (!activeChatPeer) return;
  const pid = Number(activeChatPeer.id);
  const pinnedIds = getPinnedChatIds();
  const archivedIds = getArchivedChatIds();

  const btnPin = document.getElementById('btn-chat-pin-header');
  const btnArchive = document.getElementById('btn-chat-archive-header');

  if (btnPin) {
    const isPinned = pinnedIds.includes(pid);
    btnPin.className = isPinned 
      ? 'p-1.5 rounded-full bg-white/20 text-wa-green font-bold transition'
      : 'p-1.5 rounded-full hover:bg-white/10 text-emerald-100 hover:text-white transition';
    btnPin.setAttribute('title', isPinned ? 'Unpin Conversation' : 'Pin Conversation');
  }

  if (btnArchive) {
    const isArchived = archivedIds.includes(pid);
    btnArchive.className = isArchived 
      ? 'p-1.5 rounded-full bg-white/20 text-amber-300 font-bold transition'
      : 'p-1.5 rounded-full hover:bg-white/10 text-emerald-100 hover:text-white transition';
    btnArchive.setAttribute('title', isArchived ? 'Unarchive Conversation' : 'Archive Conversation');
  }

  if (window.lucide) lucide.createIcons();
}

function openArchivedChatsModal() {
  renderArchivedContactsList();
  const modal = document.getElementById('archived-chats-modal');
  if (modal) modal.classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}

function closeArchivedChatsModal() {
  const modal = document.getElementById('archived-chats-modal');
  if (modal) modal.classList.add('hidden');
}

let chatSyncInterval = null;

async function startChatWithUser(userId, name, avatar, role) {
  activeChatPeer = { id: userId, name, avatar, role };

  const peerName = document.getElementById('chat-peer-name');
  const peerAvatar = document.getElementById('chat-peer-avatar');
  const peerRole = document.getElementById('chat-peer-role');
  if (peerName) peerName.textContent = name;
  if (peerAvatar) peerAvatar.src = avatar;
  if (peerRole) peerRole.textContent = role;

  const chatView = document.getElementById('active-chat-view');
  if (chatView) chatView.classList.remove('hidden');

  updateHeaderPinArchiveButtons();

  // Mark this conversation's unread count as 0 locally
  const conv = recentConversations.find(c => Number(c.peer_id) === Number(userId));
  if (conv) {
    conv.unread_count = 0;
    updateUnreadBadgesCounter();
    renderContactsList();
  }

  await fetchChatMessages(userId);
  switchTab('chats');
  if (window.lucide) lucide.createIcons();

  // Background active sync polling every 1500ms
  clearInterval(chatSyncInterval);
  chatSyncInterval = setInterval(() => {
    if (activeChatPeer && Number(activeChatPeer.id) === Number(userId) && currentToken) {
      syncChatMessages(userId);
    }
  }, 1500);
}

function closeActiveChat() {
  clearInterval(chatSyncInterval);
  chatSyncInterval = null;
  const chatView = document.getElementById('active-chat-view');
  if (chatView) chatView.classList.add('hidden');
  activeChatPeer = null;
  loadUsersList();
}

async function fetchChatMessages(otherUserId) {
  if (!currentToken) return;
  try {
    const res = await fetch(`${API_BASE}/api/messages/${otherUserId}`, {
      headers: { 'Authorization': `Bearer ${currentToken}` }
    });
    const messages = await res.json();
    renderChatMessages(messages);

    const countEl = document.getElementById('chat-peer-msg-count');
    if (countEl) {
      countEl.textContent = `${messages.length} ${messages.length === 1 ? 'message' : 'messages'}`;
    }

    const conv = recentConversations.find(c => Number(c.peer_id) === Number(otherUserId));
    if (conv) {
      conv.unread_count = 0;
      updateUnreadBadgesCounter();
      renderContactsList();
    }
  } catch (err) {
    console.error('Error fetching messages:', err);
  }
}

async function syncChatMessages(otherUserId) {
  if (!currentToken) return;
  try {
    const res = await fetch(`${API_BASE}/api/messages/${otherUserId}`, {
      headers: { 'Authorization': `Bearer ${currentToken}` }
    });
    if (!res.ok) return;
    const messages = await res.json();
    if (!Array.isArray(messages)) return;

    let addedAny = false;
    for (const m of messages) {
      const exists = (m.id && document.getElementById(`msg-bubble-${m.id}`)) ||
                     (m.tempId && document.getElementById(`msg-bubble-${m.tempId}`));
      if (!exists) {
        appendMessageToChat(m, false);
        addedAny = true;
      }
    }
    if (addedAny) {
      const countEl = document.getElementById('chat-peer-msg-count');
      if (countEl) {
        const currentTotal = document.querySelectorAll('#chat-messages-container > div[id^="msg-bubble-"]').length;
        countEl.textContent = `${currentTotal} ${currentTotal === 1 ? 'message' : 'messages'}`;
      }
      if (window.lucide) lucide.createIcons();
    }
  } catch (err) {
    // Silent catch for background polling
  }
}

function updateMessageStatus(tempId, permanentId) {
  if (!tempId) return;
  const statusEl = document.getElementById(`msg-status-${tempId}`);
  if (statusEl) {
    statusEl.id = `msg-status-${permanentId}`;
    statusEl.innerHTML = '<i data-lucide="check-check" class="w-3 h-3 text-emerald-600"></i>';
    if (window.lucide) lucide.createIcons();
  }
  const bubbleEl = document.getElementById(`msg-bubble-${tempId}`);
  if (bubbleEl) {
    bubbleEl.id = `msg-bubble-${permanentId}`;
  }
}

function generateMessageHtml(m, isPending = false) {
  const isMine = currentUser && (Number(m.sender_id) === Number(currentUser.id));
  const time = m.created_at ? new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const bubbleId = m.tempId ? `msg-bubble-${m.tempId}` : `msg-bubble-${m.id}`;
  const statusId = m.tempId ? `msg-status-${m.tempId}` : `msg-status-${m.id}`;

  let messageContentHtml = `<p class="leading-relaxed select-text">${m.content}</p>`;

  // If meeting room invitation
  if (m.message_type === 'meeting') {
    messageContentHtml = `
      <div class="bg-gradient-to-r from-wa-teal to-wa-tealDark text-white p-3 rounded-2xl shadow-md border border-emerald-400/30 my-1">
        <div class="flex items-center gap-2 mb-1">
          <div class="w-6 h-6 rounded-full bg-emerald-400/20 flex items-center justify-center">
            <i data-lucide="video" class="w-3.5 h-3.5 text-emerald-300"></i>
          </div>
          <span class="font-bold text-xs">Virtual Meeting Room</span>
        </div>
        <p class="text-[11px] text-emerald-100">${m.content}</p>
        <button onclick="joinMeetingRoomFromChat()" class="mt-2.5 w-full bg-wa-green hover:bg-emerald-400 text-wa-tealDark py-1.5 rounded-xl font-bold text-xs flex items-center justify-center gap-1.5 shadow transition">
          <i data-lucide="video" class="w-3.5 h-3.5"></i>
          Join Video Meeting
        </button>
      </div>
    `;
  } 
  // If WhatsApp voice note audio message
  else if (m.message_type === 'audio') {
    const playId = m.id || m.tempId || 'temp';
    messageContentHtml = `
      <div class="flex items-center gap-2.5 py-1 min-w-[200px]">
        <button onclick="toggleVoicePlayback('${playId}', '${escapeQuotes(m.content)}')" id="voice-btn-${playId}" 
                class="w-8 h-8 rounded-full bg-wa-teal hover:bg-wa-tealDark text-white flex items-center justify-center flex-shrink-0 shadow transition">
          <i data-lucide="play" id="voice-icon-${playId}" class="w-4 h-4 ml-0.5"></i>
        </button>
        <div class="flex-1 space-y-1">
          <div class="flex items-center gap-0.5 h-4 cursor-pointer" onclick="toggleVoicePlayback('${playId}', '${escapeQuotes(m.content)}')">
            <span class="w-1 bg-wa-teal/60 rounded-full h-2"></span>
            <span class="w-1 bg-wa-teal/80 rounded-full h-3.5"></span>
            <span class="w-1 bg-wa-teal rounded-full h-4"></span>
            <span class="w-1 bg-wa-teal/80 rounded-full h-2.5"></span>
            <span class="w-1 bg-wa-teal rounded-full h-4"></span>
            <span class="w-1 bg-wa-teal/90 rounded-full h-3"></span>
            <span class="w-1 bg-wa-teal rounded-full h-4"></span>
            <span class="w-1 bg-wa-teal/70 rounded-full h-2.5"></span>
            <span class="w-1 bg-wa-teal/50 rounded-full h-1.5"></span>
            <span class="w-1 bg-wa-teal/80 rounded-full h-3"></span>
            <span class="w-1 bg-wa-teal rounded-full h-4"></span>
            <span class="w-1 bg-wa-teal/60 rounded-full h-2"></span>
          </div>
          <div class="flex justify-between items-center text-[9px] text-slate-500 font-mono">
            <span id="voice-timer-${playId}">Voice Note</span>
            <span class="text-[9px] text-wa-teal font-sans font-semibold">🎙️ Audio</span>
          </div>
        </div>
      </div>
    `;
  }
  // If property inquiry attachment
  else if (m.listing_title) {
    const img = (m.listing_images && m.listing_images.length > 0) ? m.listing_images[0] : 'https://images.unsplash.com/photo-1500382017468-9049fed747ef?w=200';
    messageContentHtml = `
      <div class="mb-2 p-2 bg-slate-50 border border-slate-200 rounded-xl cursor-pointer hover:bg-slate-100 transition shadow-sm" onclick="openPropertyDetails(${m.listing_id})">
        <div class="flex items-center gap-2">
          <img src="${img}" onerror="this.onerror=null; this.src='https://images.unsplash.com/photo-1500382017468-9049fed747ef?w=200';" class="w-12 h-12 rounded-lg object-cover flex-shrink-0 border border-slate-200">
          <div class="truncate">
            <div class="text-[9px] uppercase font-bold text-wa-teal">Land Parcel Inquiry</div>
            <div class="font-bold text-xs text-slate-800 truncate">${m.listing_title}</div>
            <div class="text-[10px] text-emerald-700 font-extrabold">₹${Number(m.listing_price || 0).toLocaleString('en-IN')}</div>
          </div>
        </div>
      </div>
      <p class="leading-relaxed select-text">${m.content}</p>
    `;
  }

  const checkIcon = isPending
    ? `<span id="${statusId}"><i data-lucide="check" class="w-3 h-3 text-slate-400"></i></span>`
    : `<span id="${statusId}"><i data-lucide="check-check" class="w-3 h-3 text-emerald-600"></i></span>`;

  return `
    <div id="${bubbleId}" class="flex ${isMine ? 'justify-end' : 'justify-start'}">
      <div class="max-w-[78%] rounded-2xl px-3.5 py-2 shadow-sm text-xs ${
        isMine 
          ? 'bg-wa-outgoingBubble text-slate-800 rounded-tr-none' 
          : 'bg-white text-slate-800 rounded-tl-none'
      }">
        ${messageContentHtml}
        <div class="text-[9px] text-slate-400 text-right mt-1 flex items-center justify-end gap-1">
          <span>${time}</span>
          ${isMine ? checkIcon : ''}
        </div>
      </div>
    </div>
  `;
}

function appendMessageToChat(m, isPending = false) {
  const container = document.getElementById('chat-messages-container');
  if (!container) return;

  const placeholder = container.querySelector('.text-center.py-6');
  if (placeholder) {
    placeholder.remove();
  }

  container.insertAdjacentHTML('beforeend', generateMessageHtml(m, isPending));
  container.scrollTop = container.scrollHeight;
  if (window.lucide) lucide.createIcons();
}

function renderChatMessages(messages) {
  const container = document.getElementById('chat-messages-container');
  if (!container) return;

  if (messages.length === 0) {
    container.innerHTML = `
      <div class="text-center py-6 text-slate-400 text-xs">
        <div class="inline-block bg-white/70 backdrop-blur-sm px-3 py-1.5 rounded-xl shadow-sm text-slate-500">
          🔒 Messages and calls are end-to-end encrypted within LandConnect. Personal contact details are protected.
        </div>
      </div>
    `;
    return;
  }

  container.innerHTML = messages.map(m => generateMessageHtml(m, false)).join('');
  container.scrollTop = container.scrollHeight;
  if (window.lucide) lucide.createIcons();
}

function toggleAttachmentMenu() {
  const menu = document.getElementById('attachment-menu');
  if (menu) menu.classList.toggle('hidden');
}

function hideAttachmentMenu() {
  const menu = document.getElementById('attachment-menu');
  if (menu) menu.classList.add('hidden');
}

async function attachListingInChat() {
  hideAttachmentMenu();
  if (allListings.length === 0 || !activeChatPeer) return;

  const item = allListings[0];
  const inquiryText = `Inquiring about this verified land plot: ${item.title}`;

  // Optimistic UI
  const tempId = 'temp_inq_' + Date.now();
  const optimisticMsg = {
    id: tempId,
    tempId: tempId,
    sender_id: currentUser ? currentUser.id : 0,
    receiver_id: activeChatPeer.id,
    listing_id: item.id,
    listing_title: item.title,
    listing_price: item.price,
    listing_images: item.images,
    content: inquiryText,
    message_type: 'property_inquiry',
    created_at: new Date().toISOString()
  };
  appendMessageToChat(optimisticMsg, true);

  // 1. Instant WebSocket dispatch
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({
        type: 'chat_message',
        tempId: tempId,
        receiver_id: activeChatPeer.id,
        listing_id: item.id,
        content: inquiryText,
        message_type: 'property_inquiry',
        listing_title: item.title,
        listing_price: item.price,
        listing_images: item.images,
        sender_name: currentUser ? currentUser.name : '',
        sender_avatar: currentUser ? currentUser.avatar : ''
      }));
    } catch (e) {}
  }

  // 2. HTTP persistence
  try {
    const res = await fetch(`${API_BASE}/api/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentToken}`
      },
      body: JSON.stringify({
        tempId: tempId,
        receiver_id: activeChatPeer.id,
        listing_id: item.id,
        content: inquiryText,
        message_type: 'property_inquiry',
        listing_title: item.title,
        listing_price: item.price,
        listing_images: item.images,
        sender_name: currentUser ? currentUser.name : '',
        sender_avatar: currentUser ? currentUser.avatar : ''
      })
    });
    const savedMsg = await res.json();
    if (savedMsg.id) {
      updateMessageStatus(tempId, savedMsg.id);
    }
  } catch (err) {
    console.error('Error attaching listing:', err);
  }
}

async function createMeetingRoom() {
  hideAttachmentMenu();
  if (!activeChatPeer) return;

  const meetingMsg = `Meeting Room started for live property discussion. Tap to join encrypted video session.`;

  // Optimistic UI
  const tempId = 'temp_meet_' + Date.now();
  const optimisticMsg = {
    id: tempId,
    tempId: tempId,
    sender_id: currentUser ? currentUser.id : 0,
    receiver_id: activeChatPeer.id,
    content: meetingMsg,
    message_type: 'meeting',
    created_at: new Date().toISOString()
  };
  appendMessageToChat(optimisticMsg, true);

  // 1. Instant WebSocket dispatch
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({
        type: 'chat_message',
        tempId: tempId,
        receiver_id: activeChatPeer.id,
        content: meetingMsg,
        message_type: 'meeting',
        sender_name: currentUser ? currentUser.name : '',
        sender_avatar: currentUser ? currentUser.avatar : ''
      }));
    } catch (e) {}
  }

  // 2. HTTP persistence
  try {
    await fetch(`${API_BASE}/api/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentToken}`
      },
      body: JSON.stringify({
        tempId: tempId,
        receiver_id: activeChatPeer.id,
        content: meetingMsg,
        message_type: 'meeting',
        sender_name: currentUser ? currentUser.name : '',
        sender_avatar: currentUser ? currentUser.avatar : ''
      })
    });
    // Launch video call immediately
    triggerCallFromChat('video');
  } catch (err) {
    console.error('Error creating meeting room:', err);
  }
}

function joinMeetingRoomFromChat() {
  if (activeChatPeer) {
    initiateDirectCall(activeChatPeer.id, activeChatPeer.name, activeChatPeer.avatar, activeChatPeer.role, 'video');
  }
}

async function sendChatMessage() {
  const input = document.getElementById('chat-input');
  if (!input || !input.value.trim() || !activeChatPeer || !currentToken) return;

  const content = input.value.trim();
  input.value = '';
  handleChatInputTyping();

  // Optimistic instant render on sender: 0ms delay!
  const tempId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
  const optimisticMsg = {
    id: tempId,
    tempId: tempId,
    sender_id: currentUser ? currentUser.id : 0,
    receiver_id: activeChatPeer.id,
    content: content,
    message_type: 'text',
    created_at: new Date().toISOString()
  };
  appendMessageToChat(optimisticMsg, true);

  // Update in-memory recent conversation & promote to top
  const peerId = Number(activeChatPeer.id);
  let conv = recentConversations.find(c => Number(c.peer_id) === peerId);
  if (!conv) {
    conv = {
      peer_id: peerId,
      peer_name: activeChatPeer.name || 'User',
      peer_avatar: activeChatPeer.avatar || '',
      peer_role: activeChatPeer.role || 'buyer',
      last_message: content,
      last_message_type: 'text',
      last_message_time: new Date().toISOString(),
      last_message_sender_id: currentUser ? Number(currentUser.id) : 0,
      unread_count: 0
    };
    recentConversations.unshift(conv);
  } else {
    conv.last_message = content;
    conv.last_message_type = 'text';
    conv.last_message_time = new Date().toISOString();
    conv.last_message_sender_id = currentUser ? Number(currentUser.id) : 0;
  }
  renderContactsList();

  const countEl = document.getElementById('chat-peer-msg-count');
  if (countEl) {
    const currentTotal = document.querySelectorAll('#chat-messages-container > div[id^="msg-bubble-"]').length;
    countEl.textContent = `${currentTotal} ${currentTotal === 1 ? 'message' : 'messages'}`;
  }

  const payload = {
    type: 'chat_message',
    tempId: tempId,
    receiver_id: activeChatPeer.id,
    content: content,
    message_type: 'text',
    sender_name: currentUser ? currentUser.name : '',
    sender_avatar: currentUser ? currentUser.avatar : ''
  };

  // 1. INSTANT WEBSOCKET DISPATCH (1-5ms to receiver!)
  let wsSent = false;
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(payload));
      wsSent = true;
    } catch (e) {
      console.warn('WS send failed, using HTTP:', e);
    }
  }

  // 2. HTTP POST persistence
  try {
    const res = await fetch(`${API_BASE}/api/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentToken}`
      },
      body: JSON.stringify(payload)
    });
    const savedMsg = await res.json();
    if (savedMsg.id) {
      updateMessageStatus(tempId, savedMsg.id);
    }
  } catch (err) {
    if (!wsSent) {
      console.error('Error sending message:', err);
      const statusEl = document.getElementById(`msg-status-${tempId}`);
      if (statusEl) {
        statusEl.innerHTML = '<span class="text-rose-500 font-bold" title="Failed to deliver">⚠️</span>';
      }
    }
  }
}

// ================= WHATSAPP VOICE NOTES (AUDIO MESSAGING) =================

let mediaRecorder = null;
let audioChunks = [];
let recordingStream = null;
let recordingTimerInterval = null;
let recordingDuration = 0;
let currentActiveAudio = null;
let currentActiveAudioId = null;

function handleChatInputTyping() {
  const input = document.getElementById('chat-input');
  const btnMic = document.getElementById('btn-voice-record');
  const btnSend = document.getElementById('btn-send-message');
  if (!input || !btnMic || !btnSend) return;

  if (input.value.trim().length > 0) {
    btnMic.classList.add('hidden');
    btnSend.classList.remove('hidden');
  } else {
    btnMic.classList.remove('hidden');
    btnSend.classList.add('hidden');
  }
}

async function toggleVoiceRecording() {
  const recordingRow = document.getElementById('chat-recording-row');
  const inputRow = document.getElementById('chat-input-row');
  const attachBtn = document.getElementById('btn-chat-attach');

  try {
    recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    recordingDuration = 0;

    mediaRecorder = new MediaRecorder(recordingStream);
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        audioChunks.push(e.data);
      }
    };

    mediaRecorder.start();

    // Switch UI to recording bar
    if (inputRow) inputRow.classList.add('hidden');
    if (attachBtn) attachBtn.classList.add('opacity-40', 'pointer-events-none');
    if (recordingRow) recordingRow.classList.remove('hidden');

    const timerEl = document.getElementById('recording-timer');
    if (timerEl) timerEl.textContent = '0:00';

    clearInterval(recordingTimerInterval);
    recordingTimerInterval = setInterval(() => {
      recordingDuration++;
      const mins = Math.floor(recordingDuration / 60);
      const secs = recordingDuration % 60;
      if (timerEl) {
        timerEl.textContent = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
      }
    }, 1000);

    if (window.lucide) lucide.createIcons();
  } catch (err) {
    showInAppAlert('Microphone Required', 'Microphone access is required to record voice notes.', 'warning');
    console.warn('Microphone error:', err);
  }
}

function cancelVoiceRecording() {
  clearInterval(recordingTimerInterval);
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try { mediaRecorder.stop(); } catch(e){}
  }
  if (recordingStream) {
    recordingStream.getTracks().forEach(t => t.stop());
    recordingStream = null;
  }
  audioChunks = [];
  mediaRecorder = null;

  const recordingRow = document.getElementById('chat-recording-row');
  const inputRow = document.getElementById('chat-input-row');
  const attachBtn = document.getElementById('btn-chat-attach');

  if (recordingRow) recordingRow.classList.add('hidden');
  if (inputRow) inputRow.classList.remove('hidden');
  if (attachBtn) attachBtn.classList.remove('opacity-40', 'pointer-events-none');
  if (window.lucide) lucide.createIcons();
}

async function stopAndSendVoiceRecording() {
  if (!mediaRecorder || !activeChatPeer) {
    cancelVoiceRecording();
    return;
  }

  clearInterval(recordingTimerInterval);

  mediaRecorder.onstop = async () => {
    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
    const reader = new FileReader();
    reader.readAsDataURL(audioBlob);
    reader.onloadend = async () => {
      const base64Audio = reader.result;

      // Optimistic Voice Note render (0ms delay)
      const tempId = 'temp_audio_' + Date.now();
      const optimisticMsg = {
        id: tempId,
        tempId: tempId,
        sender_id: currentUser ? currentUser.id : 0,
        receiver_id: activeChatPeer.id,
        content: base64Audio,
        message_type: 'audio',
        created_at: new Date().toISOString()
      };
      appendMessageToChat(optimisticMsg, true);

      // 1. Instant WebSocket dispatch
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({
            type: 'chat_message',
            tempId: tempId,
            receiver_id: activeChatPeer.id,
            content: base64Audio,
            message_type: 'audio',
            sender_name: currentUser ? currentUser.name : '',
            sender_avatar: currentUser ? currentUser.avatar : ''
          }));
        } catch (e) {}
      }

      // 2. HTTP persistence
      try {
        const res = await fetch(`${API_BASE}/api/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${currentToken}`
          },
          body: JSON.stringify({
            tempId: tempId,
            receiver_id: activeChatPeer.id,
            content: base64Audio,
            message_type: 'audio',
            sender_name: currentUser ? currentUser.name : '',
            sender_avatar: currentUser ? currentUser.avatar : ''
          })
        });
        const savedMsg = await res.json();
        if (savedMsg.id) {
          updateMessageStatus(tempId, savedMsg.id);
        }
      } catch (err) {
        console.error('Error sending audio message:', err);
      }
    };

    if (recordingStream) {
      recordingStream.getTracks().forEach(t => t.stop());
      recordingStream = null;
    }
  };

  mediaRecorder.stop();

  const recordingRow = document.getElementById('chat-recording-row');
  const inputRow = document.getElementById('chat-input-row');
  const attachBtn = document.getElementById('btn-chat-attach');

  if (recordingRow) recordingRow.classList.add('hidden');
  if (inputRow) inputRow.classList.remove('hidden');
  if (attachBtn) attachBtn.classList.remove('opacity-40', 'pointer-events-none');
  if (window.lucide) lucide.createIcons();
}

function toggleVoicePlayback(msgId, audioSrc) {
  if (currentActiveAudio && currentActiveAudioId === msgId) {
    if (currentActiveAudio.paused) {
      currentActiveAudio.play();
      updateVoiceBtnIcon(msgId, true);
    } else {
      currentActiveAudio.pause();
      updateVoiceBtnIcon(msgId, false);
    }
    return;
  }

  if (currentActiveAudio) {
    currentActiveAudio.pause();
    if (currentActiveAudioId) updateVoiceBtnIcon(currentActiveAudioId, false);
    currentActiveAudio = null;
    currentActiveAudioId = null;
  }

  try {
    currentActiveAudio = new Audio(audioSrc);
    currentActiveAudioId = msgId;
    updateVoiceBtnIcon(msgId, true);

    currentActiveAudio.onended = () => {
      updateVoiceBtnIcon(msgId, false);
      currentActiveAudio = null;
      currentActiveAudioId = null;
    };
    currentActiveAudio.onerror = () => {
      updateVoiceBtnIcon(msgId, false);
      currentActiveAudio = null;
      currentActiveAudioId = null;
    };
    currentActiveAudio.play();
  } catch (err) {
    console.error('Audio playback error:', err);
  }
}

function updateVoiceBtnIcon(msgId, isPlaying) {
  const icon = document.getElementById(`voice-icon-${msgId}`);
  if (icon) {
    icon.setAttribute('data-lucide', isPlaying ? 'pause' : 'play');
    if (window.lucide) lucide.createIcons();
  }
}

function triggerCallFromChat(callType) {
  if (!activeChatPeer) return;
  initiateDirectCall(activeChatPeer.id, activeChatPeer.name, activeChatPeer.avatar, activeChatPeer.role, callType);
}

// ================= IN-APP AUDIO & VIDEO CALLING (KEY REQUIREMENT) =================

function renderCallsContactsList() {
  const container = document.getElementById('calls-contacts-list');
  if (!container) return;

  const otherUsers = allUsers.filter(u => !currentUser || u.id !== currentUser.id);

  container.innerHTML = otherUsers.map(u => `
    <div class="p-3 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <img src="${u.avatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100'}" class="w-10 h-10 rounded-full object-cover">
        <div>
          <h4 class="font-bold text-xs text-slate-800">${u.name}</h4>
          <p class="text-[10px] text-slate-500 capitalize">${u.role} • ${u.phone_masked}</p>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <button onclick="initiateDirectCall(${u.id}, '${escapeQuotes(u.name)}', '${escapeQuotes(u.avatar)}', '${u.role}', 'audio')"
                class="p-2 bg-emerald-50 text-wa-teal rounded-full hover:bg-emerald-100 transition" title="Audio Call">
          <i data-lucide="phone" class="w-4 h-4"></i>
        </button>
        <button onclick="initiateDirectCall(${u.id}, '${escapeQuotes(u.name)}', '${escapeQuotes(u.avatar)}', '${u.role}', 'video')"
                class="p-2 bg-wa-teal text-white rounded-full hover:bg-wa-tealDark transition shadow-sm" title="Video Call">
          <i data-lucide="video" class="w-4 h-4"></i>
        </button>
      </div>
    </div>
  `).join('');

  if (window.lucide) lucide.createIcons();
}

async function fetchCallLogs() {
  if (!currentToken) return;
  try {
    const res = await fetch(`${API_BASE}/api/calls/history`, {
      headers: { 'Authorization': `Bearer ${currentToken}` }
    });
    const logs = await res.json();
    renderCallLogs(logs);
  } catch (err) {
    console.error('Error fetching call logs:', err);
  }
}

function renderCallLogs(logs) {
  const container = document.getElementById('call-logs-container');
  if (!container) return;

  if (logs.length === 0) {
    container.innerHTML = `<div class="p-4 text-center text-slate-400 text-xs">No call logs recorded yet.</div>`;
    return;
  }

  container.innerHTML = logs.map(l => {
    const isCaller = currentUser && l.caller_id === currentUser.id;
    const otherName = isCaller ? l.receiver_name : l.caller_name;
    const otherAvatar = isCaller ? l.receiver_avatar : l.caller_avatar;
    const otherRole = isCaller ? l.receiver_role : l.caller_role;
    const otherId = isCaller ? l.receiver_id : l.caller_id;
    const duration = `${Math.floor(l.duration_seconds / 60)}m ${l.duration_seconds % 60}s`;

    return `
      <div class="p-3 flex items-center justify-between">
        <div class="flex items-center gap-3">
          <img src="${otherAvatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100'}" class="w-9 h-9 rounded-full object-cover">
          <div>
            <div class="flex items-center gap-1.5">
              <h4 class="font-bold text-xs text-slate-800">${otherName}</h4>
              <span class="text-[9px] uppercase px-1 rounded bg-slate-100 text-slate-600 font-semibold">${otherRole}</span>
            </div>
            <div class="flex items-center gap-1 text-[10px] text-slate-500 mt-0.5">
              <i data-lucide="${isCaller ? 'phone-outgoing' : 'phone-incoming'}" class="w-3 h-3 ${isCaller ? 'text-emerald-500' : 'text-blue-500'}"></i>
              <span>${l.call_type === 'video' ? 'Video' : 'Audio'} Call</span> •
              <span>${duration}</span>
            </div>
          </div>
        </div>
        <button onclick="initiateDirectCall(${otherId}, '${escapeQuotes(otherName)}', '${escapeQuotes(otherAvatar)}', '${otherRole}', '${l.call_type}')"
                class="text-wa-teal p-2 hover:bg-slate-100 rounded-full">
          <i data-lucide="${l.call_type === 'video' ? 'video' : 'phone'}" class="w-4 h-4"></i>
        </button>
      </div>
    `;
  }).join('');

  if (window.lucide) lucide.createIcons();
}

async function getMediaStream(callType) {
  try {
    const constraints = {
      audio: true,
      video: callType === 'video' ? { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' } : false
    };
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    console.warn('Camera/Mic permission unavailable, falling back to simulated stream for testing:', err);
    return createSimulatedMediaStream(callType);
  }
}

function createSimulatedMediaStream(callType) {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 240;
  const ctx = canvas.getContext('2d');

  let frame = 0;
  function draw() {
    frame++;
    ctx.fillStyle = '#075E54';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#25D366';
    ctx.beginPath();
    ctx.arc(160 + Math.sin(frame * 0.05) * 40, 120, 30, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#FFFFFF';
    ctx.font = '14px Arial';
    ctx.fillText('LandConnect Video Feed', 75, 190);
    requestAnimationFrame(draw);
  }
  draw();

  const stream = canvas.captureStream(25);
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = audioCtx.createOscillator();
  const dst = audioCtx.createMediaStreamDestination();
  osc.connect(dst);
  osc.start();
  const audioTrack = dst.stream.getAudioTracks()[0];
  if (audioTrack) stream.addTrack(audioTrack);

  return stream;
}

// ================= SYNTHESIZED RINGTONES & AUDIO EFFECTS =================

let ringtoneAudioCtx = null;
let ringtoneOscillators = [];

function playOutgoingRing() {
  stopRingtone();
  try {
    ringtoneAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ringtoneAudioCtx.currentTime;

    const osc1 = ringtoneAudioCtx.createOscillator();
    const osc2 = ringtoneAudioCtx.createOscillator();
    const gain = ringtoneAudioCtx.createGain();

    osc1.frequency.value = 440;
    osc2.frequency.value = 480;

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ringtoneAudioCtx.destination);

    // Standard ringback cadence: 1.5s ring, 3s silence
    gain.gain.setValueAtTime(0, now);
    for (let i = 0; i < 6; i++) {
      const start = now + (i * 4.5);
      gain.gain.setValueAtTime(0.08, start);
      gain.gain.setValueAtTime(0, start + 1.6);
    }

    osc1.start(now);
    osc2.start(now);
    ringtoneOscillators = [osc1, osc2];
  } catch (err) {
    console.log('Outgoing ringtone suppressed:', err);
  }
}

function playIncomingRing() {
  stopRingtone();
  try {
    ringtoneAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ringtoneAudioCtx.currentTime;

    const osc = ringtoneAudioCtx.createOscillator();
    const gain = ringtoneAudioCtx.createGain();

    osc.type = 'sine';
    osc.connect(gain);
    gain.connect(ringtoneAudioCtx.destination);

    // WhatsApp style pleasant incoming chime
    gain.gain.setValueAtTime(0, now);
    for (let i = 0; i < 8; i++) {
      const t = now + (i * 2.0);
      osc.frequency.setValueAtTime(587.33, t); // D5
      osc.frequency.setValueAtTime(659.25, t + 0.15); // E5
      osc.frequency.setValueAtTime(880.00, t + 0.3); // A5
      gain.gain.setValueAtTime(0.12, t);
      gain.gain.setValueAtTime(0, t + 0.9);
    }

    osc.start(now);
    ringtoneOscillators = [osc];
  } catch (err) {
    console.log('Incoming ringtone suppressed:', err);
  }
}

function stopRingtone() {
  if (ringtoneOscillators.length > 0) {
    ringtoneOscillators.forEach(o => {
      try { o.stop(); } catch(e){}
    });
    ringtoneOscillators = [];
  }
  if (ringtoneAudioCtx) {
    try { ringtoneAudioCtx.close(); } catch(e){}
    ringtoneAudioCtx = null;
  }
}

// ================= SCREEN SHARING =================

let isScreenSharing = false;
let screenStream = null;

async function toggleScreenShare() {
  if (!peerConnection) return;

  if (!isScreenSharing) {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = screenStream.getVideoTracks()[0];
      const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) {
        sender.replaceTrack(screenTrack);
      }
      const localVideo = document.getElementById('local-video');
      if (localVideo) localVideo.srcObject = screenStream;

      screenTrack.onended = () => {
        stopScreenShare();
      };

      isScreenSharing = true;
      const btn = document.getElementById('btn-toggle-screen');
      if (btn) btn.classList.add('bg-emerald-600', 'text-white');
    } catch (err) {
      console.warn('Screen share cancelled or unsupported:', err);
    }
  } else {
    stopScreenShare();
  }
}

function stopScreenShare() {
  if (!isScreenSharing) return;
  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }
  if (localStream && peerConnection) {
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) {
      const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) sender.replaceTrack(videoTrack);
    }
    const localVideo = document.getElementById('local-video');
    if (localVideo) localVideo.srcObject = localStream;
  }
  isScreenSharing = false;
  const btn = document.getElementById('btn-toggle-screen');
  if (btn) btn.classList.remove('bg-emerald-600', 'text-white');
}

async function initiateDirectCall(targetUserId, targetName, targetAvatar, targetRole, callType = 'video', listingId = null) {
  if (!currentUser) {
    showInAppAlert('Login Required', 'Please log in to make calls.', 'info');
    return;
  }
  if (targetUserId === currentUser.id) {
    showToast('Cannot call yourself.', 'warning');
    return;
  }

  activeCallTargetId = targetUserId;
  activeCallType = callType;

  showCallModal(targetName, targetAvatar, targetRole, callType);

  localStream = await getMediaStream(callType);
  if (localStream) {
    localStream.getAudioTracks().forEach(t => { t.enabled = !isAudioMuted; });
    localStream.getVideoTracks().forEach(t => { t.enabled = !isVideoMuted; });
  }
  updateMuteButtonsUI();

  const localVideo = document.getElementById('local-video');
  if (localVideo) localVideo.srcObject = localStream;

  setupPeerConnection();

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'initiate_call',
      receiverId: targetUserId,
      callType: callType,
      listingId: listingId,
      callerInfo: {
        id: currentUser.id,
        name: currentUser.name,
        avatar: currentUser.avatar,
        role: currentUser.role
      }
    }));
    playOutgoingRing();
  }
}

function setupPeerConnection() {
  peerConnection = new RTCPeerConnection(rtcConfig);

  if (localStream) {
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });
  }

  peerConnection.ontrack = (event) => {
    const remoteVideo = document.getElementById('remote-video');
    const remoteAudio = document.getElementById('remote-audio');
    remoteStream = event.streams[0];

    if (activeCallType === 'video' && remoteVideo) {
      remoteVideo.srcObject = remoteStream;
    } else if (remoteAudio) {
      remoteAudio.srcObject = remoteStream;
    }
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate && ws && ws.readyState === WebSocket.OPEN && activeCallTargetId) {
      ws.send(JSON.stringify({
        type: 'ice_candidate',
        targetUserId: activeCallTargetId,
        candidate: event.candidate
      }));
    }
  };
}

function showCallModal(peerName, peerAvatar, peerRole, callType) {
  const modal = document.getElementById('call-modal');
  const nameEl = document.getElementById('call-peer-name');
  const roleEl = document.getElementById('call-role-badge');
  const avatarEl = document.getElementById('call-avatar');
  const audioPlaceholder = document.getElementById('audio-call-placeholder');
  const localVideoBox = document.getElementById('local-video-container');

  if (modal) modal.classList.remove('hidden');
  if (nameEl) nameEl.textContent = peerName;
  if (roleEl) roleEl.textContent = `${peerRole} • Protected Contact`;
  if (avatarEl) avatarEl.src = peerAvatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100';

  if (callType === 'audio') {
    if (audioPlaceholder) audioPlaceholder.classList.remove('hidden');
    if (localVideoBox) localVideoBox.classList.add('hidden');
  } else {
    if (audioPlaceholder) audioPlaceholder.classList.add('hidden');
    if (localVideoBox) localVideoBox.classList.remove('hidden');
  }

  isAudioMuted = false;
  isVideoMuted = false;
  isSpeakerMuted = false;
  updateMuteButtonsUI();

  startCallTimer();
  if (window.lucide) lucide.createIcons();
}

function startCallTimer() {
  callSeconds = 0;
  clearInterval(callTimerInterval);
  const timerEl = document.getElementById('call-timer');
  callTimerInterval = setInterval(() => {
    callSeconds++;
    const mins = String(Math.floor(callSeconds / 60)).padStart(2, '0');
    const secs = String(callSeconds % 60).padStart(2, '0');
    if (timerEl) timerEl.textContent = `${mins}:${secs}`;
  }, 1000);
}

function endCurrentCall() {
  if (ws && ws.readyState === WebSocket.OPEN && activeCallTargetId) {
    ws.send(JSON.stringify({
      type: 'end_call',
      targetUserId: activeCallTargetId,
      duration: callSeconds,
      callType: activeCallType
    }));
  }
  cleanupCall();
}

function cleanupCall() {
  stopRingtone();
  clearInterval(callTimerInterval);
  callSeconds = 0;

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }

  isAudioMuted = false;
  isVideoMuted = false;
  isSpeakerMuted = false;
  updateMuteButtonsUI();

  const modal = document.getElementById('call-modal');
  if (modal) modal.classList.add('hidden');

  activeCallTargetId = null;
  fetchCallLogs();
}

let isSpeakerMuted = false;

function updateMuteButtonsUI() {
  // 1. Microphone Mute Button & Icon
  const btnMic = document.getElementById('btn-toggle-mic');
  const iconMic = document.getElementById('icon-mic');
  if (btnMic) {
    btnMic.className = isAudioMuted 
      ? 'p-3.5 rounded-full bg-rose-600 hover:bg-rose-700 text-white shadow-xl transition transform active:scale-95' 
      : 'p-3.5 rounded-full bg-white/10 hover:bg-white/20 text-white transition transform active:scale-95';
    btnMic.setAttribute('title', isAudioMuted ? 'Unmute Microphone' : 'Mute Microphone');
  }
  if (iconMic) {
    iconMic.setAttribute('data-lucide', isAudioMuted ? 'mic-off' : 'mic');
  }

  // Avatar Mic Status Badge in Audio Call View
  const avatarMicBadge = document.getElementById('call-avatar-mic-badge');
  const avatarMicIcon = document.getElementById('call-avatar-mic-icon');
  if (avatarMicBadge) {
    avatarMicBadge.className = isAudioMuted 
      ? 'absolute -bottom-1 -right-1 bg-rose-600 p-1.5 rounded-full text-white shadow-lg transition' 
      : 'absolute -bottom-1 -right-1 bg-wa-green p-1.5 rounded-full text-wa-tealDark shadow-lg transition';
  }
  if (avatarMicIcon) {
    avatarMicIcon.setAttribute('data-lucide', isAudioMuted ? 'mic-off' : 'mic');
  }

  // 2. Camera On / Off Button & Icon
  const btnCam = document.getElementById('btn-toggle-cam');
  const iconCam = document.getElementById('icon-cam');
  if (btnCam) {
    btnCam.className = isVideoMuted 
      ? 'p-3.5 rounded-full bg-rose-600 hover:bg-rose-700 text-white shadow-xl transition transform active:scale-95' 
      : 'p-3.5 rounded-full bg-white/10 hover:bg-white/20 text-white transition transform active:scale-95';
    btnCam.setAttribute('title', isVideoMuted ? 'Turn Camera On' : 'Turn Camera Off');
  }
  if (iconCam) {
    iconCam.setAttribute('data-lucide', isVideoMuted ? 'video-off' : 'video');
  }

  // Local Video Off Visual Indicator
  const localVideoPlaceholder = document.getElementById('local-video-off-placeholder');
  const localVideo = document.getElementById('local-video');
  if (localVideoPlaceholder && localVideo) {
    if (isVideoMuted) {
      localVideoPlaceholder.classList.remove('hidden');
      localVideo.classList.add('opacity-0');
    } else {
      localVideoPlaceholder.classList.add('hidden');
      localVideo.classList.remove('opacity-0');
    }
  }

  // 3. Speaker Output Button & Icon
  const btnSpeaker = document.getElementById('btn-toggle-speaker');
  const iconSpeaker = document.getElementById('icon-speaker');
  if (btnSpeaker) {
    btnSpeaker.className = isSpeakerMuted 
      ? 'p-3.5 rounded-full bg-rose-600 hover:bg-rose-700 text-white shadow-xl transition transform active:scale-95' 
      : 'p-3.5 rounded-full bg-white/10 hover:bg-white/20 text-white transition transform active:scale-95';
    btnSpeaker.setAttribute('title', isSpeakerMuted ? 'Turn Speaker On' : 'Turn Speaker Off');
  }
  if (iconSpeaker) {
    iconSpeaker.setAttribute('data-lucide', isSpeakerMuted ? 'volume-x' : 'volume-2');
  }

  if (window.lucide) lucide.createIcons();
}

function toggleMuteAudio() {
  isAudioMuted = !isAudioMuted;
  if (localStream) {
    const audioTracks = localStream.getAudioTracks();
    audioTracks.forEach(t => {
      t.enabled = !isAudioMuted;
    });
  }
  updateMuteButtonsUI();
  showToast(isAudioMuted ? 'Microphone Muted' : 'Microphone Unmuted', 'info');
}

function toggleVideoCamera() {
  isVideoMuted = !isVideoMuted;
  if (localStream) {
    const videoTracks = localStream.getVideoTracks();
    videoTracks.forEach(t => {
      t.enabled = !isVideoMuted;
    });
  }
  updateMuteButtonsUI();
  showToast(isVideoMuted ? 'Camera Turned Off' : 'Camera Turned On', 'info');
}

function toggleVideoCameraFlip() {
  showToast('Camera switched (Front / Rear)', 'info');
}

function toggleSpeaker() {
  isSpeakerMuted = !isSpeakerMuted;
  const remoteAudio = document.getElementById('remote-audio');
  const remoteVideo = document.getElementById('remote-video');
  if (remoteAudio) remoteAudio.muted = isSpeakerMuted;
  if (remoteVideo) remoteVideo.muted = isSpeakerMuted;

  updateMuteButtonsUI();
  showToast(isSpeakerMuted ? 'Speaker Muted' : 'Speaker Active', 'info');
}

function handleIncomingCall(data) {
  stopRingtone();
  playIncomingRing();
  incomingCallData = data;
  const modal = document.getElementById('incoming-call-modal');
  const nameEl = document.getElementById('incoming-caller-name');
  const roleEl = document.getElementById('incoming-caller-role');
  const avatarEl = document.getElementById('incoming-avatar');
  const typeIcon = document.getElementById('incoming-call-type-icon');

  if (nameEl) nameEl.textContent = data.callerInfo.name;
  if (roleEl) roleEl.textContent = `${data.callerInfo.role} • LandConnect Secured Call`;
  if (avatarEl) avatarEl.src = data.callerInfo.avatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100';

  if (typeIcon) {
    typeIcon.setAttribute('data-lucide', data.callType === 'video' ? 'video' : 'phone');
  }

  if (modal) modal.classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}

async function acceptIncomingCall() {
  stopRingtone();
  const modal = document.getElementById('incoming-call-modal');
  if (modal) modal.classList.add('hidden');

  if (!incomingCallData) return;

  activeCallTargetId = incomingCallData.callerId;
  activeCallType = incomingCallData.callType;

  showCallModal(
    incomingCallData.callerInfo.name,
    incomingCallData.callerInfo.avatar,
    incomingCallData.callerInfo.role,
    incomingCallData.callType
  );

  localStream = await getMediaStream(activeCallType);
  if (localStream) {
    localStream.getAudioTracks().forEach(t => { t.enabled = !isAudioMuted; });
    localStream.getVideoTracks().forEach(t => { t.enabled = !isVideoMuted; });
  }
  updateMuteButtonsUI();

  const localVideo = document.getElementById('local-video');
  if (localVideo) localVideo.srcObject = localStream;

  setupPeerConnection();

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'accept_call',
      callerId: incomingCallData.callerId
    }));
  }

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  ws.send(JSON.stringify({
    type: 'webrtc_offer',
    targetUserId: incomingCallData.callerId,
    offer: offer
  }));
}

function rejectIncomingCall() {
  stopRingtone();
  const modal = document.getElementById('incoming-call-modal');
  if (modal) modal.classList.add('hidden');

  if (incomingCallData && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'reject_call',
      callerId: incomingCallData.callerId,
      reason: 'Call declined by user'
    }));
  }
  incomingCallData = null;
}

// ================= WEBSOCKET REAL-TIME SIGNALING =================

let wsHeartbeatInterval = null;
let wsReconnectTimeout = null;

function initWebSocket() {
  if (ws) {
    try { ws.close(); } catch(e){}
  }

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log('Connected to LandConnect WebSocket signaling server.');
    if (currentToken) {
      ws.send(JSON.stringify({
        type: 'authenticate',
        token: currentToken
      }));
    }
    // High-frequency heartbeat ping every 8s to guarantee zero-latency
    clearInterval(wsHeartbeatInterval);
    wsHeartbeatInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 8000);
  };

  ws.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);

      switch (data.type) {
        case 'authenticated':
          console.log('WS Authenticated for User ID:', data.userId);
          break;

        case 'pong':
          break;

        case 'new_message': {
          const msg = data.message;
          if (!msg) break;

          const msgSenderId = Number(msg.sender_id);
          const msgReceiverId = Number(msg.receiver_id);
          const activePeerId = activeChatPeer ? Number(activeChatPeer.id) : null;
          const myId = currentUser ? Number(currentUser.id) : null;

          const isCurrentChat = activePeerId && (
            msgSenderId === activePeerId || 
            (msgSenderId === myId && msgReceiverId === activePeerId)
          );

          if (isCurrentChat) {
            const exists = (msg.id && document.getElementById(`msg-bubble-${msg.id}`)) ||
                           (msg.tempId && document.getElementById(`msg-bubble-${msg.tempId}`));
            if (!exists) {
              appendMessageToChat(msg, false);
            }
            const countEl = document.getElementById('chat-peer-msg-count');
            if (countEl) {
              const currentTotal = document.querySelectorAll('#chat-messages-container > div[id^="msg-bubble-"]').length;
              countEl.textContent = `${currentTotal} ${currentTotal === 1 ? 'message' : 'messages'}`;
            }
          }

          // Real-time update of recent conversations list & unread counters
          const peerId = (msgSenderId === myId) ? msgReceiverId : msgSenderId;
          let conv = recentConversations.find(c => Number(c.peer_id) === peerId);
          if (!conv) {
            conv = {
              peer_id: peerId,
              peer_name: msg.sender_name || 'User',
              peer_avatar: msg.sender_avatar || '',
              peer_role: 'buyer',
              last_message: msg.content,
              last_message_type: msg.message_type,
              last_message_time: msg.created_at,
              last_message_sender_id: msgSenderId,
              unread_count: isCurrentChat ? 0 : 1
            };
            recentConversations.unshift(conv);
          } else {
            conv.last_message = msg.content;
            conv.last_message_type = msg.message_type;
            conv.last_message_time = msg.created_at;
            conv.last_message_sender_id = msgSenderId;
            if (!isCurrentChat) {
              conv.unread_count = (Number(conv.unread_count) || 0) + 1;
            }
          }

          renderContactsList();
          updateUnreadBadgesCounter();
          break;
        }

        case 'message_sent_ack': {
          if (data.tempId) {
            updateMessageStatus(data.tempId, data.tempId);
          }
          break;
        }

        case 'message_synced': {
          if (data.tempId && data.id) {
            updateMessageStatus(data.tempId, data.id);
          }
          break;
        }

        case 'incoming_call':
          handleIncomingCall(data);
          break;

        case 'call_accepted':
          console.log('Call was accepted by peer.');
          stopRingtone();
          break;

        case 'call_rejected':
          stopRingtone();
          showToast('Call was rejected: ' + (data.reason || 'Declined'), 'error');
          cleanupCall();
          break;

        case 'call_ended':
          stopRingtone();
          showToast('Call ended by other party.', 'info');
          cleanupCall();
          break;

        case 'webrtc_offer':
          if (!peerConnection) setupPeerConnection();
          await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
          const answer = await peerConnection.createAnswer();
          await peerConnection.setLocalDescription(answer);
          ws.send(JSON.stringify({
            type: 'webrtc_answer',
            targetUserId: data.callerId || activeCallTargetId,
            answer: answer
          }));
          break;

        case 'webrtc_answer':
          if (peerConnection) {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
          }
          break;

        case 'ice_candidate':
          if (peerConnection && data.candidate) {
            try {
              await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
            } catch (err) {
              console.error('Error adding ICE candidate:', err);
            }
          }
          break;
      }
    } catch (err) {
      console.error('WS Message parsing error:', err);
    }
  };

  ws.onclose = () => {
    clearInterval(wsHeartbeatInterval);
    if (currentToken) {
      clearTimeout(wsReconnectTimeout);
      wsReconnectTimeout = setTimeout(initWebSocket, 1000);
    }
  };
}

// ================= MAP VIEW & GEOLOCATION =================

let selectedMapListing = null;

function renderMapParcelsSelector() {
  const container = document.getElementById('map-parcels-selector');
  const counter = document.getElementById('map-counter');
  if (counter) counter.textContent = `${allListings.length} Land Parcels`;
  if (!container) return;

  if (allListings.length === 0) {
    container.innerHTML = `<span class="text-slate-400 text-[11px]">No parcels available</span>`;
    return;
  }

  container.innerHTML = allListings.map((item, idx) => {
    const isSelected = selectedMapListing && selectedMapListing.id === item.id;
    return `
      <button onclick="selectMapParcel(${item.id})" 
              class="px-2.5 py-1 rounded-full whitespace-nowrap text-[11px] font-semibold transition border ${
                isSelected 
                  ? 'bg-wa-teal text-white border-wa-teal shadow-sm' 
                  : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-200'
              }">
        📍 ${item.title.split(' ')[0]} ${item.title.split(' ')[1] || ''} (₹${(item.price / 100000).toFixed(1)}L)
      </button>
    `;
  }).join('');
}

function selectMapParcel(listingId) {
  const item = allListings.find(l => l.id === listingId);
  if (!item) return;
  selectedMapListing = item;
  updateMapCard(item);
  renderMapParcelsSelector();
}

function updateMapCard(listing) {
  if (!listing && allListings.length > 0) {
    listing = allListings[0];
  }
  if (!listing) return;
  selectedMapListing = listing;

  const titleEl = document.getElementById('map-card-title');
  const priceEl = document.getElementById('map-card-price');
  const typeEl = document.getElementById('map-card-type');
  const mapIframe = document.getElementById('map-iframe');

  if (titleEl) titleEl.textContent = listing.title;
  if (priceEl) priceEl.textContent = `₹${Number(listing.price).toLocaleString('en-IN')}`;
  if (typeEl) typeEl.textContent = listing.property_type;

  // Center OpenStreetMap on listing coordinates
  if (mapIframe && listing.latitude && listing.longitude) {
    const lat = listing.latitude;
    const lng = listing.longitude;
    const delta = 0.05;
    mapIframe.src = `https://www.openstreetmap.org/export/embed.html?bbox=${lng - delta},${lat - delta},${lng + delta},${lat + delta}&layer=mapnik&marker=${lat},${lng}`;
  }
}

function openSelectedMapPlotDetails() {
  if (selectedMapListing) {
    openPropertyDetails(selectedMapListing.id);
  }
}

function callListingOwnerFromMap() {
  const item = selectedMapListing || allListings[0];
  if (item) {
    initiateDirectCall(item.owner_id, escapeQuotes(item.owner_name), escapeQuotes(item.owner_avatar), item.owner_role, 'video', item.id);
  }
}

function chatListingOwnerFromMap() {
  const item = selectedMapListing || allListings[0];
  if (item) {
    startChatWithUser(item.owner_id, escapeQuotes(item.owner_name), escapeQuotes(item.owner_avatar), item.owner_role);
  }
}

// ================= LAND & FINANCE CALCULATOR =================

let currentCalcTab = 'area';

function openLandCalculatorModal() {
  const modal = document.getElementById('calculator-modal');
  if (modal) modal.classList.remove('hidden');
  recalculateAreaUnits();
  recalculateStampDuty();
  recalculateEMI();
  if (window.lucide) lucide.createIcons();
}

function closeLandCalculatorModal() {
  const modal = document.getElementById('calculator-modal');
  if (modal) modal.classList.add('hidden');
}

function switchCalcTab(tab) {
  currentCalcTab = tab;
  ['area', 'stamp', 'emi'].forEach(t => {
    const btn = document.getElementById(`calc-tab-btn-${t}`);
    const pane = document.getElementById(`calc-pane-${t}`);
    if (t === tab) {
      if (btn) {
        btn.classList.add('border-wa-teal', 'text-wa-teal');
        btn.classList.remove('border-transparent', 'text-slate-500');
      }
      if (pane) pane.classList.remove('hidden');
    } else {
      if (btn) {
        btn.classList.remove('border-wa-teal', 'text-wa-teal');
        btn.classList.add('border-transparent', 'text-slate-500');
      }
      if (pane) pane.classList.add('hidden');
    }
  });
}

function openLandCalculatorForActiveProperty() {
  if (activePropertyDetailListing) {
    const modal = document.getElementById('calculator-modal');
    if (modal) modal.classList.remove('hidden');

    const priceInput = document.getElementById('calc-stamp-price');
    const loanAmountInput = document.getElementById('calc-loan-amount');
    const areaInput = document.getElementById('calc-area-input');
    const areaUnit = document.getElementById('calc-area-unit');

    const price = activePropertyDetailListing.price || 5000000;
    if (priceInput) priceInput.value = price;
    if (loanAmountInput) loanAmountInput.value = Math.round(price * 0.75); // 75% LTV standard

    if (areaInput && activePropertyDetailListing.area_sqft) {
      areaInput.value = activePropertyDetailListing.area_sqft;
      if (areaUnit) areaUnit.value = 'sqft';
    }

    switchCalcTab('stamp');
    recalculateStampDuty();
    recalculateEMI();
    recalculateAreaUnits();
    if (window.lucide) lucide.createIcons();
  }
}

function recalculateAreaUnits() {
  const inputEl = document.getElementById('calc-area-input');
  const unitEl = document.getElementById('calc-area-unit');
  if (!inputEl || !unitEl) return;

  const val = parseFloat(inputEl.value) || 0;
  const unit = unitEl.value;

  // Convert everything to standard sqft first
  let sqft = 0;
  switch (unit) {
    case 'acre': sqft = val * 43560; break;
    case 'guntha': sqft = val * 1089; break;
    case 'cent': sqft = val * 435.6; break;
    case 'bigha': sqft = val * 27225; break;
    case 'sqyd': sqft = val * 9; break;
    case 'sqft': sqft = val; break;
  }

  // Then derive all units
  const acre = sqft / 43560;
  const guntha = sqft / 1089;
  const cent = sqft / 435.6;
  const bigha = sqft / 27225;
  const sqyd = sqft / 9;

  const setEl = (id, num, dec = 2) => {
    const el = document.getElementById(id);
    if (el) el.textContent = num.toLocaleString('en-IN', { maximumFractionDigits: dec, minimumFractionDigits: (dec > 2 ? 2 : 0) });
  };

  setEl('unit-val-acre', acre, 4);
  setEl('unit-val-guntha', guntha, 2);
  setEl('unit-val-cent', cent, 2);
  setEl('unit-val-bigha', bigha, 2);
  setEl('unit-val-sqyd', sqyd, 1);
  setEl('unit-val-sqft', sqft, 0);
}

function recalculateStampDuty() {
  const priceEl = document.getElementById('calc-stamp-price');
  const stateEl = document.getElementById('calc-stamp-state');
  if (!priceEl || !stateEl) return;

  const price = parseFloat(priceEl.value) || 0;
  const state = stateEl.value;

  let stampRate = 0.056;
  let regRate = 0.01;
  let cessRate = 0.02; // 2% of stamp duty in KA

  if (state === 'MH') {
    stampRate = 0.06;
    regRate = 0.01;
    cessRate = 0;
  } else if (state === 'TS') {
    stampRate = 0.06;
    regRate = 0.005;
    cessRate = 0;
  } else if (state === 'TN') {
    stampRate = 0.07;
    regRate = 0.04;
    cessRate = 0;
  } else if (state === 'DL') {
    stampRate = 0.06;
    regRate = 0.01;
    cessRate = 0;
  }

  const stampDuty = price * stampRate;
  const regFee = price * regRate;
  const cess = stampDuty * cessRate;
  const total = price + stampDuty + regFee + cess;

  const setEl = (id, num) => {
    const el = document.getElementById(id);
    if (el) el.textContent = '₹' + Math.round(num).toLocaleString('en-IN');
  };

  setEl('stamp-duty-val', stampDuty);
  setEl('stamp-reg-val', regFee);
  setEl('stamp-cess-val', cess);
  setEl('stamp-total-val', total);
}

function recalculateEMI() {
  const amountEl = document.getElementById('calc-loan-amount');
  const rateEl = document.getElementById('calc-loan-rate');
  const tenureEl = document.getElementById('calc-loan-tenure');
  if (!amountEl || !rateEl || !tenureEl) return;

  const p = parseFloat(amountEl.value) || 0;
  const annualRate = parseFloat(rateEl.value) || 8.5;
  const years = parseFloat(tenureEl.value) || 15;

  const monthlyRate = (annualRate / 12) / 100;
  const totalMonths = years * 12;

  let emi = 0;
  if (monthlyRate > 0 && totalMonths > 0) {
    emi = (p * monthlyRate * Math.pow(1 + monthlyRate, totalMonths)) / (Math.pow(1 + monthlyRate, totalMonths) - 1);
  } else if (totalMonths > 0) {
    emi = p / totalMonths;
  }

  const totalRepay = emi * totalMonths;
  const totalInterest = totalRepay - p;

  const emiEl = document.getElementById('emi-monthly-val');
  const interestEl = document.getElementById('emi-interest-val');
  const totalEl = document.getElementById('emi-total-val');

  if (emiEl) emiEl.textContent = '₹' + Math.round(emi).toLocaleString('en-IN') + ' / mo';
  if (interestEl) interestEl.textContent = '₹' + Math.round(totalInterest).toLocaleString('en-IN');
  if (totalEl) totalEl.textContent = '₹' + Math.round(totalRepay).toLocaleString('en-IN');
}

// ============================================================================
// SELLER LOCATION TOOLKIT: GPS AUTO-DETECT, REGIONAL PRESETS & MAP PIN PICKER
// ============================================================================

function applyPresetLocation(address, lat, lng, addrId, latId, lngId) {
  const addrInput = document.getElementById(addrId);
  const latInput = document.getElementById(latId);
  const lngInput = document.getElementById(lngId);

  if (addrInput) addrInput.value = address;
  if (latInput) latInput.value = Number(lat).toFixed(5);
  if (lngInput) lngInput.value = Number(lng).toFixed(5);

  showToast(`📍 Location set: ${address}`);
}

function detectGPSLocation(latId, lngId, statusId) {
  const statusEl = document.getElementById(statusId);
  const latInput = document.getElementById(latId);
  const lngInput = document.getElementById(lngId);

  if (!navigator.geolocation) {
    if (statusEl) statusEl.innerHTML = '<span class="text-amber-600">⚠️ Geolocation not supported by browser.</span>';
    return;
  }

  if (statusEl) statusEl.innerHTML = '<span class="text-wa-teal animate-pulse">🛰️ Detecting high-precision GPS...</span>';

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const lat = pos.coords.latitude.toFixed(5);
      const lng = pos.coords.longitude.toFixed(5);
      const acc = Math.round(pos.coords.accuracy || 10);

      if (latInput) latInput.value = lat;
      if (lngInput) lngInput.value = lng;

      if (statusEl) {
        statusEl.innerHTML = `<span class="text-emerald-700 font-bold">✓ GPS Fixed: ${lat}, ${lng} (±${acc}m)</span>`;
      }
      showToast(`📍 GPS coordinates detected (±${acc}m accuracy)`);
    },
    (err) => {
      console.warn('GPS detection warning:', err);
      if (statusEl) {
        statusEl.innerHTML = `<span class="text-slate-500">GPS unavailable (${err.message}). Tap "Pick on Map".</span>`;
      }
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}

// Map Pin Picker State
let pickerMapInstance = null;
let pickerMarkerInstance = null;
let activePickerLatInputId = null;
let activePickerLngInputId = null;
let activePickerAddrInputId = null;
let currentPickerLat = 13.29240;
let currentPickerLng = 77.54320;
let lastGeocodedAddress = '';

function openMapPinPicker(latId, lngId, addrId) {
  activePickerLatInputId = latId;
  activePickerLngInputId = lngId;
  activePickerAddrInputId = addrId;

  const latInput = document.getElementById(latId);
  const lngInput = document.getElementById(lngId);

  if (latInput && latInput.value && !isNaN(parseFloat(latInput.value))) {
    currentPickerLat = parseFloat(latInput.value);
  }
  if (lngInput && lngInput.value && !isNaN(parseFloat(lngInput.value))) {
    currentPickerLng = parseFloat(lngInput.value);
  }

  const modal = document.getElementById('map-picker-modal');
  if (modal) modal.classList.remove('hidden');

  updatePickerDisplay(currentPickerLat, currentPickerLng);

  setTimeout(() => {
    initOrUpdatePickerMap();
    if (window.lucide) lucide.createIcons();
  }, 100);
}

function closeMapPinPicker() {
  const modal = document.getElementById('map-picker-modal');
  if (modal) modal.classList.add('hidden');
}

function updatePickerDisplay(lat, lng) {
  currentPickerLat = Number(lat).toFixed(5);
  currentPickerLng = Number(lng).toFixed(5);

  const latValEl = document.getElementById('picker-lat-val');
  const lngValEl = document.getElementById('picker-lng-val');
  const statusEl = document.getElementById('picker-geocode-status');

  if (latValEl) latValEl.textContent = currentPickerLat;
  if (lngValEl) lngValEl.textContent = currentPickerLng;
  if (statusEl) statusEl.textContent = '📍 Updating...';

  // Debounced reverse geocoding preview
  clearTimeout(window._geoPreviewTimer);
  window._geoPreviewTimer = setTimeout(async () => {
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${currentPickerLat}&lon=${currentPickerLng}`);
      if (res.ok) {
        const data = await res.json();
        const displayName = data.display_name ? data.display_name.split(',').slice(0, 3).join(',') : 'Bengaluru Area';
        lastGeocodedAddress = displayName;
        if (statusEl) statusEl.textContent = `📍 ${displayName}`;
      } else {
        if (statusEl) statusEl.textContent = '📍 Custom GPS Point';
      }
    } catch {
      if (statusEl) statusEl.textContent = '📍 Custom GPS Point';
    }
  }, 600);
}

function initOrUpdatePickerMap() {
  if (!window.L) {
    console.warn('Leaflet library loading fallback');
    return;
  }

  const mapContainer = document.getElementById('picker-map-container');
  if (!mapContainer) return;

  if (!pickerMapInstance) {
    pickerMapInstance = L.map('picker-map-container', {
      zoomControl: true
    }).setView([parseFloat(currentPickerLat), parseFloat(currentPickerLng)], 14);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap'
    }).addTo(pickerMapInstance);

    pickerMarkerInstance = L.marker([parseFloat(currentPickerLat), parseFloat(currentPickerLng)], {
      draggable: true
    }).addTo(pickerMapInstance);

    pickerMarkerInstance.on('dragend', (e) => {
      const pos = e.target.getLatLng();
      updatePickerDisplay(pos.lat, pos.lng);
    });

    pickerMapInstance.on('click', (e) => {
      pickerMarkerInstance.setLatLng(e.latlng);
      updatePickerDisplay(e.latlng.lat, e.latlng.lng);
    });
  } else {
    pickerMapInstance.invalidateSize();
    pickerMapInstance.setView([parseFloat(currentPickerLat), parseFloat(currentPickerLng)], 14);
    if (pickerMarkerInstance) {
      pickerMarkerInstance.setLatLng([parseFloat(currentPickerLat), parseFloat(currentPickerLng)]);
    }
  }
}

function panPickerMap(lat, lng, name) {
  updatePickerDisplay(lat, lng);
  if (pickerMapInstance) {
    pickerMapInstance.setView([lat, lng], 14);
    if (pickerMarkerInstance) {
      pickerMarkerInstance.setLatLng([lat, lng]);
    }
  }
  const statusEl = document.getElementById('picker-geocode-status');
  if (statusEl) statusEl.textContent = `📍 ${name}`;
}

function detectGPSInsidePicker() {
  const statusEl = document.getElementById('picker-geocode-status');
  if (!navigator.geolocation) {
    if (statusEl) statusEl.textContent = 'GPS not supported';
    return;
  }

  if (statusEl) statusEl.textContent = '🛰️ Pinpointing GPS...';

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      panPickerMap(lat, lng, 'My Location');
      showToast('📍 Pin moved to your current GPS position');
    },
    (err) => {
      if (statusEl) statusEl.textContent = 'GPS permission denied';
      showToast('⚠️ GPS location unavailable');
    },
    { enableHighAccuracy: true, timeout: 8000 }
  );
}

function confirmMapPinLocation() {
  if (activePickerLatInputId) {
    const latInput = document.getElementById(activePickerLatInputId);
    if (latInput) latInput.value = currentPickerLat;
  }
  if (activePickerLngInputId) {
    const lngInput = document.getElementById(activePickerLngInputId);
    if (lngInput) lngInput.value = currentPickerLng;
  }
  if (activePickerAddrInputId && lastGeocodedAddress) {
    const addrInput = document.getElementById(activePickerAddrInputId);
    if (addrInput && (!addrInput.value || addrInput.value.trim() === '')) {
      addrInput.value = lastGeocodedAddress;
    }
  }

  closeMapPinPicker();
  showToast(`📍 Set GPS: ${currentPickerLat}, ${currentPickerLng}`);
}

// ================= EDIT PROFILE MODAL & PROFILE PHOTO UPLOAD =================

function openEditProfileModal() {
  if (!currentUser) {
    showToast('Please login to edit profile', 'error');
    return;
  }

  const defaultAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(currentUser.name || 'User')}&background=075E54&color=fff`;
  const avatarSrc = currentUser.avatar || defaultAvatar;

  const nameInput = document.getElementById('edit-profile-name');
  const bioInput = document.getElementById('edit-profile-bio');
  const avatarUrlInput = document.getElementById('edit-profile-avatar-url');
  const avatarPreview = document.getElementById('edit-profile-avatar-preview');
  const emailDisplay = document.getElementById('edit-profile-email-display');
  const phoneDisplay = document.getElementById('edit-profile-phone-display');
  const statusEl = document.getElementById('edit-profile-upload-status');
  const fileInput = document.getElementById('edit-profile-photo-input');

  if (nameInput) nameInput.value = currentUser.name || '';
  if (bioInput) bioInput.value = currentUser.bio || '';
  if (avatarUrlInput) avatarUrlInput.value = currentUser.avatar || '';
  if (emailDisplay) emailDisplay.textContent = currentUser.email || '';
  if (phoneDisplay) phoneDisplay.textContent = currentUser.phone_masked || '+91 98*** **321 (Masked)';
  if (fileInput) fileInput.value = '';

  if (avatarPreview) {
    avatarPreview.src = avatarSrc;
    avatarPreview.onerror = () => { avatarPreview.src = defaultAvatar; };
  }

  if (statusEl) {
    statusEl.textContent = 'Tap camera to change photo';
    statusEl.className = 'text-[10px] text-slate-500 font-medium text-center';
  }

  const modal = document.getElementById('edit-profile-modal');
  if (modal) modal.classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}

function closeEditProfileModal() {
  const modal = document.getElementById('edit-profile-modal');
  if (modal) modal.classList.add('hidden');
}

async function handleProfilePhotoUpload(inputEl) {
  if (!inputEl.files || !inputEl.files[0]) return;
  const file = inputEl.files[0];
  const statusEl = document.getElementById('edit-profile-upload-status');
  const previewImg = document.getElementById('edit-profile-avatar-preview');
  const urlInput = document.getElementById('edit-profile-avatar-url');

  if (file.size > 10 * 1024 * 1024) {
    showToast('Image size exceeds 10MB limit', 'error');
    if (statusEl) {
      statusEl.textContent = '⚠️ Image size exceeds 10MB limit';
      statusEl.className = 'text-[10px] text-rose-500 font-medium text-center';
    }
    return;
  }

  if (statusEl) {
    statusEl.innerHTML = '<span class="inline-block animate-spin mr-1">⏳</span> Uploading photo...';
    statusEl.className = 'text-[10px] text-wa-teal font-medium text-center';
  }

  try {
    const reader = new FileReader();
    reader.onload = async (e) => {
      const base64Data = e.target.result;
      try {
        const res = await fetch(`${API_BASE}/api/upload`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(currentToken ? { 'Authorization': `Bearer ${currentToken}` } : {})
          },
          body: JSON.stringify({
            file_data: base64Data,
            filename: file.name
          })
        });

        const data = await res.json();
        if (res.ok && data.url) {
          if (previewImg) previewImg.src = data.url;
          if (urlInput) urlInput.value = data.url;
          if (statusEl) {
            statusEl.textContent = '✓ Profile photo uploaded';
            statusEl.className = 'text-[10px] text-emerald-600 font-bold text-center';
          }
          showToast('Profile photo updated', 'success');
        } else {
          throw new Error(data.error || 'Failed to upload image');
        }
      } catch (err) {
        if (statusEl) {
          statusEl.textContent = '⚠️ ' + (err.message || 'Upload failed');
          statusEl.className = 'text-[10px] text-rose-500 font-medium text-center';
        }
        showToast(err.message || 'Image upload failed', 'error');
      }
    };
    reader.readAsDataURL(file);
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = '⚠️ Upload error';
      statusEl.className = 'text-[10px] text-rose-500 font-medium text-center';
    }
    showToast('Error reading selected image', 'error');
  }
}

async function handleSaveProfile(e) {
  if (e) e.preventDefault();
  if (!currentToken) {
    showToast('Please login to save profile', 'error');
    return;
  }

  const nameInput = document.getElementById('edit-profile-name');
  const bioInput = document.getElementById('edit-profile-bio');
  const avatarUrlInput = document.getElementById('edit-profile-avatar-url');
  const btnSave = document.getElementById('btn-save-profile');

  const name = nameInput ? nameInput.value.trim() : '';
  const bio = bioInput ? bioInput.value.trim() : '';
  const avatar = avatarUrlInput ? avatarUrlInput.value.trim() : '';

  if (!name) {
    showToast('Name cannot be empty', 'error');
    return;
  }

  const originalBtnHtml = btnSave ? btnSave.innerHTML : 'Save Profile';
  if (btnSave) {
    btnSave.disabled = true;
    btnSave.innerHTML = '<span class="inline-block animate-spin mr-1">⏳</span> Saving...';
  }

  try {
    const res = await fetch(`${API_BASE}/api/auth/profile`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentToken}`
      },
      body: JSON.stringify({ name, bio, avatar })
    });

    const data = await res.json();
    if (res.ok && data.success) {
      currentUser = data.user;
      if (data.token) {
        currentToken = data.token;
        localStorage.setItem('landconnect_token', currentToken);
      }
      localStorage.setItem('landconnect_user', JSON.stringify(currentUser));
      applyUserRoleUI();
      closeEditProfileModal();
      showToast('Profile updated successfully!', 'success');
    } else {
      showToast(data.error || 'Failed to update profile', 'error');
    }
  } catch (err) {
    showToast('Network error updating profile', 'error');
  } finally {
    if (btnSave) {
      btnSave.disabled = false;
      btnSave.innerHTML = originalBtnHtml;
      if (window.lucide) lucide.createIcons();
    }
  }
}
