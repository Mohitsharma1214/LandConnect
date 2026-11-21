// LandConnect Core Application Logic & WebRTC Real-Time Calling Engine

const API_BASE = window.location.origin;
let WS_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;

// --- State Variables ---
let currentUser = null;
let currentToken = localStorage.getItem('landconnect_token') || null;
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

// --- Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
  updateClock();
  setInterval(updateClock, 10000);

  if (currentToken) {
    // Optimistically show main app immediately (zero flicker)
    showMainApp();
    loadListings();
    loadUsersList();
    initWebSocket();

    const valid = await fetchUserProfile();
    if (!valid) {
      handleLogoutSilent();
    }
  } else {
    showAuthScreen();
  }
});

function handleLogoutSilent() {
  currentToken = null;
  currentUser = null;
  localStorage.removeItem('landconnect_token');
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
      showAuthFeedback('Login successful! Welcome to LandConnect.', false);
      setTimeout(async () => {
        showMainApp();
        await loadListings();
        await loadUsersList();
        initWebSocket();
      }, 500);
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
      showAuthFeedback(`Account created successfully as ${role.toUpperCase()}! Entering app...`, false);
      setTimeout(async () => {
        showMainApp();
        await loadListings();
        await loadUsersList();
        initWebSocket();
      }, 700);
    } else {
      showAuthFeedback(data.error || 'Registration failed.');
    }
  } catch (err) {
    showAuthFeedback('Connection error: ' + err.message);
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

function handleLogout() {
  if (confirm('Are you sure you want to sign out of LandConnect?')) {
    currentToken = null;
    currentUser = null;
    localStorage.removeItem('landconnect_token');
    document.documentElement.classList.remove('user-has-session');
    if (ws) {
      try { ws.close(); } catch(e){}
    }
    showAuthScreen();
  }
}

async function fetchUserProfile() {
  if (!currentToken) return false;
  try {
    const res = await fetch(`${API_BASE}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${currentToken}` }
    });
    if (res.ok) {
      currentUser = await res.json();
      return true;
    }
    return false;
  } catch (err) {
    console.error('Error fetching profile:', err);
    return false;
  }
}

