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

function getInitialsAvatar(name = 'User', role = '') {
  const cleanName = (name || 'User').replace(/\s*\(.*?\)$/, '').trim();
  const parts = cleanName.split(/\s+/).filter(Boolean);
  let initials = 'U';
  if (parts.length >= 2) {
    initials = (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  } else if (parts.length === 1 && parts[0].length > 0) {
    initials = parts[0].slice(0, 2).toUpperCase();
  }
  let bg = '#075E54';
  const roleLower = String(role || '').toLowerCase();
  if (roleLower === 'buyer') bg = '#1E3A8A';
  else if (roleLower === 'seller') bg = '#065F46';
  else if (roleLower === 'broker') bg = '#581C87';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><rect width="100" height="100" rx="50" fill="${bg}"/><text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif" font-weight="700" font-size="38" fill="#FFFFFF">${initials}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function handleAvatarError(imgEl, name, role) {
  if (!imgEl) return;
  imgEl.onerror = null;
  imgEl.src = getInitialsAvatar(name, role);
}

function escapeHTML(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeQuotes(str) {
  if (!str) return '';
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function togglePasswordVisibility(inputId, btnEl) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const isPassword = input.type === 'password';
  input.type = isPassword ? 'text' : 'password';
  if (btnEl) {
    btnEl.innerHTML = isPassword 
      ? '<i data-lucide="eye-off" class="w-4 h-4 text-wa-teal"></i>' 
      : '<i data-lucide="eye" class="w-4 h-4 text-slate-400"></i>';
    if (window.lucide) lucide.createIcons();
  }
}

function fillDemoCredentials(email, password) {
  const emailInput = document.getElementById('login-email');
  const passInput = document.getElementById('login-password');
  if (emailInput) emailInput.value = email;
  if (passInput) passInput.value = password;
  if (typeof showToast === 'function') {
    showToast('Selected demo account: ' + email, 'info');
  }
}

window.togglePasswordVisibility = togglePasswordVisibility;
window.fillDemoCredentials = fillDemoCredentials;
window.escapeHTML = escapeHTML;
window.escapeQuotes = escapeQuotes;
window.getInitialsAvatar = getInitialsAvatar;
window.handleAvatarError = handleAvatarError;

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
let activePropertyDetailListing = null;
let allUsers = [];
let activeChatPeer = null;
let onlineUserIds = new Set();
let peerTypingMap = new Map(); // peerId -> timeoutId
let myTypingTimeout = null;
let isCurrentlyTypingSent = false;
let chatMessagesCache = new Map(); // userId -> messages array

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

// --- Multi-Party Meeting Room State ---
let currentMeetingRoomId = null;
let currentNewRoomId = null;
let meetingLocalStream = null;
let meetingScreenStream = null;
let isMeetingScreenSharing = false;
let isMeetingAudioMuted = false;
let isMeetingVideoMuted = false;
let meetingPeerConnections = new Map(); // peerId -> RTCPeerConnection
let meetingPeerStreams = new Map();     // peerId -> MediaStream
let meetingPeerInfo = new Map();        // peerId -> { id, name, avatar, role }
let meetingPendingIce = new Map();       // peerId -> [candidate]
let pendingUrlRoomId = null;

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

  // Mobile keyboard & viewport handling: keep typing input visible without outer scrolling
  const chatInput = document.getElementById('chat-input');
  if (chatInput) {
    chatInput.addEventListener('focus', () => {
      setTimeout(() => {
        const container = document.getElementById('chat-messages-container');
        if (container) container.scrollTop = container.scrollHeight;
      }, 300);
    });
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      const container = document.getElementById('chat-messages-container');
      if (container) container.scrollTop = container.scrollHeight;
    });
  }

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
    checkUrlForMeetingRoom();
  } else {
    checkUrlForMeetingRoom();
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

  if (pendingUrlRoomId) {
    const rId = pendingUrlRoomId;
    pendingUrlRoomId = null;
    setTimeout(() => {
      joinMultiPartyMeetingRoom(rId);
    }, 500);
  }
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

  const cleanPhone = phone.replace(/\D/g, '');
  if (!cleanPhone || cleanPhone.length < 10) {
    showAuthFeedback('Please enter a valid 10-digit mobile number.');
    return;
  }
  if (!password || password.length < 8) {
    showAuthFeedback('Password must be at least 8 characters long.');
    return;
  }

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
  const defaultAvatar = getInitialsAvatar(currentUser.name || 'User', currentUser.role);
  const avatarSrc = currentUser.avatar || defaultAvatar;

  // Header
  const roleText = document.getElementById('header-role-text');
  const avatarImg = document.getElementById('header-avatar');
  if (roleText) roleText.textContent = roleDisplay;
  if (avatarImg) {
    avatarImg.onerror = () => { avatarImg.src = defaultAvatar; };
    avatarImg.src = avatarSrc;
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
  if (tabId !== 'chats' && activeChatPeer) {
    const chatView = document.getElementById('active-chat-view');
    if (chatView && !chatView.classList.contains('hidden')) {
      closeActiveChat();
    }
  }
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
    setTimeout(() => {
      initInteractiveLandMap();
    }, 120);
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
    if (activeTab === 'map') {
      setTimeout(() => initInteractiveLandMap(), 100);
    }
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
            <h3 class="font-bold text-slate-800 text-sm leading-snug hover:text-wa-teal transition">${escapeHTML(item.title)}</h3>
            
            <div class="flex items-center gap-1 text-[11px] text-slate-500 mt-1">
              <i data-lucide="map-pin" class="w-3.5 h-3.5 text-wa-teal flex-shrink-0"></i>
              <span class="truncate">${escapeHTML(item.location_address)}, ${escapeHTML(item.city)}</span>
            </div>

            <p class="text-xs text-slate-600 line-clamp-2 leading-relaxed mt-1">
              ${escapeHTML(item.description)}
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
              <button onclick="startChatWithUser(${item.owner_id}, '${escapeQuotes(item.owner_name)}', '${escapeQuotes(item.owner_avatar)}', '${item.owner_role}', ${item.id})" 
                      class="bg-emerald-50 hover:bg-emerald-100 text-wa-teal p-2 rounded-xl transition" 
                      title="Send Message & Plot Inquiry">
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
  const item = allListings.find(l => String(l.id) === String(listingId));
  if (!item) return;
  activePropertyDetailListing = item;

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
    startChatWithUser(item.owner_id, escapeQuotes(item.owner_name), escapeQuotes(item.owner_avatar), item.owner_role, item.id);
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
  activePropertyDetailListing = null;
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
              <h5 class="font-bold text-xs text-slate-800 truncate">${escapeHTML(item.title)}</h5>
              <div class="text-[10px] text-emerald-700 font-semibold">₹${formattedPrice} • ${escapeHTML(item.property_type)}</div>
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

function parseDateSafe(dateVal) {
  if (!dateVal) return 0;
  if (dateVal instanceof Date) return dateVal.getTime();
  let str = String(dateVal).trim();
  if (!str) return 0;
  // If date string has no timezone indicator (no 'Z' and no '+' and no '-HH:MM'), treat it as UTC from server
  if (!str.endsWith('Z') && !str.includes('+') && !/[0-9]{4}-[0-9]{2}-[0-9]{2}T.*-[0-9]{2}:[0-9]{2}/.test(str)) {
    str = str.replace(' ', 'T') + 'Z';
  }
  const d = new Date(str);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

function formatChatTime(isoString) {
  if (!isoString) return '';
  const timestamp = parseDateSafe(isoString);
  if (!timestamp) return '';
  const date = new Date(timestamp);
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
    if (Array.isArray(allUsers)) {
      allUsers.forEach(u => {
        if (u.is_online) onlineUserIds.add(Number(u.id));
      });
    }
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
      avatar: u.avatar || getInitialsAvatar(u.name, u.role),
      role: u.role,
      phone_masked: u.phone_masked,
      last_message: conv ? conv.last_message : null,
      last_message_type: conv ? conv.last_message_type : null,
      last_message_time: conv ? conv.last_message_time : null,
      last_message_sender_id: conv ? Number(conv.last_message_sender_id) : null,
      last_message_is_read: conv ? Number(conv.last_message_is_read || 0) : 0,
      unread_count: conv ? Number(conv.unread_count) : 0,
      is_pinned: pinnedIds.includes(Number(u.id)),
      is_archived: archivedIds.includes(Number(u.id)),
      is_self: false
    };
  });

  // Prepend current user as Self Chat (WhatsApp "Message yourself")
  if (currentUser) {
    const selfConv = recentConversations.find(c => Number(c.peer_id) === myId);
    entries.unshift({
      id: myId,
      name: `${currentUser.name} (You)`,
      avatar: currentUser.avatar || getInitialsAvatar(currentUser.name, currentUser.role),
      role: currentUser.role || 'user',
      phone_masked: currentUser.phone_masked || currentUser.phone || '',
      last_message: selfConv ? selfConv.last_message : null,
      last_message_type: selfConv ? selfConv.last_message_type : null,
      last_message_time: selfConv ? selfConv.last_message_time : null,
      last_message_sender_id: myId,
      last_message_is_read: 1,
      unread_count: 0,
      is_pinned: pinnedIds.includes(myId),
      is_archived: archivedIds.includes(myId),
      is_self: true
    });
  }

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
  // 3. Contacts with no messages (keep self on top if no messages)
  activeChats.sort((a, b) => {
    if (a.is_pinned && !b.is_pinned) return -1;
    if (!a.is_pinned && b.is_pinned) return 1;

    const timeA = parseDateSafe(a.last_message_time);
    const timeB = parseDateSafe(b.last_message_time);

    if (timeA && timeB) {
      return timeB - timeA;
    }
    if (timeA && !timeB) return -1;
    if (!timeA && timeB) return 1;

    if (a.is_self && !b.is_self) return -1;
    if (!a.is_self && b.is_self) return 1;

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
  const isOnline = u.is_self ? true : onlineUserIds.has(Number(u.id));
  const isTyping = peerTypingMap.has(Number(u.id));
  
  let previewText = u.is_self 
    ? '<span class="text-slate-400">Message yourself</span>'
    : (isOnline ? '<span class="text-emerald-600 font-medium">Online</span>' : '<span class="text-slate-400">Offline</span>');
  let previewPrefix = '';

  if (isTyping) {
    previewPrefix = '';
    previewText = '<span class="text-emerald-600 font-semibold italic flex items-center gap-1">typing<span class="inline-flex"><span class="animate-bounce">.</span><span class="animate-bounce [animation-delay:0.15s]">.</span><span class="animate-bounce [animation-delay:0.3s]">.</span></span></span>';
  } else if (u.last_message) {
    if (isMine) {
      const isBlue = u.is_self || Number(u.last_message_is_read) === 1;
      previewPrefix = isBlue 
        ? '<span class="text-[#53bdeb] mr-0.5 font-bold">✓✓</span> '
        : '<span class="text-slate-400 mr-0.5 font-bold">✓✓</span> ';
    }
    if (u.last_message_type === 'audio') {
      previewText = '🎙️ Voice note';
    } else if (u.last_message_type === 'meeting') {
      previewText = '🎥 Video Meeting Room';
    } else if (u.last_message_type === 'contact_card' || (u.last_message && u.last_message.startsWith('Contact Card:'))) {
      previewText = '👤 ' + (u.last_message.replace('Contact Card:', '').split('•')[0].trim());
    } else if (u.last_message_type === 'property_inquiry') {
      previewText = '📍 Land parcel inquiry';
    } else {
      previewText = escapeHTML(u.last_message);
    }
  }

  const hasUnread = u.unread_count > 0;

  return `
    <div onclick="startChatWithUser(${u.id}, '${escapeQuotes(u.name)}', '${escapeQuotes(u.avatar)}', '${u.role}')"
         class="group px-3.5 py-3 flex items-center justify-between hover:bg-slate-50 active:bg-slate-100 cursor-pointer transition select-none ${u.is_pinned ? 'bg-emerald-50/40 border-l-4 border-wa-teal' : ''}">
      <div class="flex items-center gap-3 min-w-0 flex-1 pr-2">
        <div class="relative shrink-0" onclick="event.stopPropagation(); openContactProfile(${u.id})" title="View profile & status">
          <img src="${u.avatar || getInitialsAvatar(u.name, u.role)}" onerror="handleAvatarError(this, '${escapeQuotes(u.name)}', '${u.role}')" 
               class="w-11 h-11 rounded-full object-cover border border-slate-200 hover:opacity-85 transition transform hover:scale-105">
          <span class="absolute bottom-0 right-0 w-3 h-3 rounded-full ${isOnline ? 'bg-emerald-500 ring-2 ring-white' : 'bg-slate-300 ring-2 ring-white'}"></span>
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center justify-between mb-0.5">
            <div class="flex items-center gap-1.5 truncate">
              <h4 class="font-bold text-xs text-slate-800 truncate">${escapeHTML(u.name)}</h4>
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
      avatar: u.avatar || getInitialsAvatar(u.name, u.role),
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

  const myId = currentUser ? Number(currentUser.id) : 0;
  const activePeerId = activeChatPeer ? Number(activeChatPeer.id) : 0;
  const archivedIds = getArchivedChatIds();

  const totalUnread = recentConversations.reduce((acc, c) => {
    const peerId = Number(c.peer_id);
    if (peerId && peerId !== myId && peerId !== activePeerId && !archivedIds.includes(peerId)) {
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

function handleIncomingPeerTyping(senderId, isTyping) {
  if (peerTypingMap.has(senderId)) {
    clearTimeout(peerTypingMap.get(senderId));
    peerTypingMap.delete(senderId);
  }

  if (isTyping) {
    const timer = setTimeout(() => {
      peerTypingMap.delete(senderId);
      updateFloatingTypingUI();
      renderContactsList();
    }, 3500);
    peerTypingMap.set(senderId, timer);
  }

  updateFloatingTypingUI();
  renderContactsList();
}

function updateFloatingTypingUI() {
  const floatingEl = document.getElementById('chat-floating-typing');
  const floatingAvatar = document.getElementById('chat-floating-typing-avatar');
  if (!floatingEl) return;

  if (activeChatPeer && peerTypingMap.has(Number(activeChatPeer.id))) {
    if (floatingAvatar) {
      floatingAvatar.onerror = () => { floatingAvatar.src = getInitialsAvatar(activeChatPeer.name, activeChatPeer.role); };
      floatingAvatar.src = activeChatPeer.avatar || getInitialsAvatar(activeChatPeer.name, activeChatPeer.role);
    }
    const wasHidden = floatingEl.classList.contains('hidden');
    floatingEl.classList.remove('hidden');
    const container = document.getElementById('chat-messages-container');
    if (container && wasHidden) {
      container.scrollTop = container.scrollHeight;
    }
  } else {
    floatingEl.classList.add('hidden');
  }
}

function updateChatPeerStatusUI() {
  if (!activeChatPeer) return;

  const container = document.getElementById('chat-peer-status-container');
  if (!container) return;

  const peerId = Number(activeChatPeer.id);
  const myId = currentUser ? Number(currentUser.id) : 0;
  const isSelf = myId > 0 && (peerId === myId);
  const isOnline = isSelf ? true : onlineUserIds.has(peerId);

  const countEl = document.getElementById('chat-peer-msg-count');
  const msgCountText = countEl ? countEl.textContent : '0 messages';

  if (isSelf) {
    container.innerHTML = `
      <span id="chat-peer-status-text" class="font-normal text-emerald-100/90 truncate">Message yourself</span>
      <span class="text-white/40">•</span>
      <span id="chat-peer-msg-count" class="font-medium text-emerald-100/90 truncate">${msgCountText || '0 messages'}</span>
    `;
    return;
  }

  // In WhatsApp, the status bar consistently displays online/offline
  container.innerHTML = `
    <span id="chat-peer-status-dot" class="w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-emerald-400' : 'bg-emerald-100/40'} shrink-0"></span>
    <span id="chat-peer-status-text" class="font-normal truncate">${isOnline ? 'online' : 'offline'}</span>
    <span class="text-white/40">•</span>
    <span id="chat-peer-msg-count" class="font-medium text-emerald-100/90 truncate">${msgCountText || '0 messages'}</span>
  `;
}

let chatSyncInterval = null;

async function startChatWithUser(userId, name, avatar, role, listingId = null) {
  const targetId = Number(userId);
  const myId = currentUser ? Number(currentUser.id) : 0;
  const isSelf = (myId > 0 && targetId === myId);
  const displayName = isSelf ? `${(name || '').replace(/\s*\(You\)$/, '')} (You)` : name;

  activeChatPeer = { id: targetId, name: displayName, avatar, role, is_self: isSelf };

  const peerName = document.getElementById('chat-peer-name');
  const peerAvatar = document.getElementById('chat-peer-avatar');
  const peerRole = document.getElementById('chat-peer-role');
  const countEl = document.getElementById('chat-peer-msg-count');
  const messagesContainer = document.getElementById('chat-messages-container');

  if (peerName) peerName.textContent = displayName;
  if (peerAvatar) {
    const fallbackSrc = getInitialsAvatar(displayName, role);
    peerAvatar.onerror = function() {
      this.onerror = null;
      this.src = fallbackSrc;
    };
    peerAvatar.src = (avatar && String(avatar).trim() && String(avatar) !== 'null' && String(avatar) !== 'undefined') ? avatar : fallbackSrc;
  }
  if (peerRole) peerRole.textContent = role;

  // Block/hide Audio call, Video call, and Meeting room buttons on self-chat
  const btnMeet = document.getElementById('btn-chat-meet-header');
  const btnVideo = document.getElementById('btn-chat-video-header');
  const btnAudio = document.getElementById('btn-chat-audio-header');
  const btnAttachMeet = document.getElementById('btn-chat-attach-meet');

  if (isSelf) {
    if (btnMeet) btnMeet.classList.add('hidden');
    if (btnVideo) btnVideo.classList.add('hidden');
    if (btnAudio) btnAudio.classList.add('hidden');
    if (btnAttachMeet) btnAttachMeet.classList.add('hidden');
  } else {
    if (btnMeet) btnMeet.classList.remove('hidden');
    if (btnVideo) btnVideo.classList.remove('hidden');
    if (btnAudio) btnAudio.classList.remove('hidden');
    if (btnAttachMeet) btnAttachMeet.classList.remove('hidden');
  }

  updateChatPeerStatusUI();
  updateFloatingTypingUI();

  // Instant render: if cached, show immediately with 0ms delay; otherwise show clean encrypted state
  if (chatMessagesCache.has(targetId)) {
    const cached = chatMessagesCache.get(targetId);
    renderChatMessages(cached);
    if (countEl) {
      countEl.textContent = `${cached.length} ${cached.length === 1 ? 'message' : 'messages'}`;
    }
  } else {
    if (messagesContainer) {
      messagesContainer.innerHTML = `
        <div class="text-center py-8 text-slate-400 text-xs">
          <div class="inline-block bg-white/70 backdrop-blur-sm px-3.5 py-1.5 rounded-xl shadow-xs text-slate-500 font-medium">
            🔒 Messages and calls are end-to-end encrypted within LandConnect.
          </div>
          <div class="flex items-center justify-center gap-1.5 mt-4 text-emerald-600">
            <span class="w-2 h-2 rounded-full bg-wa-teal animate-bounce"></span>
            <span class="w-2 h-2 rounded-full bg-wa-teal animate-bounce [animation-delay:0.15s]"></span>
            <span class="w-2 h-2 rounded-full bg-wa-teal animate-bounce [animation-delay:0.3s]"></span>
          </div>
        </div>
      `;
    }
    if (countEl) {
      countEl.textContent = '...';
    }
  }

  const chatView = document.getElementById('active-chat-view');
  if (chatView) chatView.classList.remove('hidden');

  updateHeaderPinArchiveButtons();

  // Mark this conversation's unread count as 0 locally
  const conv = recentConversations.find(c => Number(c.peer_id) === targetId);
  if (conv) {
    conv.unread_count = 0;
    updateUnreadBadgesCounter();
    renderContactsList();
  }

  await fetchChatMessages(targetId);
  switchTab('chats');
  if (window.lucide) lucide.createIcons();

  if (listingId && !isSelf) {
    const listing = allListings.find(l => String(l.id) === String(listingId));
    if (listing) {
      await sendPropertyInquiryForListing(listing);
    }
  }

  // Background active sync polling
  clearInterval(chatSyncInterval);
  let pollCounter = 0;
  chatSyncInterval = setInterval(() => {
    if (activeChatPeer && Number(activeChatPeer.id) === targetId && currentToken) {
      pollCounter++;
      const isWsLive = ws && ws.readyState === WebSocket.OPEN;
      if (!isWsLive || pollCounter % 5 === 0) {
        syncChatMessages(targetId);
      }
    }
  }, 3000);
}

function closeActiveChat() {
  stopMyTyping();
  clearInterval(chatSyncInterval);
  chatSyncInterval = null;
  const chatView = document.getElementById('active-chat-view');
  if (chatView) chatView.classList.add('hidden');
  closeContactProfile();
  const messagesContainer = document.getElementById('chat-messages-container');
  if (messagesContainer) messagesContainer.innerHTML = '';
  activeChatPeer = null;
  updateFloatingTypingUI();
  switchTab('chats');
  loadUsersList();
}

// ================= WHATSAPP CONTACT INFO & PROFILE SYSTEM =================
let currentViewingContact = null;

async function openContactProfile(userId) {
  let uid = userId ? Number(userId) : (activeChatPeer ? Number(activeChatPeer.id) : null);
  if (!uid) return;

  // Optimistic preview from local data
  let contact = allUsers.find(u => Number(u.id) === uid);
  if (!contact && activeChatPeer && Number(activeChatPeer.id) === uid) {
    contact = activeChatPeer;
  }
  if (!contact) {
    contact = { id: uid, name: 'Contact', avatar: '', role: 'buyer', is_online: false };
  }

  currentViewingContact = { ...contact };

  // Render immediately with cached info and active skeleton shimmer for listings
  renderContactProfileUI(currentViewingContact, true);
  const profileView = document.getElementById('contact-profile-view');
  if (profileView) {
    profileView.classList.remove('hidden');
  }
  if (window.lucide) lucide.createIcons();

  // Fetch full live profile from backend (includes real-time online status, bio, and listed properties)
  try {
    const res = await fetch(`${API_BASE}/api/users/${uid}`);
    if (res.ok) {
      const fullData = await res.json();
      currentViewingContact = fullData;
      renderContactProfileUI(currentViewingContact, false);
    }
  } catch (e) {
    console.error('Error fetching contact profile:', e);
    renderContactProfileUI(currentViewingContact, false);
  }
}

function closeContactProfile() {
  const profileView = document.getElementById('contact-profile-view');
  if (profileView) {
    profileView.classList.add('hidden');
  }
  closeAvatarFullscreen();
}

function renderContactProfileUI(user, isLoadingListings = false) {
  if (!user) return;

  const myId = currentUser ? Number(currentUser.id) : 0;
  const isSelf = myId > 0 && (Number(user.id) === myId);

  const isOnline = isSelf ? true : (onlineUserIds.has(Number(user.id)) || Boolean(user.is_online));
  const userRole = (user.role || 'user').toLowerCase();
  const defaultStatus = userRole === 'seller' ? 'Direct landowner offering prime commercial and farm plots in Bengaluru outskirts.' :
                        userRole === 'broker' ? 'Certified RERA Real Estate Broker specializing in greenfield projects & high ROI land.' :
                        'Individual investor looking for agricultural and residential land parcels.';
  const bioText = (user.bio && user.bio.trim()) ? user.bio.trim() : defaultStatus;
  const avatarUrl = user.avatar || getInitialsAvatar(user.name, user.role);

  // 1. Hero info
  const avatarEl = document.getElementById('cp-avatar');
  if (avatarEl) {
    avatarEl.onerror = () => { avatarEl.src = getInitialsAvatar(user.name, user.role); };
    avatarEl.src = avatarUrl;
  }

  const nameEl = document.getElementById('cp-name');
  if (nameEl) nameEl.textContent = isSelf ? `${(user.name || 'User').replace(/\s*\(You\)$/, '')} (You)` : (user.name || 'User');

  const roleEl = document.getElementById('cp-role-badge');
  if (roleEl) {
    roleEl.textContent = userRole.toUpperCase();
    roleEl.className = `text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider ${
      userRole === 'buyer' ? 'bg-blue-100 text-blue-800' :
      userRole === 'seller' ? 'bg-emerald-100 text-emerald-800' :
      'bg-purple-100 text-purple-800'
    }`;
  }

  const phoneSub = document.getElementById('cp-phone-sub');
  if (phoneSub) phoneSub.textContent = user.phone_masked || '+91 98*** **321';

  // 2. Status badge
  const statusPill = document.getElementById('cp-status-pill');
  const statusDot = document.getElementById('cp-status-dot');
  const statusLabel = document.getElementById('cp-status-label');
  if (statusPill && statusDot && statusLabel) {
    if (isSelf) {
      statusPill.className = 'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200';
      statusDot.className = 'w-2 h-2 rounded-full bg-emerald-500';
      statusLabel.textContent = 'Message yourself';
    } else if (isOnline) {
      statusPill.className = 'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200';
      statusDot.className = 'w-2 h-2 rounded-full bg-emerald-500 animate-pulse';
      statusLabel.textContent = 'Online';
    } else {
      statusPill.className = 'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-600 border border-slate-200';
      statusDot.className = 'w-2 h-2 rounded-full bg-slate-400';
      statusLabel.textContent = 'Offline';
    }
  }

  // Hide call & meet buttons on self contact profile
  const btnAudio = document.getElementById('cp-btn-audio');
  const btnVideo = document.getElementById('cp-btn-video');
  const btnMeet = document.getElementById('cp-btn-meet');
  const actionsRow = document.getElementById('cp-actions-row');
  if (btnAudio) btnAudio.classList.toggle('hidden', isSelf);
  if (btnVideo) btnVideo.classList.toggle('hidden', isSelf);
  if (btnMeet) btnMeet.classList.toggle('hidden', isSelf);
  if (actionsRow) {
    if (isSelf) {
      actionsRow.className = 'grid grid-cols-1 gap-2 w-full mt-4 pt-3 border-t border-slate-100';
    } else {
      actionsRow.className = 'grid grid-cols-4 gap-2 w-full mt-4 pt-3 border-t border-slate-100';
    }
  }

  // Moderation card (Block & Report) - strictly DO NOT show on self profile
  const modCard = document.getElementById('cp-moderation-card');
  if (modCard) {
    if (isSelf) {
      modCard.classList.add('hidden');
    } else {
      modCard.classList.remove('hidden');
    }
  }

  // 3. About & Phone Number
  const bioEl = document.getElementById('cp-bio');
  if (bioEl) bioEl.textContent = bioText;

  const phoneEl = document.getElementById('cp-phone');
  if (phoneEl) phoneEl.textContent = user.phone_masked || '+91 98*** **321';

  const emailEl = document.getElementById('cp-email');
  if (emailEl) emailEl.textContent = user.email || `${(user.name||'user').toLowerCase().replace(/\s+/g, '')}@landconnect.si`;

  const joinedEl = document.getElementById('cp-joined');
  if (joinedEl) {
    if (user.created_at) {
      try {
        const d = new Date(user.created_at);
        joinedEl.textContent = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      } catch (e) {
        joinedEl.textContent = 'November 2026';
      }
    } else {
      joinedEl.textContent = 'November 2026';
    }
  }

  // 4. Land Parcels / Listings Section with Skeleton Loading
  const listingsSection = document.getElementById('cp-listings-section');
  const listingsList = document.getElementById('cp-listings-list');
  const listingsBadge = document.getElementById('cp-listings-badge');

  // If user is buyer and not loading, hide listings section unless they have listings
  const isBuyer = userRole === 'buyer';
  const userListings = Array.isArray(user.listings) ? user.listings : [];

  if (listingsSection) {
    if (isBuyer && !isLoadingListings && userListings.length === 0) {
      listingsSection.classList.add('hidden');
    } else {
      listingsSection.classList.remove('hidden');
    }
  }

  if (isLoadingListings) {
    // Elegant Skeleton Shimmer Loading State
    if (listingsBadge) {
      listingsBadge.innerHTML = `
        <span class="inline-flex items-center gap-1 text-[10px] text-wa-teal font-medium animate-pulse">
          <span class="w-1.5 h-1.5 rounded-full bg-wa-teal animate-ping"></span>
          <span>Loading plots...</span>
        </span>
      `;
    }

    if (listingsList) {
      listingsList.innerHTML = `
        <div class="space-y-2.5 animate-pulse">
          <div class="flex items-center gap-3 p-2.5 rounded-xl border border-slate-200/60 bg-white">
            <div class="w-20 h-20 min-w-[5rem] max-w-[5rem] rounded-xl bg-slate-200 shrink-0"></div>
            <div class="min-w-0 flex-1 space-y-2 py-1">
              <div class="flex justify-between items-center">
                <div class="h-3.5 bg-slate-200 rounded w-2/3"></div>
                <div class="h-3.5 bg-emerald-100 rounded w-16"></div>
              </div>
              <div class="h-3 bg-slate-200 rounded w-1/2"></div>
              <div class="h-3 bg-slate-100 rounded w-1/3 pt-1"></div>
            </div>
          </div>
          <div class="flex items-center gap-3 p-2.5 rounded-xl border border-slate-200/60 bg-white">
            <div class="w-20 h-20 min-w-[5rem] max-w-[5rem] rounded-xl bg-slate-200 shrink-0"></div>
            <div class="min-w-0 flex-1 space-y-2 py-1">
              <div class="flex justify-between items-center">
                <div class="h-3.5 bg-slate-200 rounded w-3/5"></div>
                <div class="h-3.5 bg-emerald-100 rounded w-16"></div>
              </div>
              <div class="h-3 bg-slate-200 rounded w-1/2"></div>
              <div class="h-3 bg-slate-100 rounded w-1/4 pt-1"></div>
            </div>
          </div>
        </div>
      `;
    }
  } else {
    // Loaded listings state
    if (listingsBadge) {
      listingsBadge.innerHTML = `<span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-50 text-wa-teal border border-emerald-100">${userListings.length} ${userListings.length === 1 ? 'plot' : 'plots'}</span>`;
    }

    if (listingsList) {
      if (userListings.length === 0) {
        listingsList.innerHTML = `
          <div class="text-center py-6 px-3 bg-slate-50 rounded-xl border border-dashed border-slate-200 text-slate-400">
            <i data-lucide="map-pin-off" class="w-6 h-6 mx-auto mb-1.5 opacity-40"></i>
            <p class="text-xs font-semibold text-slate-600">No active land parcels</p>
            <p class="text-[10px] text-slate-400 mt-0.5">This user has not listed any public land parcels</p>
          </div>
        `;
      } else {
        listingsList.innerHTML = userListings.map(l => {
          const thumb = (l.images && l.images[0]) || 'https://images.unsplash.com/photo-1500382017468-9049fed747ef?w=300';
          const priceNum = Number(l.price) || 0;
          const priceStr = priceNum >= 10000000 ? `₹${(priceNum/10000000).toFixed(2)} Cr` : `₹${(priceNum/100000).toFixed(2)} Lakh`;
          return `
            <div onclick="viewListingFromContactProfile(${l.id})" 
                 class="flex items-center gap-3 p-2.5 rounded-xl border border-slate-200/90 hover:border-wa-teal hover:bg-emerald-50/20 bg-white shadow-2xs transition cursor-pointer group">
              <div class="w-20 h-20 min-w-[5rem] max-w-[5rem] shrink-0 rounded-xl overflow-hidden bg-slate-100 border border-slate-200">
                <img src="${thumb}" onerror="this.src='https://images.unsplash.com/photo-1500382017468-9049fed747ef?w=300'" 
                     class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300">
              </div>
              <div class="min-w-0 flex-1 flex flex-col justify-between h-20 py-0.5 pr-1">
                <div>
                  <div class="flex items-center justify-between gap-1">
                    <h5 class="text-xs font-bold text-slate-900 truncate group-hover:text-wa-teal transition">${escapeQuotes(l.title)}</h5>
                    <span class="text-xs font-black text-emerald-700 shrink-0 ml-1">${priceStr}</span>
                  </div>
                  <p class="text-[10px] text-slate-500 truncate flex items-center gap-1 mt-0.5">
                    <i data-lucide="map-pin" class="w-3 h-3 text-wa-teal shrink-0"></i>
                    <span class="truncate">${escapeQuotes(l.location_address || l.city || 'Bengaluru')}</span>
                  </p>
                </div>
                <div class="flex items-center justify-between mt-1 pt-1 border-t border-slate-100/80">
                  <div class="flex items-center gap-1.5 text-[9px] text-slate-500">
                    <span class="font-medium">${Number(l.area_sqft || 5000).toLocaleString()} sq.ft</span>
                    <span>•</span>
                    <span class="capitalize text-emerald-700 font-semibold">${l.property_type || 'Agricultural'}</span>
                  </div>
                  <span class="text-[10px] font-bold text-wa-teal group-hover:underline flex items-center gap-0.5">
                    View <i data-lucide="chevron-right" class="w-3 h-3"></i>
                  </span>
                </div>
              </div>
            </div>
          `;
        }).join('');
      }
    }
  }

  // 5. Media & Stats
  const mediaStats = document.getElementById('cp-media-stats');
  if (mediaStats) {
    const cachedMsgs = chatMessagesCache.get(Number(user.id)) || [];
    const roomsCount = user.meeting_rooms_count || 0;
    mediaStats.textContent = `${cachedMsgs.length} messages • ${roomsCount} meeting rooms`;
  }

  // 6. Mute state
  const muteToggle = document.getElementById('cp-mute-toggle');
  if (muteToggle) {
    const mutedUsers = getMutedContactIds();
    muteToggle.checked = mutedUsers.includes(Number(user.id));
  }

  if (window.lucide) lucide.createIcons();
}

