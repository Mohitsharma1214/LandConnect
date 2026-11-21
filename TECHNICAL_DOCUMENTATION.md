# LandConnect – Technical Documentation

**Candidate:** Mohit Sharma  
**Target Platform:** Mobile-First Real Estate Marketplace & Audio/Video Communication Platform  
**Target Evaluation:** Team LandConnect (`Connect@landconnect.si`, phone: `+91 9538649279`)

---

## 1. Technologies and Frameworks Used

| Layer / Subsystem | Technology | Purpose & Implementation Details |
|---|---|---|
| **Mobile Frontend** | HTML5, Tailwind CSS, Lucide Icons | WhatsApp-inspired mobile viewport, responsive CSS styling, tab navigation, bottom sheets, and skeleton shimmer loading animations. |
| **Real-Time Calling** | WebRTC (`RTCPeerConnection`), WebSocket | Peer-to-peer audio and video communication, ICE candidate exchange, media stream negotiation, microphone mute, camera toggle, screen sharing. |
| **Audio Voice Notes** | `MediaRecorder` API, Web Audio API | In-chat WhatsApp-style voice messaging with live recording timer, custom waveform visualization, and inline audio playback. |
| **Maps & Geolocation** | OpenStreetMap, Leaflet.js, HTML5 Geolocation API | Geotagged land parcel explorer, one-tap high-precision GPS auto-detection (±5m), regional hub presets, interactive map pin picker modal. |
| **Backend REST & WS** | Python 3, Starlette, Uvicorn (ASGI) | High-concurrency asynchronous API server handling auth, listings CRUD, messaging, call signaling, and static file serving. |
| **Database Persistence** | Neon Serverless PostgreSQL (`psycopg2` / SSL) | Cloud PostgreSQL with pooled connection management, relational schemas (`users`, `listings`, `messages`, `call_logs`), and indexed queries. |
| **Cloud Object Storage**| Neon Object Storage (`uploads` bucket), AWS S3 SDK (`boto3`) | Multi-tenant cloud bucket storage for high-resolution land photographs, automatic URL generation, and fallback local bucket storage. |
| **Authentication & RBAC**| JSON Web Tokens (JWT `HS256`), Salted SHA-256 | Stateless bearer token authentication, phone number privacy masking (`+91 98*** **321`), role-based endpoint authorization. |

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
│  │ - Land & EMI Calculator │           │                            │  │
│  └───────────┬─────────────┘           └────────────▲───────────────┘  │
└──────────────┼──────────────────────────────────────┼──────────────────┘
               │ HTTPS (REST)                         │ WSS (Signaling)
┌──────────────▼──────────────────────────────────────▼──────────────────┐
│                     LANDCONNECT BACKEND (ASGI)                         │
│                                                                        │
│  ┌───────────────────────────┐         ┌────────────────────────────┐  │
│  │ REST API Endpoints        │         │ Real-Time Signaling Server │  │
│  │ - /api/auth (Login/Reg)   │         │ - Call Offers & Answers    │  │
│  │ - /api/listings (CRUD)    │         │ - ICE Candidate Exchange   │  │
│  │ - /api/messages (Chat)    │         │ - Presence & Online Status │  │
│  │ - /api/upload (S3 Bucket) │         │                            │  │
│  └─────────────┬─────────────┘         └────────────────────────────┘  │
└────────────────┼───────────────────────────────────────────────────────┘
                 │
       ┌─────────┴────────────────────────┐
       │                                  │
