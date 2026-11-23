# LandConnect – Technical Documentation

**Candidate:** Mohit Sharma  
**Target Platform:** Mobile-First Real Estate Marketplace & Audio/Video Communication Platform  
**Target Evaluation:** Team LandConnect (`Connect@landconnect.si`, phone: `+91 9538649279`)

---

## 1. Technologies and Frameworks Used

| Layer / Subsystem | Technology | Purpose & Implementation Details |
|---|---|---|
| **Mobile Frontend** | HTML5, Tailwind CSS, Lucide Icons | WhatsApp-inspired mobile viewport, responsive CSS styling, tab navigation (`LAND FEED`, `CHATS`, `CALLS`, `MAP`, `ROLE`), bottom sheets, and skeleton shimmer loading animations. |
| **Real-Time Calling** | WebRTC (`RTCPeerConnection`), WebSocket | Peer-to-peer audio and video communication, ICE candidate exchange, media stream negotiation, microphone mute, camera toggle, screen sharing. |
| **Real-Time Event Bus**| Full-Duplex WebSockets (`Starlette WebSocket`) | Live pub/sub broadcast for new land listings, listing updates/deletions, presence indicators, typing indicators, read receipts, and incoming call signaling. |
| **Performance & Caching**| Multi-Tier Caching (`localStorage` + Memory + PostgreSQL Indexes) | 0ms cold-start chat rendering from local storage, in-memory backend cache for messages and conversations, dropping query latency from ~1000ms down to sub-4ms. |
| **Audio Voice Notes** | `MediaRecorder` API, Web Audio API | In-chat WhatsApp-style voice messaging with live recording timer, custom waveform visualization, and inline audio playback. |
| **Maps & Geolocation** | OpenStreetMap, Leaflet.js, HTML5 Geolocation API | Geotagged land parcel explorer, one-tap high-precision GPS auto-detection (±5m), regional hub presets, interactive map pin picker modal. |
| **Backend REST & WS** | Python 3, Starlette, Uvicorn (ASGI) | High-concurrency asynchronous API server handling auth, listings CRUD, messaging, call signaling, and static file serving. |
| **Database Persistence** | Neon Serverless PostgreSQL (`psycopg2` / SSL) | Cloud PostgreSQL with pooled connection management, relational schemas (`users`, `listings`, `messages`, `call_logs`, `blocked_users`, `reports`), and compound indexes. |
| **Cloud Object Storage**| Neon Object Storage (`uploads` bucket), AWS S3 SDK (`boto3`) | Multi-tenant cloud bucket storage for high-resolution land photographs, automatic URL generation, and fallback local bucket storage. |
| **Authentication & RBAC**| JSON Web Tokens (JWT `HS256`), PBKDF2-HMAC-SHA256 (100k rounds) | Stateless bearer token authentication, phone number privacy masking (`+91 98*** **321`), role-based endpoint authorization, XSS & path traversal hardening. |

---

## 2. Application Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                        CLIENT APPLICATION                              │
│              (Mobile Browser / PWA / Android WebView)                 │
│                                                                        │
│  ┌─────────────────────────┐           ┌────────────────────────────┐  │
│  │ WhatsApp Mobile UI      │           │ WebRTC Calling Engine      │  │
│  │ - Land Feed & Filters   │           │ - Local & Remote Streams   │  │
│  │ - Real-Time Chat & Voice│           │ - Mic / Cam / Screen Share │  │
│  │ - Map Pin Geotagging    │           │ - Synthesized Ringtone FX  │  │
│  │ - Land & EMI Calculator │           │ - Call Teardown Lifecycle  │  │
│  └───────────┬─────────────┘           └────────────▲───────────────┘  │
└──────────────┼──────────────────────────────────────┼──────────────────┘
               │ HTTPS (REST)                         │ WSS (Signaling & Broadcast)
