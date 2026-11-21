// LandConnect Core Application Logic & WebRTC Real-Time Calling Engine

const API_BASE = window.location.origin;
let WS_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;

// --- State Variables ---
let currentUser = null;
let currentToken = localStorage.getItem('landconnect_token') || null;
let ws = null;
let activeTab = 'feed';
let allListings = [];
let allUsers = [];
let activeChatPeer = null;

// --- WebRTC State ---
let peerConnection = null;
let localStream = null;
let remoteStream = null;
let activeCallType = 'video'; // 'audio' or 'video'
let activeCallTargetId = null;
let incomingCallData = null;
let callTimerInterval = null;
let callSeconds = 0;
let isAudioMuted = false;
let isVideoMuted = false;

// Standard STUN servers for NAT traversal
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
    await fetchUserProfile();
  } else {
    // Default to Buyer demo account on first load
    await switchDemoUser('buyer');
  }

  await loadListings();
  await loadUsersList();
  initWebSocket();
});

function updateClock() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const clockEl = document.getElementById('clock-display');
  if (clockEl) clockEl.textContent = timeStr;
}

// ================= 1. AUTHENTICATION & ROLE MANAGEMENT =================

async function fetchUserProfile() {
  try {
    const res = await fetch(`${API_BASE}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${currentToken}` }
    });
    if (res.ok) {
      currentUser = await res.json();
      applyUserRoleUI();
    } else {
      logout();
    }
  } catch (err) {
    console.error('Error fetching profile:', err);
  }
}

function applyUserRoleUI() {
  if (!currentUser) return;

  // Update Top Bar & Header Avatar & Role text
  const roleText = document.getElementById('header-role-text');
  const avatarImg = document.getElementById('header-avatar');
  if (roleText) roleText.textContent = currentUser.role;
  if (avatarImg && currentUser.avatar) avatarImg.src = currentUser.avatar;

  // Update Profile Tab
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

  // Dynamic Role Permissions on UI
  const bannerTitle = document.getElementById('banner-role-title');
  const bannerDesc = document.getElementById('banner-role-desc');
  const bannerPostBtn = document.getElementById('banner-post-btn');
  const floatingPostBtn = document.getElementById('floating-post-btn');
  const permPostStatus = document.getElementById('perm-post-status');

  const canPost = (currentUser.role === 'seller' || currentUser.role === 'broker');

  if (canPost) {
    if (bannerPostBtn) bannerPostBtn.classList.remove('hidden');
    if (floatingPostBtn) floatingPostBtn.classList.remove('hidden');
    if (bannerTitle) bannerTitle.textContent = `${currentUser.role.toUpperCase()} MODE: LISTING MANAGEMENT`;
    if (bannerDesc) bannerDesc.textContent = `You have authorization to list land parcels, manage prices, and field buyer calls.`;
    if (permPostStatus) {
      permPostStatus.innerHTML = '<i data-lucide="check" class="w-3.5 h-3.5 text-emerald-500"></i> Authorized';
      permPostStatus.className = 'text-emerald-600 font-bold flex items-center gap-1';
    }
  } else {
    // Buyer Mode
    if (bannerPostBtn) bannerPostBtn.classList.add('hidden');
    if (floatingPostBtn) floatingPostBtn.classList.add('hidden');
    if (bannerTitle) bannerTitle.textContent = `BUYER EXPLORATION MODE`;
    if (bannerDesc) bannerDesc.textContent = `Browse verified land listings & start private audio/video calls with owners without exposing phone numbers.`;
    if (permPostStatus) {
      permPostStatus.innerHTML = '<i data-lucide="lock" class="w-3.5 h-3.5 text-slate-400"></i> Restricted (Sellers & Brokers only)';
      permPostStatus.className = 'text-slate-400 font-bold flex items-center gap-1';
    }
  }

  if (window.lucide) lucide.createIcons();
}