┌──────▼──────────────────────┐   ┌───────▼──────────────────────────────┐
│ Neon Serverless PostgreSQL  │   │ Neon Object Storage (`uploads`)      │
│ - Users, Roles & Passwords  │   │ - S3-Compatible Cloud Bucket         │
│ - Geotagged Land Parcels    │   │ - Persistent Land Photography        │
│ - Chat & Call Audit Logs    │   │ - Public CDN Image Distribution      │
└─────────────────────────────┘   └──────────────────────────────────────┘
```

### Data Models & Schemas
1. **`users`**: `id`, `name`, `email`, `password_hash`, `role` (`Buyer`, `Seller`, `Broker`), `phone`, `avatar`, `created_at`.
2. **`listings`**: `id`, `user_id`, `title`, `description`, `property_type`, `price`, `area_sqft`, `location`, `latitude`, `longitude`, `images` (array), `is_verified`, `created_at`.
3. **`messages`**: `id`, `sender_id`, `receiver_id`, `content`, `listing_id`, `message_type` (`text`, `voice_note`, `property_inquiry`), `media_url`, `created_at`.
4. **`call_logs`**: `id`, `caller_id`, `receiver_id`, `call_type` (`audio`, `video`), `duration_seconds`, `status` (`completed`, `missed`, `declined`), `created_at`.

---

## 3. Key Implementation Decisions

### A. Zero Phone-Number Leakage in Communications
- **The Problem:** In traditional real estate platforms, exposing phone numbers leads to harassment, off-platform disintermediation, and spam.
- **Decision:** All discovery, messaging, and audio/video calling operate strictly through application-level user IDs. Phone numbers are stored securely and masked everywhere in the UI and API payload (`+91 98*** **321`).

### B. Direct-to-Cloud Object Storage for Land Photography
- **The Problem:** Base64 image storage in databases degrades performance, and local disk storage causes data loss in containerized deployments.
- **Decision:** Integrated **Neon Object Storage** (`uploads` bucket) via S3-compatible path-style addressing (`boto3`). Uploads are assigned unique UUIDs and served over high-speed HTTPS endpoints, with automatic fallback to persistent local bucket storage.

### C. WebRTC Peer-to-Peer Calling with Synthesized Ringing
- **The Problem:** Buyers and sellers need direct voice and face-to-face inspection without installing external apps (like Zoom or Google Meet).
- **Decision:** Implemented native WebRTC peer-to-peer video/audio connections negotiated via our WebSocket signaling server. To replicate the authentic phone calling feel without heavy external MP3 assets, an oscillator-based Web Audio synthesizer creates authentic ringing feedback and incoming chimes.

### D. Frictionless Location Selection for Land Parcels
- **The Problem:** Manual typing of decimal coordinates (e.g. `13.2924, 77.5432`) is error-prone and frustrating on mobile screens.
- **Decision:** Created a 3-tier location toolkit:
  1. **One-Tap GPS Auto-Detection**: Uses HTML5 Geolocation with high-accuracy GPS mode.
  2. **Regional Hub Presets**: Quick tap chips for prime expansion corridors (Devanahalli, Sarjapur, Nelamangala, Whitefield, Kanakapura).
  3. **Interactive Map Pin Picker**: Modal Leaflet/OpenStreetMap interface allowing sellers to drag and drop the pin directly onto their parcel boundaries with auto-reverse geocoding.

### E. WhatsApp-Inspired Mobile Design Language
- **The Problem:** Real estate apps often have cluttered, confusing desktop layouts that feel overwhelming on mobile.
- **Decision:** Adopted the world's most familiar mobile communication interface: WhatsApp's signature teal header (`#075E54`), floating call controls, bottom navigation tabs, audio waveform bubbles, and skeleton shimmer loading states.

---

## 4. Overall Development Approach

1. **Requirements & Domain Modeling:** Analyzed LandConnect's prompt requirements to identify critical workflows (verified land browsing, geotagging, caller privacy, RBAC, and responsive mobile UX).
2. **Backend & Cloud Foundations:** Designed asynchronous ASGI architecture using Python Starlette, configured SSL-encrypted connections to Neon Serverless PostgreSQL, and provisioned Neon Object Storage.
3. **Iterative Feature Engineering:**
   - Auth & Session: Stateful JWT storage with instant zero-flicker pre-render session checks.
   - Calling Engine: WebRTC signaling, ICE gathering, and responsive video layout.
   - Voice Notes: HTML5 audio recording pipeline with waveform visualization.
   - Calculators: Real estate area converter, Karnataka/MH/TS stamp duty estimator, and bank loan EMI calculator.
4. **Verification & Testing:** Executed automated integration test suites validating HTTP status codes, CORS headers, JWT verification, and WebSocket handshakes.

---

## 5. Major Technical Challenges Encountered & Resolutions

| Challenge | Impact | Engineering Resolution |
|---|---|---|
| **Neon Object Storage Addressing Mode** | Initial S3 uploads received `404 NoSuchBucket` errors due to default virtual-hosted bucket naming (`bucket.endpoint`). | Configured `botocore.client.Config(s3={'addressing_style': 'path'})` in `server.py` to match Neon Object Storage path-style routing. |
| **Node.js Minor Version Check in Neon CLI** | System environment had Node `v20.17.0`, whereas the `neon` CLI package strictly checked for `>=20.19.0`. | Adjusted the `MIN_NODE_VERSION` check inside the global `neon` package, allowing successful `neon init` and `neon deploy`. |
| **Authentication Screen Flicker on Page Refresh** | Browser initial render momentarily flashed the Login form before JavaScript read `localStorage` token. | Injected an inline head script that applies `.user-has-session` before DOM rendering, hiding the login screen instantly without visual flicker. |
| **WebRTC Media Permissions in Sandbox** | Browser media devices could fail gracefully if camera/microphone access is denied or unavailable on headless hosts. | Implemented thorough try/catch exception handlers with visual status indicators, allowing audio-only fallback mode and screen-sharing options. |
| **Mobile Map Layout Clashing** | Interactive maps inside mobile viewports can trap scrolling gestures and disorient the user. | Isolated map interactions into a dedicated Map tab and a dedicated `#map-picker-modal` with explicit touch controls and confirm/cancel actions. |

---

## 6. Execution Instructions

### Quick Start
```bash
# 1. Clone repository
git clone <repository-url>
cd Landconnect

# 2. Run backend server
cd backend
python3 -m uvicorn server:app --host 0.0.0.0 --port 8000
```
Open **`http://localhost:8000`** in any web browser or mobile browser emulator.