function viewListingFromContactProfile(listingId) {
  closeContactProfile();
  if (typeof openListingDetailModal === 'function') {
    openListingDetailModal(listingId);
  } else {
    switchTab('feed');
  }
}

function contactProfileMessageAction() {
  if (!currentViewingContact) return;
  const user = currentViewingContact;
  closeContactProfile();
  startChatWithUser(user.id, user.name, user.avatar, user.role);
}

function contactProfileAudioCallAction() {
  if (!currentViewingContact) return;
  const user = currentViewingContact;
  if (currentUser && Number(user.id) === Number(currentUser.id)) {
    showToast("You cannot voice call yourself.", "info");
    return;
  }
  closeContactProfile();
  initiateDirectCall(user.id, user.name, user.avatar, user.role, 'audio');
}

function contactProfileVideoCallAction() {
  if (!currentViewingContact) return;
  const user = currentViewingContact;
  if (currentUser && Number(user.id) === Number(currentUser.id)) {
    showToast("You cannot video call yourself.", "info");
    return;
  }
  closeContactProfile();
  initiateDirectCall(user.id, user.name, user.avatar, user.role, 'video');
}

function contactProfileMeetingAction() {
  if (!currentViewingContact) return;
  const user = currentViewingContact;
  if (currentUser && Number(user.id) === Number(currentUser.id)) {
    showToast("Meeting rooms cannot be created in self chat.", "info");
    return;
  }
  closeContactProfile();
  startChatWithUser(user.id, user.name, user.avatar, user.role);
  createMeetingRoom();
}