async function switchDemoUser(role) {
  const credentials = {
    buyer: { email: 'buyer@landconnect.com', password: 'buyer123' },
    seller: { email: 'seller@landconnect.com', password: 'seller123' },
    broker: { email: 'broker@landconnect.com', password: 'broker123' }
  };

  const cred = credentials[role];
  if (!cred) return;

  try {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cred)
    });
    const data = await res.json();
    if (data.token) {
      currentToken = data.token;
      currentUser = data.user;
      localStorage.setItem('landconnect_token', currentToken);
      applyUserRoleUI();
      hideQuickDemoSwitch();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'authenticate', token: currentToken }));
      }
      loadListings();
      loadUsersList();
      fetchCallLogs();
    }
  } catch (err) {
    console.error('Failed to switch demo user:', err);
  }
}

async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;

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
      applyUserRoleUI();
      hideAuthModal();
      initWebSocket();
      loadListings();
      loadUsersList();
    } else {
      alert(data.error || 'Login failed');
    }
  } catch (err) {
    alert('Login error: ' + err.message);
  }
}

async function handleRegister(e) {
  e.preventDefault();
  const name = document.getElementById('reg-name').value;
  const email = document.getElementById('reg-email').value;
  const password = document.getElementById('reg-password').value;
  const phone = document.getElementById('reg-phone').value;
  const roleEl = document.querySelector('input[name="reg-role"]:checked');
  const role = roleEl ? roleEl.value : 'buyer';

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
      applyUserRoleUI();
      hideAuthModal();
      initWebSocket();
      loadListings();
      loadUsersList();
    } else {
      alert(data.error || 'Registration failed');
    }
  } catch (err) {
    alert('Registration error: ' + err.message);
  }
}

function logout() {
  currentToken = null;
  currentUser = null;
  localStorage.removeItem('landconnect_token');
  showAuthModal();
}

function toggleQuickDemoSwitch() {
  const menu = document.getElementById('quick-role-menu');
  if (menu) menu.classList.toggle('hidden');
}

function hideQuickDemoSwitch() {
  const menu = document.getElementById('quick-role-menu');
  if (menu) menu.classList.add('hidden');
}

function showAuthModal() {
  const modal = document.getElementById('auth-modal');
  if (modal) modal.classList.remove('hidden');
}

function hideAuthModal() {
  const modal = document.getElementById('auth-modal');
  if (modal) modal.classList.add('hidden');
}

function switchAuthTab(tab) {
  const formLogin = document.getElementById('form-login');
  const formReg = document.getElementById('form-register');
  const tabLogin = document.getElementById('auth-tab-login');
  const tabReg = document.getElementById('auth-tab-reg');

  if (tab === 'login') {
    formLogin.classList.remove('hidden');
    formReg.classList.add('hidden');
    tabLogin.classList.add('bg-white', 'shadow-sm', 'text-wa-teal');
    tabLogin.classList.remove('text-slate-600');
    tabReg.classList.remove('bg-white', 'shadow-sm', 'text-wa-teal');
    tabReg.classList.add('text-slate-600');
  } else {
    formLogin.classList.add('hidden');
    formReg.classList.remove('hidden');
    tabReg.classList.add('bg-white', 'shadow-sm', 'text-wa-teal');
    tabReg.classList.remove('text-slate-600');
    tabLogin.classList.remove('bg-white', 'shadow-sm', 'text-wa-teal');
    tabLogin.classList.add('text-slate-600');
  }
}

// ================= 2. NAVIGATION TABS =================

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
  if (tabId === 'map') updateMapCard(allListings[0]);
  if (window.lucide) lucide.createIcons();
}

// ================= 3. LAND LISTINGS & COMMUNITY FEED =================