┌──────────────▼──────────────────────────────────────▼──────────────────┐
│                     LANDCONNECT BACKEND (ASGI)                         │
│                                                                        │
│  ┌───────────────────────────┐         ┌────────────────────────────┐  │
│  │ REST API Endpoints        │         │ Real-Time WebSocket Engine │  │
│  │ - /api/auth (Login/Reg)   │         │ - Listing Broadcast Bus    │  │
│  │ - /api/listings (CRUD)    │         │ - WebRTC Call Signaling    │  │
│  │ - /api/messages (Chat)    │         │ - Chat Message Dispatch    │  │
│  │ - /api/blocks & /reports  │         │ - Typing & Presence Sync   │  │
│  │ - /api/upload (S3 Bucket) │         │ - TempId Deduplication     │  │
│  └─────────────┬─────────────┘         └────────────────────────────┘  │
└────────────────┼───────────────────────────────────────────────────────┘
                 │
       ┌─────────┴────────────────────────┐
       │                                  │
┌──────▼──────────────────────┐   ┌───────▼──────────────────────────────┐
│ Neon Serverless PostgreSQL  │   │ Neon Object Storage (`uploads`)      │
│ - Users, Roles & Passwords  │   │ - S3-Compatible Cloud Bucket         │
│ - Geotagged Land Parcels    │   │ - Persistent Land Photography        │
│ - Compound B-tree Indexes   │   │ - Public CDN Image Distribution      │
│ - Blocked & Reported Users  │   │                                      │
└─────────────────────────────┘   └──────────────────────────────────────┘
```

### Data Models & Schemas
1. **`users`**: `id`, `name`, `email`, `password_hash`, `role` (`buyer`, `seller`, `broker`), `phone_masked`, `avatar`, `bio`, `created_at`.
2. **`listings`**: `id`, `owner_id`, `title`, `description`, `property_type`, `price`, `price_unit`, `area_sqft`, `location_address`, `city`, `state`, `latitude`, `longitude`, `images` (JSON array), `features` (JSON array), `created_at`.
3. **`messages`**: `id`, `sender_id`, `receiver_id`, `listing_id`, `content`, `message_type` (`text`, `voice_note`, `property_inquiry`), `is_read`, `created_at`.
   - *Indexes:* `idx_messages_sender_receiver (sender_id, receiver_id)`, `idx_messages_receiver_sender (receiver_id, sender_id)`, `idx_messages_created (created_at)`.
4. **`call_logs`**: `id`, `caller_id`, `receiver_id`, `call_type` (`audio`, `video`), `duration_seconds`, `status` (`completed`, `missed`, `declined`), `created_at`.
5. **`blocked_users`**: `id`, `blocker_id`, `blocked_id`, `created_at`.
6. **`reports`**: `id`, `reporter_id`, `reported_user_id`, `listing_id`, `reason`, `details`, `created_at`.

---

## 3. Key Implementation Decisions

### A. Real-Time Listing Broadcast Over WebSockets
- **The Problem:** In conventional listing portals, buyers must repeatedly reload the page to see newly posted or edited properties.
- **Decision:** Integrated full-duplex WebSocket broadcasting (`broadcast_all`). Whenever an authenticated seller or broker posts (`POST /api/listings`), edits (`PUT /api/listings/{id}`), or deletes a plot (`DELETE /api/listings/{id}`), the complete serialized parcel record is published over the WebSocket bus. Connected clients update their local listing collection, prepend the new card to the feed, refresh the interactive map, and alert the user with a discreet in-app notification.

### B. Multi-Tier Chat Performance Optimization (<4ms Latency)
- **The Problem:** Querying cloud database instances (Neon DB in AWS eu-central/us-east) across geographic network hops can cause 800ms–1200ms latency on every conversation switch.
- **Decision:** Built a multi-tier caching architecture:
  1. **Client Cold-Start Cache:** Browser `localStorage` caches `allUsers` and `recentConversations`, rendering contacts instantly at 0ms.
  2. **Server-Side In-Memory Cache:** `server_messages_cache` stores active threads in memory, enabling instant responses on `GET /api/messages/{user_id}` and `GET /api/conversations`.
  3. **Compound PostgreSQL Indexes:** Added compound B-tree indexes on `(sender_id, receiver_id)` and `(receiver_id, sender_id)`.
  4. **Asynchronous Read Receipts:** Handled read-receipt database transactions asynchronously via background tasks so they do not block chat rendering.

### C. Zero Phone-Number Leakage in Communications
- **The Problem:** In traditional real estate platforms, exposing phone numbers leads to harassment, off-platform disintermediation, and spam.
- **Decision:** All discovery, messaging, and audio/video calling operate strictly through application-level user IDs. Phone numbers are stored securely and masked everywhere in the UI and API payload (`+91 98*** **321`).

### D. Direct-to-Cloud Object Storage for Land Photography
- **The Problem:** Base64 image storage in databases degrades performance, and local disk storage causes data loss in containerized deployments.
- **Decision:** Integrated **Neon Object Storage** (`uploads` bucket) via S3-compatible path-style addressing (`boto3`). Uploads are assigned unique UUIDs and served over high-speed HTTPS endpoints, with automatic fallback to persistent local bucket storage.

### E. WebRTC Peer-to-Peer Calling with Synthesized Ringing
- **The Problem:** Buyers and sellers need direct voice and face-to-face inspection without installing external apps (like Zoom or Google Meet).
- **Decision:** Implemented native WebRTC peer-to-peer video/audio connections negotiated via our WebSocket signaling server. To replicate the authentic phone calling feel without heavy external MP3 assets, an oscillator-based Web Audio synthesizer creates authentic ringing feedback and incoming chimes.

### F. Contact Safety & Moderation (Block, Report, Clear Chat)
- **The Problem:** Real estate deal rooms require immediate tools to stop spam or abusive inquiries without breaking active conversations.
- **Decision:** Implemented dedicated endpoints (`/api/blocks`, `/api/reports`, `/api/messages/clear/{peer_id}`) paired with an in-memory blocked-user set. When a user is blocked, message delivery and call requests are instantly halted at both the HTTP and WebSocket layers, and contact headers update reactively.

---

## 4. Major Technical Challenges Encountered & Resolutions

| Challenge | Impact | Engineering Resolution |
|---|---|---|
| **Real-Time Feed Desynchronization** | Sellers saw their new listings immediately, but buyers had to refresh the page to see them. | Built `broadcast_all(message)` in `backend/server.py` and implemented `new_listing`, `listing_updated`, and `listing_deleted` handlers in `frontend/app.js` to reactively update feed and Leaflet map markers. |
| **Neon Cloud Query Latency on Chat Switch** | Switching between conversation threads took 800ms–1000ms due to cloud database round-trips and unindexed message lookups. | Added compound PostgreSQL B-tree indexes, created a server-side LRU in-memory message cache, and hydrated the client-side state from `localStorage` for sub-4ms response times. |
| **Rapid Double-Click Duplicate Messages** | Users rapidly tapping "Send" could generate duplicated messages in chat threads. | Implemented client-side `tempId` tagging and a server-side 60-second in-memory deduplication window (`is_duplicate_temp_id`). |
| **Neon Object Storage Addressing Mode** | Initial S3 uploads received `404 NoSuchBucket` errors due to default virtual-hosted bucket naming (`bucket.endpoint`). | Configured `botocore.client.Config(s3={'addressing_style': 'path'})` in `server.py` to match Neon Object Storage path-style routing. |
| **Authentication Screen Flicker on Page Refresh** | Browser initial render momentarily flashed the Login form before JavaScript read `localStorage` token. | Injected an inline head script that applies `.user-has-session` before DOM rendering, hiding the login screen instantly without visual flicker. |
| **WebRTC Media Permissions in Sandbox** | Browser media devices could fail gracefully if camera/microphone access is denied or unavailable on headless hosts. | Implemented thorough try/catch exception handlers with visual status indicators, allowing audio-only fallback mode and screen-sharing options. |

---

## 5. Execution Instructions

### Quick Start
```bash
# 1. Clone repository
git clone https://github.com/Mohitsharma1214/LandConnect.git
cd LandConnect

# 2. Install dependencies
pip install -r requirements.txt

# 3. Run backend server
python3 -m uvicorn backend.server:app --host 0.0.0.0 --port 8000 --reload
```
Open **`http://localhost:8000`** in any web browser or mobile browser emulator.