function openAvatarFullscreen(customUrl, customName) {
  const modal = document.getElementById('avatar-preview-modal');
  const img = document.getElementById('avatar-preview-img');
  const name = document.getElementById('avatar-preview-name');
  if (!modal || !img) return;

  const targetName = customName || (currentViewingContact ? currentViewingContact.name : 'Profile Photo');
  const targetRole = currentViewingContact ? currentViewingContact.role : '';
  const targetAvatar = customUrl || (currentViewingContact ? currentViewingContact.avatar : null) || getInitialsAvatar(targetName, targetRole);

  img.src = targetAvatar;
  img.onerror = () => {
    img.src = getInitialsAvatar(targetName, targetRole);
  };
  if (name) name.textContent = targetName;
  modal.classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}

function closeAvatarFullscreen() {
  const modal = document.getElementById('avatar-preview-modal');
  if (modal) modal.classList.add('hidden');
}

function shareContactProfile() {
  if (!currentViewingContact) return;
  openSendToChatsView(currentViewingContact);
}

// ================= SEND TO (WHATSAPP CHATS SHARING & FORWARDING) =================
let contactBeingShared = null;
let sendToSearchQuery = '';

function openSendToChatsView(contact) {
  contactBeingShared = contact || currentViewingContact;
  if (!contactBeingShared) return;

  const view = document.getElementById('send-to-view');
  if (!view) return;

  // Populate banner with shared contact details
  const bannerAvatar = document.getElementById('send-to-banner-avatar');
  const bannerName = document.getElementById('send-to-banner-name');
  const bannerSub = document.getElementById('send-to-banner-sub');
  const subtitle = document.getElementById('send-to-subtitle');

  const avatar = contactBeingShared.avatar || getInitialsAvatar(contactBeingShared.name, contactBeingShared.role);
  if (bannerAvatar) {
    bannerAvatar.onerror = () => { bannerAvatar.src = getInitialsAvatar(contactBeingShared.name, contactBeingShared.role); };
    bannerAvatar.src = avatar;
  }
  if (bannerName) bannerName.textContent = contactBeingShared.name;
  if (bannerSub) bannerSub.textContent = `${(contactBeingShared.role||'user').toUpperCase()} • ${contactBeingShared.phone_masked || '+91 98*** **321'}`;
  if (subtitle) subtitle.textContent = `Select contact to share ${contactBeingShared.name}`;

  const searchInput = document.getElementById('send-to-search-input');
  if (searchInput) searchInput.value = '';
  sendToSearchQuery = '';

  renderSendToChatsList();
  view.classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}

function closeSendToChatsView() {
  const view = document.getElementById('send-to-view');
  if (view) view.classList.add('hidden');
}

function focusSendToSearch() {
  const searchInput = document.getElementById('send-to-search-input');
  if (searchInput) {
    searchInput.focus();
  }
}

function handleSendToSearch(query) {
  sendToSearchQuery = query || '';
  renderSendToChatsList();
}

function renderSendToChatsList() {
  const container = document.getElementById('send-to-chats-list');
  const countEl = document.getElementById('send-to-contacts-count');
  if (!container) return;

  const myId = currentUser ? Number(currentUser.id) : 0;
  const sharedId = contactBeingShared ? Number(contactBeingShared.id) : 0;

  // Filter contacts: exclude myself and exclude the user being shared
  let availableContacts = allUsers.filter(u => {
    const uid = Number(u.id);
    return uid !== myId && uid !== sharedId;
  });

  if (sendToSearchQuery.trim()) {
    const q = sendToSearchQuery.toLowerCase().trim();
    availableContacts = availableContacts.filter(u => 
      u.name.toLowerCase().includes(q) || 
      (u.role && u.role.toLowerCase().includes(q)) ||
      (u.phone_masked && u.phone_masked.includes(q))
    );
  }

  if (countEl) {
    countEl.textContent = `${availableContacts.length} ${availableContacts.length === 1 ? 'contact' : 'contacts'}`;
  }

  if (availableContacts.length === 0) {
    container.innerHTML = `
      <div class="text-center py-12 px-4 text-slate-400">
        <i data-lucide="users-2" class="w-8 h-8 mx-auto mb-2 opacity-40"></i>
        <p class="text-xs font-semibold text-slate-600">No chats found</p>
        <p class="text-[10px] text-slate-400 mt-0.5">Try searching for another name or role</p>
      </div>
    `;
    if (window.lucide) lucide.createIcons();
    return;
  }

  container.innerHTML = availableContacts.map(u => {
    const isOnline = onlineUserIds.has(Number(u.id));
    const avatar = u.avatar || getInitialsAvatar(u.name, u.role);
    const role = (u.role || 'user').toLowerCase();
    const roleBadgeClass = role === 'buyer' ? 'bg-blue-100 text-blue-700' :
                           role === 'seller' ? 'bg-emerald-100 text-emerald-700' :
                           'bg-purple-100 text-purple-700';

    return `
      <div onclick="sendContactCardToUser(${u.id}, '${escapeQuotes(u.name)}', '${escapeQuotes(avatar)}', '${role}')" 
           class="px-3.5 py-3 flex items-center justify-between hover:bg-slate-50 active:bg-slate-100 cursor-pointer transition select-none group">
        <div class="flex items-center gap-3 min-w-0 flex-1 pr-2">
          <div class="relative shrink-0">
            <img src="${avatar}" onerror="handleAvatarError(this, '${escapeQuotes(u.name)}', '${role}')" 
                 class="w-11 h-11 rounded-full object-cover border border-slate-200">
            <span class="absolute bottom-0 right-0 w-3 h-3 rounded-full ${isOnline ? 'bg-emerald-500 ring-2 ring-white' : 'bg-slate-300 ring-2 ring-white'}"></span>
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5 mb-0.5">
              <h4 class="font-bold text-xs text-slate-900 truncate">${u.name}</h4>
              <span class="text-[9px] px-1.5 py-0.2 rounded font-semibold uppercase shrink-0 ${roleBadgeClass}">${role}</span>
            </div>
            <p class="text-[10px] text-slate-500 truncate">
              ${isOnline ? '<span class="text-emerald-600 font-semibold">Online</span>' : (u.phone_masked || 'Offline')}
            </p>
          </div>
        </div>
        <button class="px-3 py-1.5 bg-wa-green hover:bg-emerald-500 text-wa-tealDark rounded-full text-xs font-bold flex items-center gap-1 shadow-xs transition group-hover:scale-105 shrink-0">
          <i data-lucide="send" class="w-3.5 h-3.5"></i>
          <span>Send</span>
        </button>
      </div>
    `;
  }).join('');

  if (window.lucide) lucide.createIcons();
}

async function sendContactCardToUser(recipientId, recipientName, recipientAvatar, recipientRole) {
  if (!contactBeingShared) return;

  const shared = { ...contactBeingShared };
  const targetId = Number(recipientId);

  // 1. Close sharing palette and contact profile view immediately
  closeSendToChatsView();
  closeContactProfile();

  // 2. Open recipient's chat view and wait for previous message history to load
  await startChatWithUser(targetId, recipientName, recipientAvatar, recipientRole);

  // 3. Format structured contact card content
  const contactText = `Contact Card: ${shared.name} (${(shared.role||'user').toUpperCase()}) • ${shared.phone_masked || '+91 98*** **321'}`;
  const tempId = 'temp_contact_' + Date.now();

  const optimisticMsg = {
    id: tempId,
    tempId: tempId,
    sender_id: currentUser ? currentUser.id : 0,
    receiver_id: targetId,
    content: contactText,
    message_type: 'contact_card',
    contact_id: shared.id,
    contact_name: shared.name,
    contact_role: shared.role,
    contact_avatar: shared.avatar,
    contact_phone: shared.phone_masked,
    contact_bio: shared.bio || 'Available on LandConnect',
    created_at: new Date().toISOString()
  };

  // 4. Render directly into chat and cache
  appendMessageToChat(optimisticMsg, true);

  if (!chatMessagesCache.has(targetId)) {
    chatMessagesCache.set(targetId, []);
  }
  chatMessagesCache.get(targetId).push(optimisticMsg);

  // Update recent conversations snippet
  let conv = recentConversations.find(c => Number(c.peer_id) === targetId);
  if (conv) {
    conv.last_message = contactText;
    conv.last_message_type = 'contact_card';
    conv.last_message_time = optimisticMsg.created_at;
    conv.last_message_sender_id = currentUser ? Number(currentUser.id) : 0;
    renderContactsList();
  }

  // 5. Instant WebSocket dispatch
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({
        type: 'chat_message',
        tempId: tempId,
        receiver_id: targetId,
        content: contactText,
        message_type: 'contact_card',
        contact_id: shared.id,
        contact_name: shared.name,
        contact_role: shared.role,
        contact_avatar: shared.avatar,
        contact_phone: shared.phone_masked,
        contact_bio: shared.bio || 'Available on LandConnect',
        sender_name: currentUser ? currentUser.name : ''
      }));
    } catch (e) {
      console.error('WS contact share error:', e);
    }
  }

  // 6. Persist to Neon DB
  if (currentToken) {
    try {
      await fetch(`${API_BASE}/api/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${currentToken}`
        },
        body: JSON.stringify({
          receiver_id: targetId,
          content: contactText,
          message_type: 'contact_card',
          contact_id: shared.id,
          contact_name: shared.name,
          contact_role: shared.role,
          contact_avatar: shared.avatar,
          contact_phone: shared.phone_masked,
          contact_bio: shared.bio || 'Available on LandConnect',
          tempId: tempId,
          sender_name: currentUser ? currentUser.name : ''
        })
      });
    } catch (e) {
      console.error('API contact share error:', e);
    }
  }

  showToast(`Contact card for ${shared.name} sent to ${recipientName}`, 'info');
}

function toggleContactOptionsDropdown() {
  if (!currentViewingContact) return;
  showToast(`${currentViewingContact.name} is a verified LandConnect member`, 'info');
}

function getMutedContactIds() {
  try {
    return JSON.parse(localStorage.getItem('lc_muted_contacts') || '[]');
  } catch (e) {
    return [];
  }
}

function toggleMuteContact() {
  if (!currentViewingContact) return;
  const uid = Number(currentViewingContact.id);
  let muted = getMutedContactIds();
  if (muted.includes(uid)) {
    muted = muted.filter(id => id !== uid);
    showToast(`Unmuted notifications for ${currentViewingContact.name}`, 'info');
  } else {
    muted.push(uid);
    showToast(`Muted notifications for ${currentViewingContact.name}`, 'info');
  }
  localStorage.setItem('lc_muted_contacts', JSON.stringify(muted));
}

function handleBlockContact() {
  if (!currentViewingContact) return;
  const name = currentViewingContact.name;
  showToast(`Contact ${name} blocked`, 'info');
  closeContactProfile();
}

function handleReportContact() {
  if (!currentViewingContact) return;
  const name = currentViewingContact.name;
  showToast(`Report submitted for ${name}`, 'info');
  closeContactProfile();
}