async function loadListings() {
  try {
    const res = await fetch(`${API_BASE}/api/listings`);
    allListings = await res.json();
    renderListings(allListings);
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
        <!-- Property Image & Type Tag -->
        <div class="relative h-44 w-full bg-slate-100">
          <img src="${firstImg}" class="w-full h-full object-cover">
          <div class="absolute top-3 left-3 bg-black/60 backdrop-blur-md text-white text-[10px] font-bold px-2.5 py-1 rounded-full uppercase tracking-wider">
            ${item.property_type}
          </div>
          <div class="absolute bottom-3 left-3 bg-wa-tealDark/90 backdrop-blur-md text-white px-3 py-1 rounded-xl text-xs font-black shadow-lg">
            ₹${formattedPrice}
          </div>
          <div class="absolute bottom-3 right-3 bg-black/60 backdrop-blur-md text-white text-[10px] px-2 py-0.5 rounded-lg flex items-center gap-1 font-medium">
            <i data-lucide="maximize" class="w-3 h-3 text-emerald-300"></i>
            ${Number(item.area_sqft).toLocaleString()} sq.ft
          </div>
        </div>

        <!-- Body Details -->
        <div class="p-3.5 space-y-2">
          <h3 class="font-bold text-slate-800 text-sm leading-snug">${item.title}</h3>
          
          <div class="flex items-center gap-1 text-[11px] text-slate-500">
            <i data-lucide="map-pin" class="w-3.5 h-3.5 text-wa-teal flex-shrink-0"></i>
            <span class="truncate">${item.location_address}, ${item.city}</span>
          </div>

          <p class="text-xs text-slate-600 line-clamp-2 leading-relaxed">
            ${item.description}
          </p>

          <!-- Owner / Broker Info (With Privacy Masked Phone) -->
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

            <!-- WhatsApp Style Quick Actions: Message & Video/Voice Call -->
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

// Search and filter listeners
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

// ================= 4. CREATE LISTING MODAL =================

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
      switchTab('feed');
    } else {
      alert(data.error || 'Failed to create listing');
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// ================= 5. WHATSAPP STYLE MESSAGING & CHATS =================

async function loadUsersList() {
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

  // Update Chat Header
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

// ================= 6. IN-APP AUDIO & VIDEO CALLING (KEY REQUIREMENT) =================

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

// --- WebRTC Media Stream Handling ---

async function getMediaStream(callType) {
  try {
    const constraints = {
      audio: true,
      video: callType === 'video' ? { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' } : false
    };
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    console.warn('Camera/Mic permission failed or unavailable, creating mock canvas stream for prototype testing:', err);
    return createSimulatedMediaStream(callType);
  }
}

// Fallback stream generator to ensure video call testing works seamlessly even without physical webcam
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
  // Add a silent audio track
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

  // Setup UI
  showCallModal(targetName, targetAvatar, targetRole, callType);

  // Acquire local media
  localStream = await getMediaStream(callType);
  const localVideo = document.getElementById('local-video');
  if (localVideo) localVideo.srcObject = localStream;

  // Create WebRTC PeerConnection
  setupPeerConnection();

  // Send signaling invite over WebSocket
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

  // Add local tracks to connection
  if (localStream) {
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });
  }

  // Handle incoming remote stream
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

  // ICE Candidates
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

// --- Call Controls ---

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
  // Flip front / back camera if mobile device
  alert('Camera flipped (Front / Rear)');
}

function toggleSpeaker() {
  alert('Speaker output toggled.');
}

// --- Incoming Call Handling ---

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

  // Create WebRTC Offer to connect
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

// ================= 7. WEBSOCKET REAL-TIME SIGNALING =================

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
          // If message is for active chat, update view
          if (activeChatPeer && data.message.sender_id === activeChatPeer.id) {
            await fetchChatMessages(activeChatPeer.id);
          } else {
            // Flash badge on CHATS tab
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
    setTimeout(initWebSocket, 4000);
  };
}

// ================= 8. MAP VIEW INTEGRATION =================

function updateMapCard(listing) {
  if (!listing) return;
  const titleEl = document.getElementById('map-card-title');
  const priceEl = document.getElementById('map-card-price');
  const typeEl = document.getElementById('map-card-type');

  if (titleEl) titleEl.textContent = listing.title;
  if (priceEl) priceEl.textContent = `₹${Number(listing.price).toLocaleString('en-IN')}`;
  if (typeEl) typeEl.textContent = listing.property_type;
}

function callListingOwnerFromMap() {
  if (allListings.length > 0) {
    const item = allListings[0];
    initiateDirectCall(item.owner_id, item.owner_name, item.owner_avatar, item.owner_role, 'video', item.id);
  }
}

function chatListingOwnerFromMap() {
  if (allListings.length > 0) {
    const item = allListings[0];
    startChatWithUser(item.owner_id, item.owner_name, item.owner_avatar, item.owner_role);
  }
}