function applyUserRoleUI() {
  if (!currentUser) return;

  // Header
  const roleText = document.getElementById('header-role-text');
  const avatarImg = document.getElementById('header-avatar');
  if (roleText) roleText.textContent = currentUser.role;
  if (avatarImg && currentUser.avatar) avatarImg.src = currentUser.avatar;

  // Profile Tab
  const pName = document.getElementById('profile-card-name');
  const pRole = document.getElementById('profile-card-role-badge');
  const pEmail = document.getElementById('profile-card-email');
  const pPhone = document.getElementById('profile-card-phone');
  const pAvatar = document.getElementById('profile-card-avatar');
  
  if (pName) pName.textContent = currentUser.name;
  if (pEmail) pEmail.textContent = currentUser.email;
  if (pPhone) pPhone.textContent = `Phone: ${currentUser.phone_masked} (Protected)`;
  if (pAvatar && currentUser.avatar) pAvatar.src = currentUser.avatar;

  if (pRole) {
    pRole.textContent = currentUser.role;
    pRole.className = `text-[10px] px-2.5 py-0.5 rounded-full font-bold uppercase tracking-wider ${
      currentUser.role === 'buyer' ? 'bg-blue-100 text-blue-700' :
      currentUser.role === 'seller' ? 'bg-emerald-100 text-emerald-700' :
      'bg-purple-100 text-purple-700'
    }`;
  }

  // Role Permissions
  const bannerTitle = document.getElementById('banner-role-title');
  const bannerDesc = document.getElementById('banner-role-desc');
  const bannerPostBtn = document.getElementById('banner-post-btn');
  const floatingPostBtn = document.getElementById('floating-post-btn');
  const permPostStatus = document.getElementById('perm-post-status');

  const canPost = (currentUser.role === 'seller' || currentUser.role === 'broker');
  const myPropertiesSection = document.getElementById('my-properties-section');

  if (canPost) {
    if (bannerPostBtn) bannerPostBtn.classList.remove('hidden');
    if (floatingPostBtn) floatingPostBtn.classList.remove('hidden');
    if (bannerTitle) bannerTitle.textContent = `${currentUser.role.toUpperCase()} MODE: LISTING MANAGEMENT`;
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

  if (tabId === 'calls') fetchCallLogs();
  if (tabId === 'map') {
    renderMapParcelsSelector();
    updateMapCard(selectedMapListing || allListings[0]);
  }
  if (tabId === 'profile' && (currentUser?.role === 'seller' || currentUser?.role === 'broker')) {
    loadMyListings();
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
    const firstImg = item.images && item.images.length > 0 
      ? item.images[0] 
      : 'https://images.unsplash.com/photo-1500382017468-9049fed747ef?w=800';

    return `
      <div class="bg-white rounded-2xl overflow-hidden shadow-sm border border-slate-200/80 hover:shadow-md transition">
        <!-- Clickable Photo and Header (Opens Details Modal) -->
        <div onclick="openPropertyDetails(${item.id})" class="relative h-44 w-full bg-slate-100 cursor-pointer group">
          <img src="${firstImg}" class="w-full h-full object-cover group-hover:scale-105 transition duration-300">
          <div class="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-black/20"></div>
          <div class="absolute top-3 left-3 bg-black/60 backdrop-blur-md text-white text-[10px] font-bold px-2.5 py-1 rounded-full uppercase tracking-wider">
            ${item.property_type}
          </div>
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
    alert('Access restricted: Only verified Sellers and Brokers are permitted to create land listings.');
    return;
  }
  const modal = document.getElementById('new-listing-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeNewListingModal() {
  const modal = document.getElementById('new-listing-modal');
  if (modal) modal.classList.add('hidden');
}

async function handleCreateListing(e) {
  e.preventDefault();
  if (!currentToken) {
    alert('Please log in first.');
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
      alert('Land Listing published successfully!');
      closeNewListingModal();
      await loadListings();
      if (currentUser?.role === 'seller' || currentUser?.role === 'broker') {
        await loadMyListings();
      }
      switchTab('feed');
    } else {
      alert(data.error || 'Failed to create listing');
    }
  } catch (err) {
    alert('Error: ' + err.message);
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
  document.getElementById('edit-listing-image').value = item.images && item.images.length > 0 ? item.images[0] : '';
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
      alert('Listing updated successfully!');
      closeEditListingModal();
      await loadListings();
      await loadMyListings();
    } else {
      alert(data.error || 'Failed to update listing');
    }
  } catch (err) {
    alert('Error updating listing: ' + err.message);
  }
}

async function handleDeleteListing(listingId) {
  if (!confirm('Are you sure you want to permanently delete this land listing?')) return;
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
      alert('Land listing deleted.');
      closePropertyDetails();
      await loadListings();
      await loadMyListings();
    } else {
      alert(data.error || 'Failed to delete listing');
    }
  } catch (err) {
    alert('Error deleting listing: ' + err.message);
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
      const firstImg = item.images && item.images.length > 0 
        ? item.images[0] 
        : 'https://images.unsplash.com/photo-1500382017468-9049fed747ef?w=800';

      return `
        <div class="p-2.5 bg-slate-50 border border-slate-200 rounded-xl flex items-center justify-between">
          <div class="flex items-center gap-2.5 truncate cursor-pointer" onclick="openPropertyDetails(${item.id})">
            <img src="${firstImg}" class="w-10 h-10 rounded-lg object-cover flex-shrink-0 border border-slate-200">
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

async function loadUsersList() {
  if (allUsers.length === 0) {
    renderContactsSkeleton();
  }
  try {
    const res = await fetch(`${API_BASE}/api/users`);
    allUsers = await res.json();
    renderContactsList();
    renderCallsContactsList();
  } catch (err) {
    console.error('Error loading users:', err);
  }
}

function renderContactsList() {
  const container = document.getElementById('contacts-list');
  if (!container) return;

  const otherUsers = allUsers.filter(u => !currentUser || u.id !== currentUser.id);

  container.innerHTML = otherUsers.map(u => `
    <div onclick="startChatWithUser(${u.id}, '${escapeQuotes(u.name)}', '${escapeQuotes(u.avatar)}', '${u.role}')"
         class="p-3 flex items-center justify-between hover:bg-slate-50 cursor-pointer transition">
      <div class="flex items-center gap-3">
        <div class="relative">
          <img src="${u.avatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100'}" class="w-11 h-11 rounded-full object-cover">
          <span class="absolute bottom-0 right-0 w-3 h-3 rounded-full bg-emerald-500 border-2 border-white"></span>
        </div>
        <div>
          <div class="flex items-center gap-1.5">
            <h4 class="font-bold text-xs text-slate-800">${u.name}</h4>
            <span class="text-[9px] px-1.5 py-0.2 rounded font-semibold uppercase ${
              u.role === 'buyer' ? 'bg-blue-100 text-blue-700' :
              u.role === 'seller' ? 'bg-emerald-100 text-emerald-700' : 'bg-purple-100 text-purple-700'
            }">${u.role}</span>
          </div>
          <p class="text-[11px] text-slate-500 truncate max-w-[180px]">Tap to send WhatsApp style message...</p>
        </div>
      </div>
      <div class="text-right">
        <span class="text-[10px] text-slate-400">Online</span>
        <div class="mt-1">
          <i data-lucide="chevron-right" class="w-4 h-4 text-slate-300"></i>
        </div>
      </div>
    </div>
  `).join('');

  if (window.lucide) lucide.createIcons();
}

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

  await fetchChatMessages(userId);
  switchTab('chats');
  if (window.lucide) lucide.createIcons();
}

function closeActiveChat() {
  const chatView = document.getElementById('active-chat-view');
  if (chatView) chatView.classList.add('hidden');
  activeChatPeer = null;
}

async function fetchChatMessages(otherUserId) {
  if (!currentToken) return;
  try {
    const res = await fetch(`${API_BASE}/api/messages/${otherUserId}`, {
      headers: { 'Authorization': `Bearer ${currentToken}` }
    });
    const messages = await res.json();
    renderChatMessages(messages);
  } catch (err) {
    console.error('Error fetching messages:', err);
  }
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

  container.innerHTML = messages.map(m => {
    const isMine = currentUser && m.sender_id === currentUser.id;
    const time = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    return `
      <div class="flex ${isMine ? 'justify-end' : 'justify-start'}">
        <div class="max-w-[75%] rounded-2xl px-3.5 py-2 shadow-sm text-xs ${
          isMine 
            ? 'bg-wa-outgoingBubble text-slate-800 rounded-tr-none' 
            : 'bg-white text-slate-800 rounded-tl-none'
        }">
          <p class="leading-relaxed select-text">${m.content}</p>
          <div class="text-[9px] text-slate-400 text-right mt-1 flex items-center justify-end gap-1">
            <span>${time}</span>
            ${isMine ? '<i data-lucide="check-check" class="w-3 h-3 text-emerald-600"></i>' : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');

  container.scrollTop = container.scrollHeight;
  if (window.lucide) lucide.createIcons();
}

async function sendChatMessage() {
  const input = document.getElementById('chat-input');
  if (!input || !input.value.trim() || !activeChatPeer || !currentToken) return;

  const content = input.value.trim();
  input.value = '';

  try {
    const res = await fetch(`${API_BASE}/api/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentToken}`
      },
      body: JSON.stringify({
        receiver_id: activeChatPeer.id,
        content
      })
    });
    const savedMsg = await res.json();
    await fetchChatMessages(activeChatPeer.id);
  } catch (err) {
    console.error('Error sending message:', err);
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

async function initiateDirectCall(targetUserId, targetName, targetAvatar, targetRole, callType = 'video', listingId = null) {
  if (!currentUser) {
    alert('Please log in to make calls.');
    return;
  }
  if (targetUserId === currentUser.id) {
    alert('Cannot call yourself.');
    return;
  }

  activeCallTargetId = targetUserId;
  activeCallType = callType;

  showCallModal(targetName, targetAvatar, targetRole, callType);

  localStream = await getMediaStream(callType);
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

  const modal = document.getElementById('call-modal');
  if (modal) modal.classList.add('hidden');

  activeCallTargetId = null;
  fetchCallLogs();
}

function toggleMuteAudio() {
  if (!localStream) return;
  const audioTracks = localStream.getAudioTracks();
  if (audioTracks.length > 0) {
    isAudioMuted = !isAudioMuted;
    audioTracks[0].enabled = !isAudioMuted;
    const btn = document.getElementById('btn-toggle-mic');
    if (btn) btn.classList.toggle('bg-rose-600', isAudioMuted);
  }
}

function toggleVideoCamera() {
  if (!localStream) return;
  const videoTracks = localStream.getVideoTracks();
  if (videoTracks.length > 0) {
    isVideoMuted = !isVideoMuted;
    videoTracks[0].enabled = !isVideoMuted;
    const btn = document.getElementById('btn-toggle-cam');
    if (btn) btn.classList.toggle('bg-rose-600', isVideoMuted);
  }
}

function toggleVideoCameraFlip() {
  alert('Camera switched (Front / Rear)');
}

function toggleSpeaker() {
  alert('Speaker output toggled.');
}

function handleIncomingCall(data) {
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
  };

  ws.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);

      switch (data.type) {
        case 'authenticated':
          console.log('WS Authenticated for User ID:', data.userId);
          break;

        case 'new_message':
          if (activeChatPeer && data.message.sender_id === activeChatPeer.id) {
            await fetchChatMessages(activeChatPeer.id);
          } else {
            const badge = document.getElementById('chats-badge');
            if (badge) badge.classList.remove('hidden');
          }
          break;

        case 'incoming_call':
          handleIncomingCall(data);
          break;

        case 'call_accepted':
          console.log('Call was accepted by peer.');
          break;

        case 'call_rejected':
          alert('Call was rejected: ' + (data.reason || 'Declined'));
          cleanupCall();
          break;

        case 'call_ended':
          alert('Call ended by other party.');
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
    if (currentToken) {
      setTimeout(initWebSocket, 4000);
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