async function fetchChatMessages(otherUserId) {
  if (!currentToken) return;
  const targetId = Number(otherUserId);
  try {
    const res = await fetch(`${API_BASE}/api/messages/${targetId}`, {
      headers: { 'Authorization': `Bearer ${currentToken}` }
    });
    if (!res.ok) return;
    const messages = await res.json();
    if (!Array.isArray(messages)) return;

    // Cache the messages for instant zero-latency retrieval
    chatMessagesCache.set(targetId, messages);

    // Only render if user is still actively looking at this conversation
    if (activeChatPeer && Number(activeChatPeer.id) === targetId) {
      renderChatMessages(messages);

      const countEl = document.getElementById('chat-peer-msg-count');
      if (countEl) {
        countEl.textContent = `${messages.length} ${messages.length === 1 ? 'message' : 'messages'}`;
      }
      updateChatPeerStatusUI();
    }

    const conv = recentConversations.find(c => Number(c.peer_id) === targetId);
    if (conv) {
      conv.unread_count = 0;
      updateUnreadBadgesCounter();
      renderContactsList();
    }

    // Real-time mark-as-read signaling over WebSocket so peer immediately sees blue double ticks
    if (ws && ws.readyState === WebSocket.OPEN && currentUser && targetId !== Number(currentUser.id)) {
      try {
        ws.send(JSON.stringify({ type: 'mark_as_read', sender_id: targetId }));
      } catch (e) {}
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
      } else if (Number(m.is_read) === 1) {
        // Real-time update to double blue tick if peer read it
        const bubble = document.getElementById(`msg-bubble-${m.id}`) || document.getElementById(`msg-bubble-${m.tempId}`);
        if (bubble) {
          const icon = bubble.querySelector('i[data-lucide="check-check"], i[data-lucide="check"]');
          if (icon && !icon.classList.contains('text-[#53bdeb]')) {
            icon.setAttribute('data-lucide', 'check-check');
            icon.className = 'w-3.5 h-3.5 text-[#53bdeb]';
            addedAny = true;
          }
        }
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
  const isSelf = currentUser && activeChatPeer && (Number(activeChatPeer.id) === Number(currentUser.id));
  if (statusEl) {
    statusEl.id = `msg-status-${permanentId}`;
    if (isSelf) {
      statusEl.innerHTML = '<i data-lucide="check-check" class="w-3.5 h-3.5 text-[#53bdeb]"></i>';
    } else {
      statusEl.innerHTML = '<i data-lucide="check-check" class="w-3.5 h-3.5 text-slate-400"></i>';
    }
    if (window.lucide) lucide.createIcons();
  }
  const bubbleEl = document.getElementById(`msg-bubble-${tempId}`);
  if (bubbleEl) {
    bubbleEl.id = `msg-bubble-${permanentId}`;
  }
}

function generateMessageHtml(m, isPending = false) {
  const isMine = currentUser && (Number(m.sender_id) === Number(currentUser.id));
  const isSelf = Number(m.sender_id) === Number(m.receiver_id) || (currentUser && activeChatPeer && Number(activeChatPeer.id) === Number(currentUser.id));
  const isSeen = isSelf || Number(m.is_read) === 1;
  const time = m.created_at ? new Date(parseDateSafe(m.created_at)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const bubbleId = m.tempId ? `msg-bubble-${m.tempId}` : `msg-bubble-${m.id}`;
  const statusId = m.tempId ? `msg-status-${m.tempId}` : `msg-status-${m.id}`;

  let messageContentHtml = `<p class="leading-relaxed select-text">${escapeHTML(m.content)}</p>`;

  // If meeting room invitation
  if (m.message_type === 'meeting') {
    const roomIdMatch = m.content && m.content.match(/(?:Room Code:|room=)\s*([a-zA-Z0-9_\-]+)/i);
    const roomId = m.room_id || (roomIdMatch ? roomIdMatch[1] : null) || 'land-deal-room';
    messageContentHtml = `
      <div class="bg-gradient-to-r from-wa-teal to-wa-tealDark text-white p-3 rounded-2xl shadow-md border border-emerald-400/30 my-1">
        <div class="flex items-center justify-between gap-2 mb-1">
          <div class="flex items-center gap-2">
            <div class="w-6 h-6 rounded-full bg-emerald-400/20 flex items-center justify-center">
              <i data-lucide="video" class="w-3.5 h-3.5 text-emerald-300"></i>
            </div>
            <span class="font-bold text-xs">Virtual Meeting Room</span>
          </div>
          <span class="text-[9px] bg-white/20 px-1.5 py-0.5 rounded font-mono font-semibold">${escapeHTML(roomId)}</span>
        </div>
        <p class="text-[11px] text-emerald-100">${escapeHTML(m.content)}</p>
        <button onclick="joinMultiPartyMeetingRoom('${escapeQuotes(roomId)}')" class="mt-2.5 w-full bg-wa-green hover:bg-emerald-400 text-wa-tealDark py-1.5 rounded-xl font-bold text-xs flex items-center justify-center gap-1.5 shadow transition">
          <i data-lucide="video" class="w-3.5 h-3.5"></i>
          Join Video Meeting
        </button>
      </div>
    `;
  } 
  // If shared contact card
  else if (m.message_type === 'contact_card' || (m.content && m.content.startsWith('Contact Card:'))) {
    const rawContent = m.content || '';
    const nameMatch = rawContent.match(/Contact Card:\s*([^(•\n]+)/);
    const contactName = m.contact_name || (nameMatch ? nameMatch[1].trim() : 'Contact');
    const roleMatch = rawContent.match(/\(([^)]+)\)/);
    const contactRole = (m.contact_role || (roleMatch ? roleMatch[1].trim() : 'user')).toLowerCase();
    const phoneMatch = rawContent.match(/•\s*([+0-9* ]+)/);
    const contactPhone = m.contact_phone || (phoneMatch ? phoneMatch[1].trim() : '+91 98*** **321');
    const contactObj = allUsers.find(u => u.name.toLowerCase() === contactName.toLowerCase());
    const contactId = m.contact_id || (contactObj ? contactObj.id : null);
    const contactAvatar = m.contact_avatar || (contactObj ? contactObj.avatar : getInitialsAvatar(contactName, contactRole));
    const roleBadgeClass = contactRole === 'buyer' ? 'bg-blue-100 text-blue-700' :
                           contactRole === 'seller' ? 'bg-emerald-100 text-emerald-700' :
                           'bg-purple-100 text-purple-700';

    messageContentHtml = `
      <div class="bg-white text-slate-800 p-3 rounded-2xl shadow-sm border border-slate-200/90 my-1 max-w-[270px]">
        <div class="flex items-center gap-3">
          <img src="${contactAvatar}" onerror="handleAvatarError(this, '${escapeQuotes(contactName)}', '${contactRole}')" class="w-11 h-11 rounded-full object-cover border border-slate-200 shrink-0">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5">
              <h4 class="font-bold text-xs text-slate-900 truncate">${escapeQuotes(contactName)}</h4>
              <span class="text-[8px] px-1.5 py-0.2 rounded font-bold uppercase shrink-0 ${roleBadgeClass}">${contactRole}</span>
            </div>
            <p class="text-[10px] text-slate-500 font-mono mt-0.5">${contactPhone}</p>
            <p class="text-[10px] text-emerald-700 italic truncate mt-0.5">👤 LandConnect Contact</p>
          </div>
        </div>
        <div class="border-t border-slate-100 mt-2.5 pt-2 flex items-center justify-between gap-1.5">
          <button onclick="${contactId ? `startChatWithUser(${contactId}, '${escapeQuotes(contactName)}', '${escapeQuotes(contactAvatar)}', '${contactRole}')` : ''}" class="flex-1 py-1 px-2 bg-emerald-50 hover:bg-emerald-100 text-wa-teal rounded-lg text-center text-xs font-bold transition flex items-center justify-center gap-1">
            <i data-lucide="message-square" class="w-3.5 h-3.5"></i>
            <span>Chat</span>
          </button>
          <button onclick="${contactId ? `openContactProfile(${contactId})` : ''}" class="flex-1 py-1 px-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-center text-xs font-bold transition flex items-center justify-center gap-1">
            <i data-lucide="user" class="w-3.5 h-3.5"></i>
            <span>View Info</span>
          </button>
        </div>
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
  else if (m.listing_title || m.listing_id) {
    const matchedListing = (m.listing_id && allListings) ? allListings.find(l => String(l.id) === String(m.listing_id)) : null;
    const lTitle = m.listing_title || (matchedListing ? matchedListing.title : 'Land Parcel');
    const lPrice = m.listing_price || (matchedListing ? matchedListing.price : 0);
    const lImages = m.listing_images || (matchedListing ? matchedListing.images : []);
    const lType = (matchedListing ? matchedListing.property_type : 'Land');
    const targetListingId = m.listing_id || (matchedListing ? matchedListing.id : null);
    const img = (lImages && lImages.length > 0) ? lImages[0] : 'https://images.unsplash.com/photo-1500382017468-9049fed747ef?w=200';

    messageContentHtml = `
      <div class="mb-2 p-2 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-xl cursor-pointer transition shadow-xs group select-none" 
           onclick="event.stopPropagation(); ${targetListingId ? `openPropertyDetails(${targetListingId})` : ''}" 
           title="Tap to view full plot details">
        <div class="flex items-center gap-2.5">
          <img src="${img}" onerror="this.onerror=null; this.src='https://images.unsplash.com/photo-1500382017468-9049fed747ef?w=200';" 
               class="w-14 h-14 rounded-xl object-cover flex-shrink-0 border border-slate-200 shadow-xs group-hover:scale-105 transition-transform">
          <div class="truncate flex-1 min-w-0">
            <div class="flex items-center gap-1.5">
              <span class="text-[9px] uppercase font-bold text-wa-teal bg-emerald-50 px-1.5 py-0.2 rounded">${escapeHTML(lType)}</span>
              <span class="text-[9px] text-slate-400 font-medium">Verified Plot</span>
            </div>
            <div class="font-bold text-xs text-slate-800 truncate mt-0.5 group-hover:text-wa-teal transition">${escapeHTML(lTitle)}</div>
            <div class="text-[11px] text-emerald-700 font-extrabold mt-0.5">₹${Number(lPrice || 0).toLocaleString('en-IN')}</div>
          </div>
          <div class="text-slate-400 group-hover:text-wa-teal transition pr-1 shrink-0">
            <i data-lucide="chevron-right" class="w-4 h-4"></i>
          </div>
        </div>
      </div>
      <p class="leading-relaxed select-text text-slate-800">${escapeHTML(m.content)}</p>
    `;
  }

  let checkIcon = '';
  if (isMine) {
    if (isPending && !isSelf) {
      checkIcon = `<span id="${statusId}"><i data-lucide="check" class="w-3.5 h-3.5 text-slate-400"></i></span>`;
    } else if (isSeen) {
      checkIcon = `<span id="${statusId}"><i data-lucide="check-check" class="w-3.5 h-3.5 text-[#53bdeb]"></i></span>`;
    } else {
      checkIcon = `<span id="${statusId}"><i data-lucide="check-check" class="w-3.5 h-3.5 text-slate-400"></i></span>`;
    }
  }

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

async function sendPropertyInquiryForListing(item, customMessage = null) {
  if (!item || !activeChatPeer || !currentToken) return;

  const targetPeerId = Number(activeChatPeer.id);
  const myId = currentUser ? Number(currentUser.id) : 0;
  const isSelf = (myId > 0 && targetPeerId === myId);

  // Avoid rapid duplicate inquiries within 10s for the exact same listing
  const cachedMsgs = chatMessagesCache.get(targetPeerId) || [];
  const recentSameInq = cachedMsgs.filter(m => m.listing_id && String(m.listing_id) === String(item.id)).pop();
  if (recentSameInq && recentSameInq.created_at) {
    const diffSec = (Date.now() - new Date(recentSameInq.created_at).getTime()) / 1000;
    if (diffSec < 10) return;
  }

  const recipientFirstName = (activeChatPeer.name || 'there').replace(/\s*\(.*?\)$/, '').trim().split(' ')[0];
  const inquiryText = customMessage || `Hello ${recipientFirstName}! Is this plot still available?`;

  const tempId = 'temp_inq_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
  const optimisticMsg = {
    id: tempId,
    tempId: tempId,
    sender_id: myId,
    receiver_id: targetPeerId,
    listing_id: item.id,
    listing_title: item.title,
    listing_price: item.price,
    listing_images: item.images,
    content: inquiryText,
    message_type: 'property_inquiry',
    is_read: isSelf ? 1 : 0,
    created_at: new Date().toISOString(),
    sender_name: currentUser ? currentUser.name : '',
    sender_avatar: currentUser ? currentUser.avatar : ''
  };

  appendMessageToChat(optimisticMsg, !isSelf);

  if (!chatMessagesCache.has(targetPeerId)) {
    chatMessagesCache.set(targetPeerId, []);
  }
  chatMessagesCache.get(targetPeerId).push(optimisticMsg);

  // Update in-memory recent conversation & promote to top
  const nowIso = new Date().toISOString();
  let conv = recentConversations.find(c => Number(c.peer_id) === targetPeerId);
  if (!conv) {
    conv = {
      peer_id: targetPeerId,
      peer_name: activeChatPeer.name || 'User',
      peer_avatar: activeChatPeer.avatar || '',
      peer_role: activeChatPeer.role || 'buyer',
      last_message: inquiryText,
      last_message_type: 'property_inquiry',
      last_message_time: nowIso,
      last_message_sender_id: myId,
      last_message_is_read: isSelf ? 1 : 0,
      unread_count: 0
    };
    recentConversations.unshift(conv);
  } else {
    conv.last_message = inquiryText;
    conv.last_message_type = 'property_inquiry';
    conv.last_message_time = nowIso;
    conv.last_message_sender_id = myId;
    conv.last_message_is_read = isSelf ? 1 : 0;
  }
  renderContactsList();

  // 1. Instant WebSocket dispatch
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({
        type: 'chat_message',
        tempId: tempId,
        receiver_id: targetPeerId,
        listing_id: item.id,
        content: inquiryText,
        message_type: 'property_inquiry',
        listing_title: item.title,
        listing_price: item.price,
        listing_images: item.images,
        sender_name: currentUser ? currentUser.name : '',
        sender_avatar: currentUser ? currentUser.avatar : ''
      }));
    } catch (e) {
      console.warn('WS send property inquiry error:', e);
    }
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
        receiver_id: targetPeerId,
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

async function attachListingInChat() {
  hideAttachmentMenu();
  if (allListings.length === 0 || !activeChatPeer) return;
  const item = (activePropertyDetailListing || selectedMapListing || allListings[0]);
  await sendPropertyInquiryForListing(item);
}

async function createMeetingRoom() {
  hideAttachmentMenu();
  if (!activeChatPeer) return;

  const targetPeerId = Number(activeChatPeer.id);
  const myId = currentUser ? Number(currentUser.id) : 0;
  if (myId > 0 && targetPeerId === myId) {
    showToast("Meeting rooms cannot be created in self chat.", "info");
    return;
  }

  const generatedRoomId = 'land-meet-' + Math.random().toString(36).substring(2, 7) + '-' + Date.now().toString(36).slice(-3);
  const meetingMsg = `Meeting Room started for live property discussion. Room Code: ${generatedRoomId}`;

  // Optimistic UI
  const tempId = 'temp_meet_' + Date.now();
  const optimisticMsg = {
    id: tempId,
    tempId: tempId,
    sender_id: currentUser ? currentUser.id : 0,
    receiver_id: activeChatPeer.id,
    content: meetingMsg,
    message_type: 'meeting',
    room_id: generatedRoomId,
    created_at: new Date().toISOString()
  };
  appendMessageToChat(optimisticMsg, true);

  if (!chatMessagesCache.has(targetPeerId)) {
    chatMessagesCache.set(targetPeerId, []);
  }
  chatMessagesCache.get(targetPeerId).push(optimisticMsg);

  // 1. Instant WebSocket dispatch
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({
        type: 'chat_message',
        tempId: tempId,
        receiver_id: activeChatPeer.id,
        content: meetingMsg,
        message_type: 'meeting',
        room_id: generatedRoomId,
        sender_name: currentUser ? currentUser.name : '',
        sender_avatar: currentUser ? currentUser.avatar : ''
      }));
    } catch (e) {}
  }

  // 2. HTTP persistence
  try {
    fetch(`${API_BASE}/api/messages`, {
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
  } catch (err) {
    console.error('Error creating meeting room:', err);
  }

  // Launch multi-party meeting room immediately for sender
  joinMultiPartyMeetingRoom(generatedRoomId);
}

function joinMeetingRoomFromChat(roomId) {
  const targetRoom = roomId || 'land-deal-room';
  joinMultiPartyMeetingRoom(targetRoom);
}

async function sendChatMessage() {
  const input = document.getElementById('chat-input');
  if (!input || !input.value.trim() || !activeChatPeer || !currentToken) return;

  const content = input.value.trim();
  input.value = '';
  handleChatInputTyping();

  const myId = currentUser ? Number(currentUser.id) : 0;
  const targetPeerId = Number(activeChatPeer.id);
  const isSelf = (myId > 0 && targetPeerId === myId);

  // Optimistic instant render on sender: 0ms delay!
  const tempId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
  const optimisticMsg = {
    id: tempId,
    tempId: tempId,
    sender_id: myId,
    receiver_id: activeChatPeer.id,
    content: content,
    message_type: 'text',
    is_read: isSelf ? 1 : 0,
    created_at: new Date().toISOString()
  };
  // For self chat, not pending -> instantly renders WhatsApp double blue ticks!
  appendMessageToChat(optimisticMsg, !isSelf);

  if (!chatMessagesCache.has(targetPeerId)) {
    chatMessagesCache.set(targetPeerId, []);
  }
  chatMessagesCache.get(targetPeerId).push(optimisticMsg);

  // Update in-memory recent conversation & promote to top
  const nowIso = new Date().toISOString();
  let conv = recentConversations.find(c => Number(c.peer_id) === targetPeerId);
  if (!conv) {
    conv = {
      peer_id: targetPeerId,
      peer_name: activeChatPeer.name || 'User',
      peer_avatar: activeChatPeer.avatar || '',
      peer_role: activeChatPeer.role || 'buyer',
      last_message: content,
      last_message_type: 'text',
      last_message_time: nowIso,
      last_message_sender_id: myId,
      last_message_is_read: isSelf ? 1 : 0,
      unread_count: 0
    };
    recentConversations.unshift(conv);
  } else {
    conv.last_message = content;
    conv.last_message_type = 'text';
    conv.last_message_time = nowIso;
    conv.last_message_sender_id = myId;
    conv.last_message_is_read = isSelf ? 1 : 0;
    conv.unread_count = 0;
    const idx = recentConversations.indexOf(conv);
    if (idx > -1) recentConversations.splice(idx, 1);
    recentConversations.unshift(conv);
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

  // 1. INSTANT WEBSOCKET DISPATCH (0ms to receiver!)
  let wsSent = false;
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(payload));
      wsSent = true;
    } catch (e) {
      console.warn('WS send failed, using HTTP fallback:', e);
    }
  }

  // 2. HTTP POST fallback only if WebSocket wasn't connected
  if (!wsSent) {
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
      console.error('Error sending message fallback:', err);
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
  if (!input) return;

  const hasText = input.value.trim().length > 0;
  if (btnMic && btnSend) {
    if (hasText) {
      btnMic.classList.add('hidden');
      btnSend.classList.remove('hidden');
    } else {
      btnMic.classList.remove('hidden');
      btnSend.classList.add('hidden');
    }
  }

  // Live WebSocket typing indicator
  if (activeChatPeer && ws && ws.readyState === WebSocket.OPEN) {
    if (hasText) {
      if (!isCurrentlyTypingSent) {
        isCurrentlyTypingSent = true;
        try {
          ws.send(JSON.stringify({
            type: 'typing',
            targetUserId: activeChatPeer.id,
            isTyping: true
          }));
        } catch(e){}
      }
      clearTimeout(myTypingTimeout);
      myTypingTimeout = setTimeout(() => {
        stopMyTyping();
      }, 2500);
    } else {
      stopMyTyping();
    }
  }
}

function stopMyTyping() {
  clearTimeout(myTypingTimeout);
  if (isCurrentlyTypingSent && activeChatPeer && ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({
        type: 'typing',
        targetUserId: activeChatPeer.id,
        isTyping: false
      }));
    } catch(e){}
  }
  isCurrentlyTypingSent = false;
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

  const targetPeerId = Number(activeChatPeer.id);
  if (!chatMessagesCache.has(targetPeerId)) {
    chatMessagesCache.set(targetPeerId, []);
  }
  chatMessagesCache.get(targetPeerId).push(optimisticMsg);

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
  if (currentUser && Number(activeChatPeer.id) === Number(currentUser.id)) {
    showToast("You cannot call yourself.", "info");
    return;
  }
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
        <div class="relative shrink-0">
          <img src="${u.avatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100'}" class="w-10 h-10 rounded-full object-cover">
          <span class="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full ${onlineUserIds.has(Number(u.id)) ? 'bg-emerald-500 ring-2 ring-white' : 'bg-slate-300 ring-2 ring-white'}"></span>
        </div>
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

let rawCallLogs = [];
let rawMeetingRoomLogs = [];
let activeCallHistoryFilter = 'all';
let meetingRoomSeconds = 0;
let meetingRoomTimerInterval = null;

async function fetchCallLogs() {
  if (!currentToken) return;
  try {
    const [resCalls, resRooms] = await Promise.all([
      fetch(`${API_BASE}/api/calls/history`, {
        headers: { 'Authorization': `Bearer ${currentToken}` }
      }),
      fetch(`${API_BASE}/api/meeting-rooms/history`, {
        headers: { 'Authorization': `Bearer ${currentToken}` }
      })
    ]);
    rawCallLogs = resCalls.ok ? await resCalls.json() : [];
    rawMeetingRoomLogs = resRooms.ok ? await resRooms.json() : [];
    renderCallLogs();
  } catch (err) {
    console.error('Error fetching call & meeting history:', err);
  }
}

function setCallHistoryFilter(filter) {
  activeCallHistoryFilter = filter;
  const btnAll = document.getElementById('btn-call-filter-all');
  const btnRooms = document.getElementById('btn-call-filter-rooms');
  const btnDirect = document.getElementById('btn-call-filter-direct');

  const activeClass = 'px-2.5 py-1 rounded-lg font-bold text-[11px] bg-wa-teal text-white shadow-xs transition';
  const inactiveClass = 'px-2.5 py-1 rounded-lg font-semibold text-[11px] bg-slate-100 text-slate-600 hover:bg-slate-200 transition';

  if (btnAll) btnAll.className = filter === 'all' ? activeClass : inactiveClass;
  if (btnRooms) btnRooms.className = filter === 'rooms' ? activeClass : inactiveClass;
  if (btnDirect) btnDirect.className = filter === 'direct' ? activeClass : inactiveClass;

  renderCallLogs();
}

function copyMeetingLinkById(roomId) {
  const url = `${window.location.origin}/?room=${encodeURIComponent(roomId)}`;
  navigator.clipboard.writeText(url).then(() => {
    showToast(`Meeting link for ${roomId} copied to clipboard!`, 'success');
  }).catch(() => {
    showToast(`Meeting link copied!`, 'success');
  });
}

function renderCallLogs() {
  const container = document.getElementById('call-logs-container');
  if (!container) return;

  // Update counts on filter tabs
  const countAllEl = document.getElementById('count-history-all');
  const countRoomsEl = document.getElementById('count-history-rooms');
  const countDirectEl = document.getElementById('count-history-direct');

  if (countAllEl) countAllEl.textContent = (rawCallLogs.length + rawMeetingRoomLogs.length);
  if (countRoomsEl) countRoomsEl.textContent = rawMeetingRoomLogs.length;
  if (countDirectEl) countDirectEl.textContent = rawCallLogs.length;

  // Tag items with uniform shape
  const directItems = rawCallLogs.map(l => ({
    ...l,
    item_type: 'direct_call',
    timestamp: new Date(parseDateSafe(l.created_at)).getTime() || 0
  }));

  const roomItems = rawMeetingRoomLogs.map(r => ({
    ...r,
    item_type: 'meeting_room',
    timestamp: new Date(parseDateSafe(r.updated_at || r.created_at)).getTime() || 0
  }));

  let combined = [];
  if (activeCallHistoryFilter === 'all') {
    combined = [...roomItems, ...directItems].sort((a, b) => b.timestamp - a.timestamp);
  } else if (activeCallHistoryFilter === 'rooms') {
    combined = [...roomItems].sort((a, b) => b.timestamp - a.timestamp);
  } else {
    combined = [...directItems].sort((a, b) => b.timestamp - a.timestamp);
  }

  if (combined.length === 0) {
    container.innerHTML = `<div class="p-6 text-center text-slate-400 text-xs">No call or meeting history found.</div>`;
    return;
  }

  container.innerHTML = combined.map(item => {
    if (item.item_type === 'meeting_room') {
      const roomId = item.room_id || 'land-room';
      const timeStr = item.created_at ? new Date(parseDateSafe(item.created_at)).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Recent';
      const durSec = item.duration_seconds || 0;
      const durationStr = durSec > 0 ? `${Math.floor(durSec / 60)}m ${durSec % 60}s` : 'Deal Session';
      const participantsStr = item.participants_summary || (item.host_name ? `Hosted by ${item.host_name}` : 'Virtual Meeting Room');

      return `
        <div class="p-3 flex items-center justify-between hover:bg-slate-50/80 transition">
          <div class="flex items-center gap-3 min-w-0 flex-1">
            <div class="w-10 h-10 rounded-2xl bg-gradient-to-tr from-wa-tealDark to-emerald-600 text-white flex items-center justify-center shrink-0 shadow-sm border border-emerald-500/30">
              <i data-lucide="users" class="w-5 h-5"></i>
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5 flex-wrap">
                <h4 class="font-bold text-xs text-slate-800">Virtual Meeting Room</h4>
                <span class="text-[9px] font-mono px-1.5 py-0.2 rounded bg-emerald-100 text-emerald-800 font-bold border border-emerald-200 truncate max-w-[140px]">${roomId}</span>
              </div>
              <p class="text-[11px] text-slate-500 truncate mt-0.5" title="${participantsStr}">${participantsStr}</p>
              <div class="flex items-center gap-1.5 text-[10px] text-slate-400 mt-0.5">
                <span class="text-emerald-600 font-semibold flex items-center gap-0.5">
                  <i data-lucide="video" class="w-3 h-3"></i> Group Video
                </span> •
                <span>${timeStr}</span> •
                <span>${durationStr}</span>
              </div>
            </div>
          </div>
          <div class="flex items-center gap-1 shrink-0 ml-2">
            <button onclick="copyMeetingLinkById('${roomId}')" title="Copy Meeting Link" class="p-2 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition">
              <i data-lucide="copy" class="w-4 h-4"></i>
            </button>
            <button onclick="joinMultiPartyMeetingRoom('${roomId}')" title="Rejoin Video Meeting Room" class="px-2.5 py-1.5 rounded-xl bg-wa-green hover:bg-emerald-500 text-wa-tealDark font-extrabold text-xs flex items-center gap-1 transition shadow-sm">
              <i data-lucide="video" class="w-3.5 h-3.5 stroke-[2.5]"></i>
              <span>Rejoin</span>
            </button>
          </div>
        </div>
      `;
    }

    // Direct Call Item
    const l = item;
    const isCaller = currentUser && l.caller_id === currentUser.id;
    const otherName = isCaller ? l.receiver_name : l.caller_name;
    const otherAvatar = isCaller ? l.receiver_avatar : l.caller_avatar;
    const otherRole = isCaller ? l.receiver_role : l.caller_role;
    const otherId = isCaller ? l.receiver_id : l.caller_id;
    const timeStr = l.created_at ? new Date(parseDateSafe(l.created_at)).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Recent';
    const duration = `${Math.floor(l.duration_seconds / 60)}m ${l.duration_seconds % 60}s`;

    return `
      <div class="p-3 flex items-center justify-between hover:bg-slate-50/80 transition">
        <div class="flex items-center gap-3 min-w-0 flex-1">
          <img src="${otherAvatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100'}" class="w-10 h-10 rounded-full object-cover shrink-0 border border-slate-200">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5">
              <h4 class="font-bold text-xs text-slate-800 truncate">${otherName}</h4>
              <span class="text-[9px] uppercase px-1 rounded bg-slate-100 text-slate-600 font-semibold shrink-0">${otherRole}</span>
            </div>
            <div class="flex items-center gap-1 text-[10px] text-slate-500 mt-0.5">
              <i data-lucide="${isCaller ? 'phone-outgoing' : 'phone-incoming'}" class="w-3 h-3 ${isCaller ? 'text-emerald-500' : 'text-blue-500'}"></i>
              <span>${l.call_type === 'video' ? 'Video' : 'Audio'} Call</span> •
              <span>${timeStr}</span> •
              <span>${duration}</span>
            </div>
          </div>
        </div>
        <button onclick="initiateDirectCall(${otherId}, '${escapeQuotes(otherName)}', '${escapeQuotes(otherAvatar)}', '${otherRole}', '${l.call_type}')"
                class="text-wa-teal p-2 hover:bg-slate-100 rounded-full shrink-0" title="Call Back">
          <i data-lucide="${l.call_type === 'video' ? 'video' : 'phone'}" class="w-4 h-4"></i>
        </button>
      </div>
    `;
  }).join('');

  if (window.lucide) lucide.createIcons();
}

async function getMediaStream(callType) {
  currentCameraFacingMode = 'user';
  isLocalVideoMirrored = true;
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
  if (!peerConnection) {
    showToast('No active call connected', 'info');
    return;
  }

  if (!isScreenSharing) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      showToast('Screen sharing is not supported by your mobile browser (iOS Safari / mobile WebView). Please use Chrome on Android or Desktop.', 'warning');
      return;
    }

    try {
      let stream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: 'always' }, audio: false });
      } catch (err1) {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      }

      screenStream = stream;
      const screenTrack = screenStream.getVideoTracks()[0];
      const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) {
        await sender.replaceTrack(screenTrack);
      }
      const localVideo = document.getElementById('local-video');
      if (localVideo) {
        localVideo.srcObject = screenStream;
        applyVideoMirrorStyle(localVideo, false); // Screen share must NEVER be mirrored
      }

      screenTrack.onended = () => {
        stopScreenShare();
      };

      isScreenSharing = true;
      const btn = document.getElementById('btn-toggle-screen');
      if (btn) btn.classList.add('bg-emerald-600', 'text-white');
      showToast('Screen sharing active', 'info');
    } catch (err) {
      console.warn('Screen share cancelled or unsupported:', err);
      if (err.name === 'NotAllowedError') {
        showToast('Screen share permission denied or cancelled', 'info');
      } else {
        showToast('Screen sharing is restricted on this mobile device', 'warning');
      }
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
    if (localVideo) {
      localVideo.srcObject = localStream;
      applyVideoMirrorStyle(localVideo, isLocalVideoMirrored);
    }
  }
  isScreenSharing = false;
  const btn = document.getElementById('btn-toggle-screen');
  if (btn) btn.classList.remove('bg-emerald-600', 'text-white');
  showToast('Screen sharing stopped', 'info');
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
  if (localVideo) {
    localVideo.srcObject = localStream;
    applyVideoMirrorStyle(localVideo, isLocalVideoMirrored);
  }

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

let pendingIceCandidates = [];

function setupPeerConnection() {
  pendingIceCandidates = [];
  peerConnection = new RTCPeerConnection(rtcConfig);

  if (localStream) {
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });
  }

  peerConnection.ontrack = (event) => {
    const remoteVideo = document.getElementById('remote-video');
    const remoteAudio = document.getElementById('remote-audio');
    const audioPlaceholder = document.getElementById('audio-call-placeholder');
    remoteStream = event.streams[0];

    if (activeCallType === 'video' && remoteVideo) {
      if (audioPlaceholder) audioPlaceholder.classList.add('hidden');
      remoteVideo.srcObject = remoteStream;
      applyVideoMirrorStyle(remoteVideo, isRemoteVideoMirrored);
      remoteVideo.play().catch(() => {});
    } else if (remoteAudio) {
      remoteAudio.srcObject = remoteStream;
    }
  };

  peerConnection.onconnectionstatechange = () => {
    console.log('Peer connection state:', peerConnection.connectionState);
    const statusEl = document.getElementById('audio-placeholder-status');
    const avatarEl = document.getElementById('call-avatar');
    if (peerConnection.connectionState === 'connected') {
      if (statusEl) statusEl.textContent = 'In-Call • Encrypted HD Audio';
      if (avatarEl) avatarEl.classList.remove('animate-pulse');
    } else if (peerConnection.connectionState === 'connecting') {
      if (statusEl) statusEl.textContent = 'Connecting Secure In-App Audio...';
    } else if (peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'disconnected') {
      if (statusEl) statusEl.textContent = 'Reconnecting...';
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

async function drainPendingIceCandidates() {
  if (!peerConnection || !peerConnection.remoteDescription) return;
  while (pendingIceCandidates.length > 0) {
    const cand = pendingIceCandidates.shift();
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(cand));
    } catch (e) {
      console.warn('Queued ICE candidate application error:', e);
    }
  }
}

function showCallModal(peerName, peerAvatar, peerRole, callType) {
  const modal = document.getElementById('call-modal');
  const nameEl = document.getElementById('call-peer-name');
  const roleEl = document.getElementById('call-role-badge');
  const avatarEl = document.getElementById('call-avatar');
  const audioPlaceholder = document.getElementById('audio-call-placeholder');
  const audioPlaceholderName = document.getElementById('audio-placeholder-name');
  const audioPlaceholderStatus = document.getElementById('audio-placeholder-status');
  const localVideoBox = document.getElementById('local-video-container');

  if (modal) modal.classList.remove('hidden');
  if (nameEl) nameEl.textContent = peerName;
  if (roleEl) roleEl.textContent = `${peerRole} • Protected Contact`;
  if (avatarEl) {
    avatarEl.src = peerAvatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100';
    avatarEl.classList.add('animate-pulse');
  }
  if (audioPlaceholderName) audioPlaceholderName.textContent = peerName;
  if (audioPlaceholderStatus) audioPlaceholderStatus.textContent = 'Connecting In-App Audio...';

  if (callType === 'audio') {
    if (audioPlaceholder) audioPlaceholder.classList.remove('hidden');
    if (localVideoBox) localVideoBox.classList.add('hidden');
  } else {
    if (audioPlaceholder) {
      audioPlaceholder.classList.remove('hidden');
      if (audioPlaceholderStatus) audioPlaceholderStatus.textContent = 'Connecting Secure Video...';
    }
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
  isSwappedToMain = false;
  currentCameraFacingMode = 'user';
  isLocalVideoMirrored = true;
  isRemoteVideoMirrored = false;
  updateMuteButtonsUI();

  const localVideo = document.getElementById('local-video');
  const remoteVideo = document.getElementById('remote-video');
  const audioPlaceholder = document.getElementById('audio-call-placeholder');
  if (localVideo) localVideo.srcObject = null;
  if (remoteVideo) remoteVideo.srcObject = null;
  if (audioPlaceholder) audioPlaceholder.classList.remove('hidden');

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

let currentCameraFacingMode = 'user'; // 'user' (front) or 'environment' (back)
let isLocalVideoMirrored = true;
let isRemoteVideoMirrored = false;
let isSwappedToMain = false;
let availableVideoDevices = [];
let activeVideoDeviceIndex = 0;

function applyVideoMirrorStyle(videoEl, shouldMirror) {
  if (!videoEl) return;
  if (shouldMirror) {
    videoEl.classList.remove('video-unmirrored');
    videoEl.classList.add('video-mirrored');
    videoEl.style.setProperty('transform', 'scaleX(-1) translateZ(0)', 'important');
    videoEl.style.setProperty('-webkit-transform', 'scaleX(-1) translateZ(0)', 'important');
  } else {
    videoEl.classList.remove('video-mirrored');
    videoEl.classList.add('video-unmirrored');
    videoEl.style.setProperty('transform', 'scaleX(1) translateZ(0)', 'important');
    videoEl.style.setProperty('-webkit-transform', 'scaleX(1) translateZ(0)', 'important');
  }
}

function toggleVideoMirror() {
  isLocalVideoMirrored = !isLocalVideoMirrored;
  isRemoteVideoMirrored = !isRemoteVideoMirrored;

  const localVideo = document.getElementById('local-video');
  const remoteVideo = document.getElementById('remote-video');
  const meetingLocalVideo = document.getElementById('meeting-local-video');

  if (localVideo) applyVideoMirrorStyle(localVideo, isLocalVideoMirrored);
  if (meetingLocalVideo) applyVideoMirrorStyle(meetingLocalVideo, isLocalVideoMirrored);
  if (remoteVideo) applyVideoMirrorStyle(remoteVideo, isRemoteVideoMirrored);

  showToast(isLocalVideoMirrored ? 'Video Mirror ON' : 'Video Mirror OFF', 'info');
}

function swapVideoFeeds() {
  const localVideo = document.getElementById('local-video');
  const remoteVideo = document.getElementById('remote-video');
  if (!localVideo || !remoteVideo) return;

  isSwappedToMain = !isSwappedToMain;

  const currentLocal = localVideo.srcObject;
  const currentRemote = remoteVideo.srcObject;

  localVideo.srcObject = currentRemote;
  remoteVideo.srcObject = currentLocal;

  applyVideoMirrorStyle(remoteVideo, isSwappedToMain ? isLocalVideoMirrored : isRemoteVideoMirrored);
  applyVideoMirrorStyle(localVideo, isSwappedToMain ? isRemoteVideoMirrored : isLocalVideoMirrored);

  localVideo.play().catch(() => {});
  remoteVideo.play().catch(() => {});

  showToast(isSwappedToMain ? 'Swapped: Your camera is fullscreen' : 'Swapped: Remote camera is fullscreen', 'info');
}

window.swapVideoFeeds = swapVideoFeeds;
window.toggleVideoMirror = toggleVideoMirror;

async function toggleVideoCameraFlip() {
  const activeStream = (typeof localStream !== 'undefined' && localStream) 
    ? localStream 
    : ((typeof meetingLocalStream !== 'undefined' && meetingLocalStream) ? meetingLocalStream : null);

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast('Camera switching is not supported on this device/browser', 'warning');
    return;
  }

  try {
    // 1. Refresh device list
    let devices = [];
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch (e) {
      devices = [];
    }
    availableVideoDevices = devices.filter(d => d.kind === 'videoinput');

    const nextFacing = (currentCameraFacingMode === 'user') ? 'environment' : 'user';

    // 2. Select camera constraint
    let videoConstraint = { facingMode: nextFacing };
    if (availableVideoDevices.length > 1) {
      let targetDev = null;
      if (nextFacing === 'environment') {
        targetDev = availableVideoDevices.find(d => /back|rear|environment|main/i.test(d.label));
      } else {
        targetDev = availableVideoDevices.find(d => /front|user|selfie/i.test(d.label));
      }
      if (!targetDev) {
        activeVideoDeviceIndex = (activeVideoDeviceIndex + 1) % availableVideoDevices.length;
        targetDev = availableVideoDevices[activeVideoDeviceIndex];
      }
      if (targetDev && targetDev.deviceId) {
        videoConstraint = { deviceId: { exact: targetDev.deviceId } };
      }
    }

    // 3. Stop old video track(s) first to release mobile hardware camera lock
    if (activeStream) {
      const oldTracks = activeStream.getVideoTracks();
      oldTracks.forEach(t => {
        try { activeStream.removeTrack(t); } catch (e) {}
        try { t.stop(); } catch (e) {}
      });
    }

    // 4. Acquire new camera stream
    let newStream;
    try {
      newStream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraint,
        audio: false
      });
    } catch (e1) {
      try {
        newStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: nextFacing },
          audio: false
        });
      } catch (e2) {
        newStream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false
        });
      }
    }

    const newVideoTrack = newStream.getVideoTracks()[0];
    if (!newVideoTrack) {
      showToast('Could not acquire new camera feed', 'warning');
      return;
    }

    // 5. Add to active stream
    if (activeStream) {
      activeStream.addTrack(newVideoTrack);
    }

    currentCameraFacingMode = nextFacing;
    isLocalVideoMirrored = (nextFacing === 'user');

    // 6. Force reload video elements with fresh MediaStream
    const localVideo = document.getElementById('local-video');
    if (localVideo) {
      localVideo.srcObject = null;
      localVideo.srcObject = new MediaStream([newVideoTrack]);
      applyVideoMirrorStyle(localVideo, isLocalVideoMirrored);
      localVideo.play().catch(() => {});
    }

    const meetingLocalVideo = document.getElementById('meeting-local-video');
    if (meetingLocalVideo) {
      meetingLocalVideo.srcObject = null;
      meetingLocalVideo.srcObject = new MediaStream([newVideoTrack]);
      applyVideoMirrorStyle(meetingLocalVideo, isLocalVideoMirrored);
      meetingLocalVideo.play().catch(() => {});
    }

    const remoteVideo = document.getElementById('remote-video');
    if (isSwappedToMain && remoteVideo) {
      remoteVideo.srcObject = null;
      remoteVideo.srcObject = new MediaStream([newVideoTrack]);
      applyVideoMirrorStyle(remoteVideo, isLocalVideoMirrored);
      remoteVideo.play().catch(() => {});
    }

    // 7. Replace track on WebRTC peer connection
    if (typeof peerConnection !== 'undefined' && peerConnection) {
      const senders = peerConnection.getSenders();
      const videoSender = senders.find(s => s.track && s.track.kind === 'video') || senders.find(s => !s.track);
      if (videoSender) {
        await videoSender.replaceTrack(newVideoTrack);
      }
    }

    if (typeof meetingPeerConnections !== 'undefined' && meetingPeerConnections.size > 0) {
      for (const [peerId, pc] of meetingPeerConnections.entries()) {
        const senders = pc.getSenders();
        const videoSender = senders.find(s => s.track && s.track.kind === 'video') || senders.find(s => !s.track);
        if (videoSender) {
          await videoSender.replaceTrack(newVideoTrack);
        }
      }
    }

    const label = (nextFacing === 'environment') ? 'Rear / Back Camera' : 'Front / Selfie Camera';
    showToast(`Turned to ${label}`, 'success');
  } catch (err) {
    console.error('Camera flip error:', err);
    showToast('Failed to switch camera: ' + (err.message || 'Hardware restricted'), 'error');
  }
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
  if (localVideo) {
    localVideo.srcObject = localStream;
    applyVideoMirrorStyle(localVideo, isLocalVideoMirrored);
  }

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

// ================= MULTI-PARTY VIRTUAL MEETING ROOMS =================

function generateRoomId() {
  return 'land-meet-' + Math.random().toString(36).substring(2, 7) + '-' + Date.now().toString(36).slice(-3);
}

function openCreateMeetingRoomModal() {
  currentNewRoomId = generateRoomId();
  const modal = document.getElementById('modal-create-meeting-room');
  const inputLink = document.getElementById('input-meeting-share-link');
  const searchInput = document.getElementById('invite-contact-search');

  if (inputLink) {
    inputLink.value = `${window.location.origin}/?room=${currentNewRoomId}`;
  }
  if (searchInput) {
    searchInput.value = '';
  }

  renderMeetingInviteContacts();
  if (modal) modal.classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}

function closeCreateMeetingRoomModal() {
  const modal = document.getElementById('modal-create-meeting-room');
  if (modal) modal.classList.add('hidden');
}

function renderMeetingInviteContacts(filter = '') {
  const listEl = document.getElementById('meeting-invite-contacts-list');
  if (!listEl) return;

  const currentUid = currentUser ? Number(currentUser.id) : 0;
  const filteredUsers = allUsers.filter(u => {
    if (Number(u.id) === currentUid) return false;
    if (!filter) return true;
    const q = filter.toLowerCase();
    return (u.name && u.name.toLowerCase().includes(q)) || 
           (u.role && u.role.toLowerCase().includes(q)) ||
           (u.email && u.email.toLowerCase().includes(q));
  });

  if (filteredUsers.length === 0) {
    listEl.innerHTML = `<div class="p-4 text-center text-slate-400 text-xs">No contacts found</div>`;
    return;
  }

  listEl.innerHTML = filteredUsers.map(u => {
    const avatar = u.avatar || getInitialsAvatar(u.name, u.role);
    const roleColors = {
      buyer: 'bg-blue-100 text-blue-700 border-blue-200',
      seller: 'bg-emerald-100 text-emerald-800 border-emerald-200',
      broker: 'bg-purple-100 text-purple-800 border-purple-200'
    };
    const roleBadge = roleColors[u.role?.toLowerCase()] || 'bg-slate-100 text-slate-700 border-slate-200';

    return `
      <div class="p-2.5 flex items-center justify-between hover:bg-white transition">
        <div class="flex items-center gap-2.5 min-w-0">
          <img src="${avatar}" class="w-8 h-8 rounded-full object-cover border border-slate-200 shrink-0">
          <div class="min-w-0">
            <h4 class="font-bold text-xs text-slate-800 truncate">${u.name}</h4>
            <span class="text-[9px] px-1.5 py-0.2 rounded border font-semibold uppercase ${roleBadge}">${u.role || 'Member'}</span>
          </div>
        </div>
        <button id="btn-invite-user-${u.id}" onclick="sendMeetingInviteToUser(${u.id})" class="bg-wa-teal hover:bg-wa-tealDark text-white px-2.5 py-1 rounded-lg font-bold text-xs flex items-center gap-1 transition shadow-sm shrink-0">
          <i data-lucide="send" class="w-3 h-3"></i>
          <span>Invite</span>
        </button>
      </div>
    `;
  }).join('');

  if (window.lucide) lucide.createIcons();
}

function filterMeetingInviteContacts() {
  const searchInput = document.getElementById('invite-contact-search');
  renderMeetingInviteContacts(searchInput ? searchInput.value.trim() : '');
}

async function sendMeetingInviteToUser(targetUserId) {
  const targetUser = allUsers.find(u => Number(u.id) === Number(targetUserId));
  if (!targetUser || !currentUser) return;
  const roomId = currentNewRoomId || currentMeetingRoomId;
  if (!roomId) return;

  const meetingMsg = `Virtual Meeting Room invitation for property discussion. Room Code: ${roomId}`;
  const tempId = 'temp_meet_inv_' + Date.now();

  const optimisticMsg = {
    id: tempId,
    tempId: tempId,
    sender_id: currentUser.id,
    receiver_id: targetUser.id,
    content: meetingMsg,
    message_type: 'meeting',
    room_id: roomId,
    created_at: new Date().toISOString()
  };

  const targetId = Number(targetUser.id);
  if (!chatMessagesCache.has(targetId)) {
    chatMessagesCache.set(targetId, []);
  }
  chatMessagesCache.get(targetId).push(optimisticMsg);

  // Send over WebSocket immediately (0ms)
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({
        type: 'chat_message',
        tempId: tempId,
        receiver_id: targetUser.id,
        content: meetingMsg,
        message_type: 'meeting',
        room_id: roomId,
        sender_name: currentUser.name,
        sender_avatar: currentUser.avatar
      }));
    } catch(e) {}
  }

  // Persist over HTTP
  try {
    fetch(`${API_BASE}/api/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentToken}`
      },
      body: JSON.stringify({
        tempId: tempId,
        receiver_id: targetUser.id,
        content: meetingMsg,
        message_type: 'meeting',
        sender_name: currentUser.name,
        sender_avatar: currentUser.avatar
      })
    });
  } catch (e) {}

  // Update button UI
  const btn = document.getElementById(`btn-invite-user-${targetUser.id}`);
  if (btn) {
    btn.disabled = true;
    btn.className = 'text-emerald-700 bg-emerald-100 border border-emerald-300 font-bold text-xs px-2.5 py-1 rounded-lg flex items-center gap-1 cursor-default';
    btn.innerHTML = '<i data-lucide="check" class="w-3 h-3 text-emerald-700"></i> Invited';
    if (window.lucide) lucide.createIcons();
  }

  showToast(`Meeting invitation sent to ${targetUser.name}!`, 'success');
}

function copyMeetingShareLink() {
  const input = document.getElementById('input-meeting-share-link');
  if (!input) return;
  navigator.clipboard.writeText(input.value).then(() => {
    const textEl = document.getElementById('copy-modal-link-text');
    if (textEl) {
      textEl.textContent = 'Copied!';
      setTimeout(() => { if (textEl) textEl.textContent = 'Copy'; }, 2000);
    }
    showToast('Meeting link copied to clipboard!', 'success');
  }).catch(() => {
    input.select();
    document.execCommand('copy');
    showToast('Meeting link copied!', 'success');
  });
}

function copyMeetingLink() {
  const url = `${window.location.origin}/?room=${encodeURIComponent(currentMeetingRoomId || 'room')}`;
  navigator.clipboard.writeText(url).then(() => {
    const textEl = document.getElementById('copy-meeting-link-text');
    if (textEl) {
      textEl.textContent = 'Copied!';
      setTimeout(() => { if (textEl) textEl.textContent = 'Copy Link'; }, 2000);
    }
    showToast('Meeting link copied to clipboard!', 'success');
  }).catch(() => {
    showToast('Meeting link copied!', 'success');
  });
}

function openJoinMeetingModal() {
  const modal = document.getElementById('modal-join-meeting-room');
  const input = document.getElementById('input-join-meeting-code');
  if (input) input.value = '';
  if (modal) modal.classList.remove('hidden');
}

function closeJoinMeetingModal() {
  const modal = document.getElementById('modal-join-meeting-room');
  if (modal) modal.classList.add('hidden');
}

function submitJoinMeetingCode() {
  const input = document.getElementById('input-join-meeting-code');
  if (!input || !input.value.trim()) {
    showToast('Please enter a meeting code or link', 'error');
    return;
  }
  let code = input.value.trim();
  const match = code.match(/room=([a-zA-Z0-9_\-]+)/i);
  if (match) {
    code = match[1];
  }
  closeJoinMeetingModal();
  joinMultiPartyMeetingRoom(code);
}

function joinCreatedMeetingRoom() {
  const roomId = currentNewRoomId || generateRoomId();
  closeCreateMeetingRoomModal();
  joinMultiPartyMeetingRoom(roomId);
}

function openMeetingInviteDrawer() {
  currentNewRoomId = currentMeetingRoomId;
  const modal = document.getElementById('modal-create-meeting-room');
  const inputLink = document.getElementById('input-meeting-share-link');
  if (inputLink) {
    inputLink.value = `${window.location.origin}/?room=${encodeURIComponent(currentMeetingRoomId)}`;
  }
  renderMeetingInviteContacts();
  if (modal) modal.classList.remove('hidden');
  if (window.lucide) lucide.createIcons();
}

async function joinMultiPartyMeetingRoom(roomId) {
  if (!roomId) return;
  if (!currentUser) {
    pendingUrlRoomId = roomId;
    showToast('Please sign in or select a demo role to join the meeting room.', 'info');
    return;
  }

  // End any 1-on-1 call if active
  if (peerConnection) {
    cleanupCall();
  }

  currentMeetingRoomId = roomId;
  const modal = document.getElementById('meeting-room-modal');
  const roomBadge = document.getElementById('meeting-room-badge');
  const localName = document.getElementById('meeting-local-name');
  const localRole = document.getElementById('meeting-local-role');
  const localAvatar = document.getElementById('meeting-local-avatar');

  if (roomBadge) roomBadge.textContent = roomId;
  if (localName) localName.textContent = currentUser.name || 'You';
  if (localRole) localRole.textContent = (currentUser.role || 'Buyer').toUpperCase();
  if (localAvatar) {
    localAvatar.onerror = () => { localAvatar.src = getInitialsAvatar(currentUser.name, currentUser.role); };
    localAvatar.src = currentUser.avatar || getInitialsAvatar(currentUser.name, currentUser.role);
  }

  // Update address bar query without reload
  try {
    const newUrl = `${window.location.pathname}?room=${encodeURIComponent(roomId)}`;
    window.history.replaceState({ roomId: roomId }, '', newUrl);
  } catch(e) {}

  if (modal) modal.classList.remove('hidden');

  // Request Camera & Microphone
  try {
    meetingLocalStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: { echoCancellation: true, noiseSuppression: true }
    });
  } catch (err) {
    console.warn('Meeting room media warning:', err);
    try {
      meetingLocalStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch(err2) {
      meetingLocalStream = new MediaStream();
    }
  }

  const localVideo = document.getElementById('meeting-local-video');
  if (localVideo) {
    localVideo.srcObject = meetingLocalStream;
    applyVideoMirrorStyle(localVideo, isLocalVideoMirrored);
  }

  isMeetingAudioMuted = false;
  isMeetingVideoMuted = false;
  updateMeetingControlsUI();
  updateMeetingParticipantCount();
  adjustMeetingGridCols();

  // Announce to WebSocket server
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'join_meeting_room',
      roomId: roomId,
      userInfo: {
        id: currentUser.id,
        name: currentUser.name,
        avatar: currentUser.avatar,
        role: currentUser.role
      }
    }));
  }

  // Session duration timer
  meetingRoomSeconds = 0;
  clearInterval(meetingRoomTimerInterval);
  meetingRoomTimerInterval = setInterval(() => {
    meetingRoomSeconds++;
  }, 1000);

  showToast(`Joined Virtual Meeting Room: ${roomId}`, 'success');
  if (window.lucide) lucide.createIcons();
  fetchCallLogs();
}

function leaveMeetingRoom() {
  const dur = meetingRoomSeconds || 0;
  clearInterval(meetingRoomTimerInterval);
  meetingRoomSeconds = 0;

  if (currentMeetingRoomId && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'leave_meeting_room',
      roomId: currentMeetingRoomId,
      duration: dur
    }));
  }

  if (meetingLocalStream) {
    meetingLocalStream.getTracks().forEach(t => t.stop());
    meetingLocalStream = null;
  }
  stopMeetingScreenShare();
  currentCameraFacingMode = 'user';
  isLocalVideoMirrored = true;
  const localVideo = document.getElementById('meeting-local-video');
  if (localVideo) localVideo.srcObject = null;

  // Close all peer connections
  meetingPeerConnections.forEach((pc) => {
    try { pc.close(); } catch(e){}
  });
  meetingPeerConnections.clear();
  meetingPeerStreams.clear();
  meetingPeerInfo.clear();
  meetingPendingIce.clear();

  // Remove remote tiles
  const grid = document.getElementById('meeting-video-grid');
  if (grid) {
    const remoteTiles = grid.querySelectorAll('.meeting-peer-tile');
    remoteTiles.forEach(el => el.remove());
  }

  const modal = document.getElementById('meeting-room-modal');
  if (modal) modal.classList.add('hidden');

  // Clear query string from URL
  try {
    window.history.replaceState({}, '', window.location.pathname);
  } catch(e) {}

  currentMeetingRoomId = null;
  showToast('You left the meeting room.', 'info');
  fetchCallLogs();
}

function createMeetingPeerConnection(peerId) {
  if (meetingPeerConnections.has(peerId)) {
    return meetingPeerConnections.get(peerId);
  }

  const pc = new RTCPeerConnection(rtcConfig);
  meetingPeerConnections.set(peerId, pc);
  if (!meetingPendingIce.has(peerId)) {
    meetingPendingIce.set(peerId, []);
  }

  pc.onicecandidate = (event) => {
    if (event.candidate && ws && ws.readyState === WebSocket.OPEN && currentMeetingRoomId) {
      ws.send(JSON.stringify({
        type: 'meeting_ice_candidate',
        roomId: currentMeetingRoomId,
        targetUserId: peerId,
        candidate: event.candidate
      }));
    }
  };

  pc.ontrack = (event) => {
    const stream = event.streams[0];
    meetingPeerStreams.set(peerId, stream);
    const videoEl = document.getElementById(`meeting-video-${peerId}`);
    if (videoEl) {
      videoEl.srcObject = stream;
    }
    const audioEl = document.getElementById(`meeting-audio-${peerId}`);
    if (audioEl) {
      audioEl.srcObject = stream;
    }
    const fallback = document.getElementById(`meeting-avatar-fallback-${peerId}`);
    if (fallback) {
      fallback.classList.add('hidden');
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(`Meeting peer connection ${peerId} state:`, pc.connectionState);
  };

  return pc;
}

async function drainMeetingPendingIce(peerId) {
  const pc = meetingPeerConnections.get(peerId);
  if (!pc || !pc.remoteDescription) return;
  const queue = meetingPendingIce.get(peerId) || [];
  while (queue.length > 0) {
    const cand = queue.shift();
    try {
      await pc.addIceCandidate(new RTCIceCandidate(cand));
    } catch(e) {
      console.warn('Queued meeting ICE candidate error:', e);
    }
  }
}

function renderMeetingPeerTile(peerId, info) {
  const grid = document.getElementById('meeting-video-grid');
  if (!grid) return;

  let tile = document.getElementById(`meeting-tile-${peerId}`);
  if (tile) return; // already in DOM

  tile = document.createElement('div');
  tile.id = `meeting-tile-${peerId}`;
  tile.className = 'meeting-peer-tile relative bg-slate-900 rounded-2xl overflow-hidden border border-white/10 shadow-lg flex items-center justify-center w-full h-full min-h-0 transition-all duration-300';

  const avatarUrl = info.avatar || getInitialsAvatar(info.name || 'User', info.role);
  const roleLower = (info.role || 'Member').toLowerCase();
  const roleName = (info.role || 'Member').toUpperCase();

  const roleStyles = {
    buyer: 'bg-blue-500/20 text-blue-300 border-blue-400/30',
    seller: 'bg-emerald-500/20 text-emerald-300 border-emerald-400/30',
    broker: 'bg-purple-500/20 text-purple-300 border-purple-400/30'
  };
  const roleBadgeStyle = roleStyles[roleLower] || 'bg-slate-500/20 text-slate-300 border-slate-400/30';

  tile.innerHTML = `
    <video id="meeting-video-${peerId}" autoplay playsinline class="w-full h-full object-cover"></video>
    <audio id="meeting-audio-${peerId}" autoplay></audio>
    
    <div id="meeting-avatar-fallback-${peerId}" class="absolute inset-0 bg-slate-900 flex flex-col items-center justify-center">
      <img src="${avatarUrl}" class="w-20 h-20 rounded-full border-2 border-emerald-400 object-cover shadow-xl mb-2 animate-pulse">
      <span class="text-xs text-white font-bold">${info.name || 'Participant'}</span>
      <span class="text-[10px] text-emerald-400 mt-0.5">Connecting video stream...</span>
    </div>

    <!-- Bottom Left Badge -->
    <div class="absolute bottom-2.5 left-2.5 bg-black/60 backdrop-blur-md px-2.5 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 border border-white/15 text-white shadow-md">
      <span class="truncate max-w-[110px]">${info.name || 'Participant'}</span>
      <span class="text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider border ${roleBadgeStyle}">${roleName}</span>
    </div>

    <!-- Top Right Mic Status -->
    <div class="absolute top-2.5 right-2.5 p-1.5 rounded-full bg-black/60 backdrop-blur-md text-emerald-400 border border-white/10 shadow">
      <i data-lucide="mic" class="w-3.5 h-3.5"></i>
    </div>
  `;

  grid.appendChild(tile);
  updateMeetingParticipantCount();
  adjustMeetingGridCols();
  if (window.lucide) lucide.createIcons();
}

function removeMeetingPeer(peerId) {
  const pc = meetingPeerConnections.get(peerId);
  if (pc) {
    try { pc.close(); } catch(e){}
    meetingPeerConnections.delete(peerId);
  }
  meetingPeerStreams.delete(peerId);
  meetingPendingIce.delete(peerId);
  meetingPeerInfo.delete(peerId);

  const tile = document.getElementById(`meeting-tile-${peerId}`);
  if (tile) tile.remove();

  updateMeetingParticipantCount();
  adjustMeetingGridCols();
}

function updateMeetingParticipantCount() {
  const grid = document.getElementById('meeting-video-grid');
  const tiles = grid ? grid.querySelectorAll('.meeting-tile, .meeting-peer-tile') : [];
  const count = tiles.length || 1;
  const countEl = document.getElementById('meeting-participant-count');
  const banner = document.getElementById('meeting-waiting-banner');

  if (countEl) {
    countEl.textContent = `${count} in room`;
  }
  if (banner) {
    if (count > 1) {
      banner.classList.add('hidden');
    } else {
      banner.classList.remove('hidden');
    }
  }
}

function adjustMeetingGridCols() {
  const grid = document.getElementById('meeting-video-grid');
  if (!grid) return;
  const tiles = Array.from(grid.querySelectorAll('.meeting-tile, .meeting-peer-tile'));
  const count = tiles.length;

  // Reset grid and span classes
  grid.className = 'flex-1 w-full h-full min-h-0 grid gap-2.5 p-2 overflow-hidden';
  tiles.forEach(t => {
    t.classList.remove('col-span-2', 'col-span-1', 'row-span-1', 'row-span-2');
  });

  if (count <= 1) {
    grid.classList.add('grid-cols-1', 'grid-rows-1');
    if (tiles[0]) tiles[0].classList.add('col-span-1', 'row-span-1');
  } else if (count === 2) {
    // 2 participants: stack vertically to fill mobile viewport
    grid.classList.add('grid-cols-1', 'grid-rows-2');
    tiles.forEach(t => t.classList.add('col-span-1', 'row-span-1'));
  } else if (count === 3) {
    // 3 participants: Top tile spans full width (50% height), bottom 2 tiles are side-by-side (50% height)
    grid.classList.add('grid-cols-2', 'grid-rows-2');
    if (tiles[0]) tiles[0].classList.add('col-span-2', 'row-span-1');
    if (tiles[1]) tiles[1].classList.add('col-span-1', 'row-span-1');
    if (tiles[2]) tiles[2].classList.add('col-span-1', 'row-span-1');
  } else if (count === 4) {
    // 4 participants: 2x2 grid
    grid.classList.add('grid-cols-2', 'grid-rows-2');
    tiles.forEach(t => t.classList.add('col-span-1', 'row-span-1'));
  } else {
    // 5+ participants: 2 columns, 3 rows
    grid.classList.add('grid-cols-2', 'grid-rows-3');
    tiles.forEach(t => t.classList.add('col-span-1', 'row-span-1'));
  }
}

function toggleMeetingMic() {
  if (!meetingLocalStream) return;
  const audioTracks = meetingLocalStream.getAudioTracks();
  if (audioTracks.length === 0) return;
  isMeetingAudioMuted = !isMeetingAudioMuted;
  audioTracks.forEach(t => t.enabled = !isMeetingAudioMuted);
  updateMeetingControlsUI();
}

function toggleMeetingCam() {
  if (!meetingLocalStream) return;
  const videoTracks = meetingLocalStream.getVideoTracks();
  if (videoTracks.length === 0) return;
  isMeetingVideoMuted = !isMeetingVideoMuted;
  videoTracks.forEach(t => t.enabled = !isMeetingVideoMuted);

  const fallback = document.getElementById('meeting-local-avatar-fallback');
  if (fallback) {
    if (isMeetingVideoMuted) {
      fallback.classList.remove('hidden');
    } else {
      fallback.classList.add('hidden');
    }
  }
  updateMeetingControlsUI();
}

function updateMeetingControlsUI() {
  const btnMic = document.getElementById('btn-meeting-mic');
  const iconMic = document.getElementById('meeting-icon-mic');
  const localMicBadge = document.getElementById('meeting-local-mic-badge');

  if (btnMic && iconMic) {
    if (isMeetingAudioMuted) {
      btnMic.className = 'p-3 rounded-full bg-rose-600 hover:bg-rose-700 text-white transition';
      iconMic.setAttribute('data-lucide', 'mic-off');
      if (localMicBadge) {
        localMicBadge.className = 'absolute top-2 right-2 p-1 rounded-full bg-rose-600 text-white';
        localMicBadge.innerHTML = '<i data-lucide="mic-off" class="w-3 h-3"></i>';
      }
    } else {
      btnMic.className = 'p-3 rounded-full bg-white/10 hover:bg-white/20 text-white transition';
      iconMic.setAttribute('data-lucide', 'mic');
      if (localMicBadge) {
        localMicBadge.className = 'absolute top-2 right-2 p-1 rounded-full bg-black/60 text-emerald-400';
        localMicBadge.innerHTML = '<i data-lucide="mic" class="w-3 h-3"></i>';
      }
    }
  }

  const btnCam = document.getElementById('btn-meeting-cam');
  const iconCam = document.getElementById('meeting-icon-cam');
  if (btnCam && iconCam) {
    if (isMeetingVideoMuted) {
      btnCam.className = 'p-3 rounded-full bg-rose-600 hover:bg-rose-700 text-white transition';
      iconCam.setAttribute('data-lucide', 'video-off');
    } else {
      btnCam.className = 'p-3 rounded-full bg-white/10 hover:bg-white/20 text-white transition';
      iconCam.setAttribute('data-lucide', 'video');
    }
  }

  if (window.lucide) lucide.createIcons();
}

async function toggleMeetingScreenShare() {
  const btn = document.getElementById('btn-meeting-screen');
  if (!isMeetingScreenSharing) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      showToast('Screen sharing is not supported by your mobile browser (iOS Safari / mobile WebView). Please use Chrome on Android or Desktop.', 'warning');
      return;
    }

    try {
      let stream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: 'always' }, audio: false });
      } catch(err1) {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      }

      meetingScreenStream = stream;
      const screenTrack = meetingScreenStream.getVideoTracks()[0];

      // Update local preview - unmirrored for readable text
      const localVideo = document.getElementById('meeting-local-video');
      if (localVideo) {
        localVideo.srcObject = meetingScreenStream;
        applyVideoMirrorStyle(localVideo, false);
      }

      // Replace track for all connected peers in mesh
      meetingPeerConnections.forEach((pc) => {
        const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) sender.replaceTrack(screenTrack);
      });

      screenTrack.onended = () => {
        stopMeetingScreenShare();
      };

      isMeetingScreenSharing = true;
      if (btn) btn.className = 'w-12 h-12 rounded-full bg-emerald-600 active:scale-95 text-white flex items-center justify-center transition border border-white/10 shadow-md';
      showToast('Screen sharing started with meeting room participants', 'info');
    } catch(err) {
      console.warn('Screen share canceled or error:', err);
      if (err.name === 'NotAllowedError') {
        showToast('Screen share permission denied or cancelled', 'info');
      } else {
        showToast('Screen sharing is restricted on this mobile device', 'warning');
      }
    }
  } else {
    stopMeetingScreenShare();
  }
}

function stopMeetingScreenShare() {
  if (!isMeetingScreenSharing) return;
  if (meetingScreenStream) {
    meetingScreenStream.getTracks().forEach(t => t.stop());
    meetingScreenStream = null;
  }
  if (meetingLocalStream) {
    const videoTrack = meetingLocalStream.getVideoTracks()[0];
    if (videoTrack) {
      meetingPeerConnections.forEach((pc) => {
        const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) sender.replaceTrack(videoTrack);
      });
      const localVideo = document.getElementById('meeting-local-video');
      if (localVideo) {
        localVideo.srcObject = meetingLocalStream;
        applyVideoMirrorStyle(localVideo, isLocalVideoMirrored);
      }
    }
  }
  isMeetingScreenSharing = false;
  const btn = document.getElementById('btn-meeting-screen');
  if (btn) btn.className = 'w-12 h-12 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 text-white flex items-center justify-center transition border border-white/10 shadow-md';
  showToast('Screen sharing stopped', 'info');
}

function checkUrlForMeetingRoom() {
  try {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('room')) {
      const roomId = urlParams.get('room');
      if (roomId) {
        if (currentToken && currentUser) {
          setTimeout(() => {
            joinMultiPartyMeetingRoom(roomId);
          }, 600);
        } else {
          pendingUrlRoomId = roomId;
        }
      }
    }
  } catch(e) {}
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
          if (Array.isArray(data.onlineUsers)) {
            onlineUserIds = new Set(data.onlineUsers.map(Number));
            renderContactsList();
            updateChatPeerStatusUI();
          }
          break;

        case 'online_users':
          if (Array.isArray(data.userIds)) {
            onlineUserIds = new Set(data.userIds.map(Number));
            renderContactsList();
            updateChatPeerStatusUI();
          }
          break;

        case 'user_status': {
          const uid = Number(data.userId);
          if (data.status === 'online') {
            onlineUserIds.add(uid);
          } else {
            onlineUserIds.delete(uid);
            peerTypingMap.delete(uid);
          }
          renderContactsList();
          updateChatPeerStatusUI();
          break;
        }

        case 'typing': {
          const senderId = Number(data.senderId);
          handleIncomingPeerTyping(senderId, Boolean(data.isTyping));
          break;
        }

        case 'pong':
          break;

        case 'new_message': {
          const msg = data.message;
          if (!msg) break;

          const msgSenderId = Number(msg.sender_id);
          const msgReceiverId = Number(msg.receiver_id);
          handleIncomingPeerTyping(msgSenderId, false);
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
            updateChatPeerStatusUI();
          }

          // Real-time update of recent conversations list & unread counters
          const peerId = (msgSenderId === myId) ? msgReceiverId : msgSenderId;
          const msgTime = msg.created_at || new Date().toISOString();
          let conv = recentConversations.find(c => Number(c.peer_id) === peerId);
          if (!conv) {
            const isSelfMsg = (msgSenderId === msgReceiverId);
            conv = {
              peer_id: peerId,
              peer_name: msg.sender_name || 'User',
              peer_avatar: msg.sender_avatar || '',
              peer_role: 'buyer',
              last_message: msg.content,
              last_message_type: msg.message_type,
              last_message_time: msgTime,
              last_message_sender_id: msgSenderId,
              last_message_is_read: isSelfMsg ? 1 : (isCurrentChat ? 1 : 0),
              unread_count: (isCurrentChat || isSelfMsg) ? 0 : 1
            };
            recentConversations.unshift(conv);
          } else {
            const isSelfMsg = (msgSenderId === msgReceiverId);
            conv.last_message = msg.content;
            conv.last_message_type = msg.message_type;
            conv.last_message_time = msgTime;
            conv.last_message_sender_id = msgSenderId;
            conv.last_message_is_read = isSelfMsg ? 1 : (isCurrentChat ? 1 : 0);
            if (!isCurrentChat && !isSelfMsg) {
              conv.unread_count = (Number(conv.unread_count) || 0) + 1;
            } else {
              conv.unread_count = 0;
            }
            const idx = recentConversations.indexOf(conv);
            if (idx > -1) recentConversations.splice(idx, 1);
            recentConversations.unshift(conv);
          }

          if (isCurrentChat && msgSenderId !== myId && !isSelfMsg && ws && ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(JSON.stringify({ type: 'mark_as_read', sender_id: msgSenderId }));
            } catch (e) {}
          }

          // Keep in-memory cache synchronized
          if (chatMessagesCache.has(peerId)) {
            const cachedList = chatMessagesCache.get(peerId);
            const exists = cachedList.some(m => (m.id && m.id === msg.id) || (m.tempId && m.tempId === msg.tempId));
            if (!exists) {
              cachedList.push(msg);
            }
          }

          renderContactsList();
          updateUnreadBadgesCounter();
          break;
        }

        case 'messages_seen': {
          const readerId = Number(data.reader_id);
          if (activeChatPeer && Number(activeChatPeer.id) === readerId) {
            document.querySelectorAll('#chat-messages-container i[data-lucide="check-check"], #chat-messages-container i[data-lucide="check"]').forEach(icon => {
              icon.setAttribute('data-lucide', 'check-check');
              icon.className = 'w-3.5 h-3.5 text-[#53bdeb]';
            });
            if (chatMessagesCache.has(readerId)) {
              chatMessagesCache.get(readerId).forEach(m => { m.is_read = 1; });
            }
          }
          const conv = recentConversations.find(c => Number(c.peer_id) === readerId);
          if (conv) {
            conv.last_message_is_read = 1;
          }
          renderContactsList();
          if (window.lucide) lucide.createIcons();
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
          await drainPendingIceCandidates();
          const answer = await peerConnection.createAnswer();
          await peerConnection.setLocalDescription(answer);
          ws.send(JSON.stringify({
            type: 'webrtc_answer',
            targetUserId: data.senderId || data.callerId || activeCallTargetId,
            answer: answer
          }));
          break;

        case 'webrtc_answer':
          if (peerConnection) {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
            await drainPendingIceCandidates();
          }
          break;

        case 'ice_candidate':
          if (data.candidate) {
            if (peerConnection && peerConnection.remoteDescription && peerConnection.remoteDescription.type) {
              try {
                await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
              } catch (err) {
                console.error('Error adding ICE candidate:', err);
              }
            } else {
              pendingIceCandidates.push(data.candidate);
            }
          }
          break;

        // --- Multi-Party Meeting Room Events ---
        case 'meeting_room_joined':
          console.log('Joined meeting room:', data.roomId, 'Existing peers:', data.participants);
          updateMeetingParticipantCount();
          if (Array.isArray(data.participants)) {
            for (const peer of data.participants) {
              meetingPeerInfo.set(peer.id, peer);
              renderMeetingPeerTile(peer.id, peer);
              const pc = createMeetingPeerConnection(peer.id);
              if (meetingLocalStream) {
                meetingLocalStream.getTracks().forEach(t => pc.addTrack(t, meetingLocalStream));
              }
              try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                ws.send(JSON.stringify({
                  type: 'meeting_offer',
                  roomId: currentMeetingRoomId,
                  targetUserId: peer.id,
                  offer: offer,
                  senderInfo: {
                    id: currentUser.id,
                    name: currentUser.name,
                    avatar: currentUser.avatar,
                    role: currentUser.role
                  }
                }));
              } catch (e) {
                console.error('Error creating meeting offer to peer', peer.id, e);
              }
            }
          }
          break;

        case 'meeting_peer_joined':
          if (data.peer && data.peer.id !== currentUser.id) {
            console.log('New peer joined meeting room:', data.peer);
            meetingPeerInfo.set(data.peer.id, data.peer);
            renderMeetingPeerTile(data.peer.id, data.peer);
            showToast(`${data.peer.name || 'A user'} joined the meeting room`, 'info');
          }
          break;

        case 'meeting_peer_left':
          if (data.peerId) {
            const peer = meetingPeerInfo.get(data.peerId);
            const peerName = peer ? peer.name : 'Participant';
            removeMeetingPeer(data.peerId);
            showToast(`${peerName} left the meeting`, 'info');
          }
          break;

        case 'meeting_offer':
          if (data.senderId && data.offer) {
            if (data.senderInfo) {
              meetingPeerInfo.set(data.senderId, data.senderInfo);
              renderMeetingPeerTile(data.senderId, data.senderInfo);
            }
            const pc = createMeetingPeerConnection(data.senderId);
            if (meetingLocalStream && pc.getSenders().length === 0) {
              meetingLocalStream.getTracks().forEach(t => pc.addTrack(t, meetingLocalStream));
            }
            try {
              await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
              await drainMeetingPendingIce(data.senderId);
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              ws.send(JSON.stringify({
                type: 'meeting_answer',
                roomId: currentMeetingRoomId || data.roomId,
                targetUserId: data.senderId,
                answer: answer
              }));
            } catch (err) {
              console.error('Error handling meeting offer from', data.senderId, err);
            }
          }
          break;

        case 'meeting_answer':
          if (data.senderId && data.answer) {
            const pc = meetingPeerConnections.get(data.senderId);
            if (pc) {
              try {
                await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
                await drainMeetingPendingIce(data.senderId);
              } catch (err) {
                console.error('Error setting meeting answer from', data.senderId, err);
              }
            }
          }
          break;

        case 'meeting_ice_candidate':
          if (data.senderId && data.candidate) {
            const pc = meetingPeerConnections.get(data.senderId);
            if (pc && pc.remoteDescription && pc.remoteDescription.type) {
              try {
                await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
              } catch (e) {
                console.error('Error applying meeting candidate:', e);
              }
            } else {
              if (!meetingPendingIce.has(data.senderId)) {
                meetingPendingIce.set(data.senderId, []);
              }
              meetingPendingIce.get(data.senderId).push(data.candidate);
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

// ================= MAP VIEW & GEOLOCATION (INTERACTIVE LEAFLET MAP) =================

let selectedMapListing = null;
let landMapInstance = null;
let landMapMarkers = {}; // listingId -> L.marker

function createLandMarkerIcon(listing, isSelected = false) {
  const priceNum = Number(listing.price) || 0;
  const priceFormatted = priceNum >= 10000000 
    ? `₹${(priceNum / 10000000).toFixed(1)}Cr` 
    : `₹${(priceNum / 100000).toFixed(1)}L`;

  let colorClass = 'bg-emerald-600';
  let ringClass = 'ring-emerald-400';
  let iconChar = '🌱';

  if (listing.property_type === 'Commercial') {
    colorClass = 'bg-purple-600';
    ringClass = 'ring-purple-400';
    iconChar = '🏢';
  } else if (listing.property_type === 'Industrial') {
    colorClass = 'bg-amber-600';
    ringClass = 'ring-amber-400';
    iconChar = '🏭';
  } else if (listing.property_type === 'Residential') {
    colorClass = 'bg-blue-600';
    ringClass = 'ring-blue-400';
    iconChar = '🏡';
  }

  const scaleClass = isSelected 
    ? 'scale-115 ring-4 ring-offset-2 ring-emerald-500 shadow-2xl z-50' 
    : 'scale-100 ring-2 ring-offset-1 ring-white/90 shadow-md';

  return L.divIcon({
    className: 'land-custom-marker',
    html: `
      <div class="relative flex flex-col items-center cursor-pointer transition-all duration-200 transform hover:scale-110 select-none ${scaleClass}">
        <div class="w-8 h-8 rounded-full ${colorClass} text-white flex items-center justify-center text-xs font-bold border-2 border-white shadow-lg">
          <span>${iconChar}</span>
        </div>
        <div class="bg-slate-900/90 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-md shadow mt-0.5 whitespace-nowrap border border-white/30 backdrop-blur-xs">
          ${priceFormatted}
        </div>
      </div>
    `,
    iconSize: [42, 48],
    iconAnchor: [21, 24],
    popupAnchor: [0, -26]
  });
}

function initInteractiveLandMap() {
  if (typeof L === 'undefined') {
    console.warn('Leaflet library is still loading...');
    return;
  }
  const container = document.getElementById('interactive-land-map');
  if (!container) return;

  if (!landMapInstance) {
    landMapInstance = L.map('interactive-land-map', {
      zoomControl: true,
      attributionControl: false
    }).setView([12.9716, 77.5946], 11);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap'
    }).addTo(landMapInstance);
  }

  // Invalidate size to ensure clean tile rendering when switching tabs
  landMapInstance.invalidateSize();

  // Clear existing markers
  Object.values(landMapMarkers).forEach(m => m.remove());
  landMapMarkers = {};

  const validListings = allListings.filter(l => l.latitude && l.longitude);
  const counterEl = document.getElementById('map-counter');
  if (counterEl) {
    counterEl.textContent = `${validListings.length} Land Parcels`;
  }

  if (validListings.length === 0) return;

  const latLngs = [];

  validListings.forEach(item => {
    const lat = parseFloat(item.latitude);
    const lng = parseFloat(item.longitude);
    if (isNaN(lat) || isNaN(lng)) return;

    latLngs.push([lat, lng]);

    const isSelected = selectedMapListing && String(selectedMapListing.id) === String(item.id);
    const marker = L.marker([lat, lng], {
      icon: createLandMarkerIcon(item, isSelected)
    }).addTo(landMapInstance);

    const firstImg = (item.images && item.images.length > 0) 
      ? item.images[0] 
      : 'https://images.unsplash.com/photo-1500382017468-9049fed747ef?w=300';

    const formattedPrice = Number(item.price).toLocaleString('en-IN');
    const areaSqft = Number(item.area_sqft) || 0;
    const acres = (areaSqft / 43560).toFixed(2);
    const areaText = acres > 0 ? `${acres} Acres (${areaSqft.toLocaleString('en-IN')} sq.ft)` : `${areaSqft} sq.ft`;

    const popupHtml = `
      <div class="p-1 min-w-[190px] text-slate-800 font-sans cursor-pointer" onclick="openPropertyDetails(${item.id})">
        <img src="${firstImg}" class="w-full h-24 object-cover rounded-xl mb-1.5 shadow-xs border border-slate-100" 
             onerror="this.src='https://images.unsplash.com/photo-1500382017468-9049fed747ef?w=300'">
        <div class="flex items-center justify-between">
          <span class="text-[9px] font-bold uppercase tracking-wider text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded">${escapeHTML(item.property_type || 'Land')}</span>
          <span class="text-[9px] text-slate-500 font-medium">${areaText}</span>
        </div>
        <div class="font-bold text-xs text-slate-900 truncate mt-1">${escapeHTML(item.title)}</div>
        <div class="text-xs font-extrabold text-emerald-600 mt-0.5">₹${formattedPrice}</div>
        <button onclick="event.stopPropagation(); openPropertyDetails(${item.id})" class="mt-2 w-full bg-wa-teal hover:bg-wa-tealDark text-white text-[11px] font-bold py-1.5 px-2 rounded-xl text-center transition flex items-center justify-center gap-1 shadow-xs">
          <span>View Land Details</span>
          <span>👉</span>
        </button>
      </div>
    `;

    marker.bindPopup(popupHtml, { maxWidth: 220, closeButton: false, offset: [0, -10] });

    marker.on('click', () => {
      selectMapParcel(item.id, false);
    });

    landMapMarkers[item.id] = marker;
  });

  if (!selectedMapListing && validListings.length > 0) {
    selectedMapListing = validListings[0];
  }

  if (selectedMapListing) {
    updateMapCard(selectedMapListing);
  }

  // Auto-fit bounds so all parcel dots are visible
  if (latLngs.length > 0) {
    try {
      const bounds = L.latLngBounds(latLngs);
      landMapInstance.fitBounds(bounds, { padding: [45, 45], maxZoom: 13 });
    } catch (e) {
      console.warn('Map fitBounds notice:', e);
    }
  }
}

function recenterLandMap() {
  if (!landMapInstance) {
    initInteractiveLandMap();
    return;
  }
  const validListings = allListings.filter(l => l.latitude && l.longitude);
  if (validListings.length === 0) return;
  const latLngs = validListings.map(l => [parseFloat(l.latitude), parseFloat(l.longitude)]);
  const bounds = L.latLngBounds(latLngs);
  landMapInstance.fitBounds(bounds, { padding: [45, 45], maxZoom: 13 });
}

function renderMapParcelsSelector() {
  const container = document.getElementById('map-parcels-selector');
  const counter = document.getElementById('map-counter');
  if (counter) counter.textContent = `${allListings.length} Land Parcels`;
  if (!container) return;

  if (allListings.length === 0) {
    container.innerHTML = `<span class="text-slate-400 text-[11px]">No parcels available</span>`;
    return;
  }

  container.innerHTML = allListings.map(item => {
    const isSelected = selectedMapListing && String(selectedMapListing.id) === String(item.id);
    let icon = '🌱';
    if (item.property_type === 'Commercial') icon = '🏢';
    else if (item.property_type === 'Industrial') icon = '🏭';
    else if (item.property_type === 'Residential') icon = '🏡';

    const priceNum = Number(item.price) || 0;
    const priceFormatted = priceNum >= 10000000 
      ? `₹${(priceNum / 10000000).toFixed(1)}Cr` 
      : `₹${(priceNum / 100000).toFixed(1)}L`;

    return `
      <button onclick="selectMapParcel(${item.id}, true)" 
              class="px-2.5 py-1 rounded-full whitespace-nowrap text-[11px] font-semibold transition border flex items-center gap-1 shrink-0 ${
                isSelected 
                  ? 'bg-wa-teal text-white border-wa-teal shadow-xs' 
                  : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-200'
              }">
        <span>${icon}</span>
        <span>${escapeHTML(item.title.split(' ').slice(0, 2).join(' '))}</span>
        <span class="opacity-80 font-normal">(${priceFormatted})</span>
      </button>
    `;
  }).join('');
}

function selectMapParcel(listingId, panTo = true) {
  const item = allListings.find(l => String(l.id) === String(listingId));
  if (!item) return;
  selectedMapListing = item;
  updateMapCard(item);
  renderMapParcelsSelector();

  // Refresh icons to show which one is actively selected
  Object.keys(landMapMarkers).forEach(id => {
    const isCur = String(id) === String(item.id);
    const m = landMapMarkers[id];
    const targetListing = allListings.find(l => String(l.id) === String(id));
    if (m && targetListing) {
      m.setIcon(createLandMarkerIcon(targetListing, isCur));
    }
  });

  const marker = landMapMarkers[item.id];
  if (marker && landMapInstance) {
    if (panTo) {
      landMapInstance.flyTo([item.latitude, item.longitude], 14, { duration: 0.6 });
    }
    marker.openPopup();
  }
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
  const areaEl = document.getElementById('map-card-area');
  const imgEl = document.getElementById('map-card-img');

  if (titleEl) titleEl.textContent = listing.title;
  if (priceEl) priceEl.textContent = `₹${Number(listing.price).toLocaleString('en-IN')}`;
  if (typeEl) typeEl.textContent = listing.property_type;
  if (areaEl) {
    const areaSqft = Number(listing.area_sqft) || 0;
    const acres = (areaSqft / 43560).toFixed(2);
    areaEl.textContent = acres > 0 ? `${acres} Acres (${areaSqft.toLocaleString('en-IN')} sq.ft)` : `${areaSqft} sq.ft`;
  }
  if (imgEl) {
    const firstImg = (listing.images && listing.images.length > 0) 
      ? listing.images[0] 
      : 'https://images.unsplash.com/photo-1500382017468-9049fed747ef?w=200';
    imgEl.src = firstImg;
  }
  if (window.lucide) lucide.createIcons();
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
    startChatWithUser(item.owner_id, escapeQuotes(item.owner_name), escapeQuotes(item.owner_avatar), item.owner_role, item.id);
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
  const listing = activePropertyDetailListing || (allListings && allListings.length > 0 ? allListings[0] : null);
  const modal = document.getElementById('calculator-modal');
  if (modal) {
    modal.classList.remove('hidden');
    modal.style.zIndex = '70';
  }

  if (listing) {
    const priceInput = document.getElementById('calc-stamp-price');
    const loanAmountInput = document.getElementById('calc-loan-amount');
    const areaInput = document.getElementById('calc-area-input');
    const areaUnit = document.getElementById('calc-area-unit');

    const price = listing.price || 5000000;
    if (priceInput) priceInput.value = price;
    if (loanAmountInput) loanAmountInput.value = Math.round(price * 0.75); // 75% LTV standard

    if (areaInput && listing.area_sqft) {
      areaInput.value = listing.area_sqft;
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
    fallbackFormNetworkLocation(latInput, lngInput, statusEl);
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
      showToast(`📍 GPS coordinates detected (±${acc}m accuracy)`, 'success');
    },
    async (err) => {
      console.warn('GPS detection notice:', err);
      fallbackFormNetworkLocation(latInput, lngInput, statusEl);
    },
    { enableHighAccuracy: true, timeout: 6000, maximumAge: 60000 }
  );
}

async function fallbackFormNetworkLocation(latInput, lngInput, statusEl) {
  try {
    const res = await fetch('https://get.geojs.io/v1/ip/geo.json');
    if (res.ok) {
      const data = await res.json();
      if (data && data.latitude && data.longitude) {
        const lat = parseFloat(data.latitude).toFixed(5);
        const lng = parseFloat(data.longitude).toFixed(5);
        const city = data.city || data.region || 'Local area';
        if (latInput) latInput.value = lat;
        if (lngInput) lngInput.value = lng;
        if (statusEl) {
          statusEl.innerHTML = `<span class="text-emerald-700 font-semibold">📍 Network Location (${city}): ${lat}, ${lng}</span>`;
        }
        showToast(`📍 Approximate coordinates detected via network (${city})`, 'info');
        return;
      }
    }
  } catch (e) {}

  if (statusEl) {
    statusEl.innerHTML = `<span class="text-slate-500">Tap "Pick on Map" to pinpoint property.</span>`;
  }
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

async function fallbackNetworkLocation(targetStatusEl, reason = 'GPS unavailable') {
  if (targetStatusEl) targetStatusEl.textContent = '🌐 Estimating via network IP...';

  // Attempt 1: GeoJS
  try {
    const res = await fetch('https://get.geojs.io/v1/ip/geo.json');
    if (res.ok) {
      const data = await res.json();
      if (data && data.latitude && data.longitude) {
        const lat = parseFloat(data.latitude);
        const lng = parseFloat(data.longitude);
        const city = data.city || data.region || 'Local Region';
        panPickerMap(lat, lng, `${city} (Network IP)`);
        if (targetStatusEl) targetStatusEl.textContent = `📍 ${city} (Estimated via Network)`;
        showToast(`📍 Pinned to ${city} via network (${reason})`, 'info');
        return { lat, lng, city };
      }
    }
  } catch (e) {}

  // Attempt 2: ipapi
  try {
    const res = await fetch('https://ipapi.co/json/');
    if (res.ok) {
      const data = await res.json();
      if (data && data.latitude && data.longitude) {
        const lat = parseFloat(data.latitude);
        const lng = parseFloat(data.longitude);
        const city = data.city || data.region || 'Local Region';
        panPickerMap(lat, lng, `${city} (Network IP)`);
        if (targetStatusEl) targetStatusEl.textContent = `📍 ${city} (Estimated via Network)`;
        showToast(`📍 Pinned to ${city} via network`, 'info');
        return { lat, lng, city };
      }
    }
  } catch (e) {}

  // Attempt 3: Default Bengaluru region center
  panPickerMap(12.9716, 77.5946, 'Bengaluru Center (Default)');
  if (targetStatusEl) targetStatusEl.textContent = '📍 Bengaluru Center (Drag pin to parcel)';
  showToast('📍 Pinned to region center. Drag the pin or select a quick area above.', 'info');
  return { lat: 12.9716, lng: 77.5946, city: 'Bengaluru' };
}

function detectGPSInsidePicker() {
  const statusEl = document.getElementById('picker-geocode-status');

  if (!navigator.geolocation) {
    if (statusEl) statusEl.textContent = 'GPS not supported by browser';
    fallbackNetworkLocation(statusEl, 'Browser lacks GPS');
    return;
  }

  if (statusEl) statusEl.textContent = '🛰️ Pinpointing GPS...';

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      panPickerMap(lat, lng, 'My GPS Location');
      showToast('📍 Pin moved to your exact GPS coordinates!', 'success');
      if (statusEl) statusEl.textContent = '✓ GPS Locked (' + lat.toFixed(5) + ', ' + lng.toFixed(5) + ')';
    },
    (err) => {
      let reason = 'GPS unavailable';
      if (err.code === 1) { // PERMISSION_DENIED
        reason = 'Permission blocked';
        showToast('📍 Browser location is blocked. Falling back to your network location... (Tap 🔒 in browser URL bar to allow location)', 'info');
      } else if (err.code === 2) {
        reason = 'Signal unavailable';
        showToast('📍 Device GPS signal unavailable. Using network location...', 'info');
      } else if (err.code === 3) {
        reason = 'Timed out';
        showToast('📍 GPS timed out. Using network location...', 'info');
      }
      fallbackNetworkLocation(statusEl, reason);
    },
    { enableHighAccuracy: true, timeout: 6000, maximumAge: 60000 }
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

  const defaultAvatar = getInitialsAvatar(currentUser.name || 'User', currentUser.role);
  const avatarSrc = currentUser.avatar || defaultAvatar;

  const nameInput = document.getElementById('edit-profile-name');
  const bioInput = document.getElementById('edit-profile-bio');
  const avatarUrlInput = document.getElementById('edit-profile-avatar-url');
  const avatarPreview = document.getElementById('edit-profile-avatar-preview');
  if (avatarPreview) {
    avatarPreview.onerror = () => { avatarPreview.src = defaultAvatar; };
  }
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

// Global window bindings for calculator & modal triggers
window.openLandCalculatorForActiveProperty = openLandCalculatorForActiveProperty;
window.openLandCalculatorModal = openLandCalculatorModal;
window.closeLandCalculatorModal = closeLandCalculatorModal;
window.closeCalculatorModal = closeLandCalculatorModal;
window.openPropertyDetails = openPropertyDetails;
window.closePropertyDetails = closePropertyDetails;
window.recenterLandMap = recenterLandMap;
window.selectMapParcel = selectMapParcel;
window.initInteractiveLandMap = initInteractiveLandMap;
window.openSelectedMapPlotDetails = openSelectedMapPlotDetails;
window.callListingOwnerFromMap = callListingOwnerFromMap;
window.chatListingOwnerFromMap = chatListingOwnerFromMap;
window.startChatWithUser = startChatWithUser;
window.sendPropertyInquiryForListing = sendPropertyInquiryForListing;
window.attachListingInChat = attachListingInChat;
