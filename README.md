# LandConnect – Real Estate Land Marketplace & In-App Calling Platform

[![WhatsApp UI](https://img.shields.io/badge/UI-WhatsApp%20Mobile%20Style-075E54?style=flat&logo=whatsapp)](https://whatsapp.com)
[![WebRTC Calling](https://img.shields.io/badge/Calling-WebRTC%20P2P%20Video%20%26%20Audio-25D366?style=flat)](https://webrtc.org)
[![Neon Database](https://img.shields.io/badge/Database-Neon%20Serverless%20PostgreSQL-00E599?style=flat)](https://neon.tech)
[![Neon Storage](https://img.shields.io/badge/Storage-Neon%20Object%20Storage-00E599?style=flat)](https://neon.tech)
[![FastAPI ASGI](https://img.shields.io/badge/Backend-Starlette%20%2F%20Uvicorn%20ASGI-009688?style=flat)](https://www.starlette.io/)

A complete, production-grade prototype of a mobile-first real estate land marketplace application featuring an authentic **WhatsApp-inspired user interface**, **peer-to-peer audio and video calling (WebRTC)**, **cloud-backed parcel image uploads via Neon Object Storage**, and **zero personal phone number leakage**.

---

## 📋 Table of Contents
1. [Submission Deliverables Checklist](#-submission-deliverables-checklist)
2. [Key Features](#-key-features)
3. [System Architecture](#-system-architecture)
4. [Tech Stack](#-tech-stack)
5. [Quick Start & Setup Instructions](#-quick-start--setup-instructions)
6. [Testing Personas & RBAC Guide](#-testing-personas--rbac-guide)
7. [Automated Verification Tests](#-automated-verification-tests)
8. [Documentation Links](#-documentation-links)

---

## 📦 Submission Deliverables Checklist

| Deliverable | Status | Location / Reference |
|---|:---:|---|
| **GitHub Repository** | ✅ Ready | Source code with complete setup & execution guide |
| **Working Application Demo** | ✅ Ready | Live local server on `http://localhost:8000` (or hosted endpoint) |
| **Demonstration Video** | ✅ Scripted | Walkthrough script covering video calling & core flows |
| **Technical Documentation** | ✅ Created | [TECHNICAL_DOCUMENTATION.md](file:///home/mohitsharma/Documents/Landconnect/TECHNICAL_DOCUMENTATION.md) |
| **AI Tools Usage Summary** | ✅ Created | [AI_TOOLS_USAGE_SUMMARY.md](file:///home/mohitsharma/Documents/Landconnect/AI_TOOLS_USAGE_SUMMARY.md) |

---

## 🌟 Key Features

### 1. WhatsApp-Inspired Mobile UI & Experience
- Signature WhatsApp teal header (`#075E54`), light green accents (`#25D366`), top status bar, and tab navigation (`LAND FEED`, `CHATS`, `CALLS`, `MAP`, `ROLE`).
- **Zero-Flicker Session Handling**: Immediate pre-render token validation prevents flash of login screen on page refresh.
- **Skeleton Shimmer Loading**: High-fidelity animated placeholders during asynchronous data fetches.
- **In-App Logout Confirmation**: Native-feeling modal dialog ensuring deliberate sign-out actions.

### 2. In-App Audio & Video Calling (Key Evaluation Requirement)
- Built on native **WebRTC (`RTCPeerConnection`)** with asynchronous WebSocket signaling.
- **Zero Phone-Number Leakage**: All communications use internal user IDs. Phone numbers are securely masked across the platform (`+91 98*** **321`).
- Real-time in-app call controls: Microphone mute/unmute, Camera on/off toggle, Screen sharing, and Call termination.
- **Synthesized Phone Ringtones**: Uses Web Audio API oscillators to generate authentic outgoing ringback and incoming call chimes without external audio files.
- Call history logging with call duration and timestamp tracking.

### 3. WhatsApp Voice Notes (In-Chat Audio Messaging)
- Record voice notes directly in chat threads with live duration timers.
- Visual audio waveforms displayed directly inside WhatsApp-style chat bubbles.
- Inline play/pause audio playback controls.

### 4. Property Listing Management & Cloud Storage
- Create and edit land parcels with title, property type, price in INR (₹), square footage, and description.
- **Neon Object Storage Integration**: Direct photo uploads into cloud bucket (`uploads`) using S3-compatible path-style addressing with local fallback.
- Title clearance tags, price per sq. ft. calculations, and instant favorite/bookmarking.

### 5. Maps & Seller Geolocation Toolkit
- **One-Tap GPS Auto-Detection**: Uses HTML5 Geolocation API with high-accuracy GPS mode (±5m precision).
- **Regional Hub Presets**: Quick auto-fill chips for key Bengaluru corridors (*Devanahalli*, *Sarjapur*, *Nelamangala*, *Whitefield*, *Kanakapura*).
- **Interactive OpenStreetMap Pin Picker**: Modal Leaflet map allowing sellers to drag and drop the pin directly onto their parcel boundaries with reverse-geocoding.

### 6. Land Area, Stamp Duty & EMI Calculator
- **Land Area Unit Converter**: Instantly converts between Acres, Gunthas, Cents, Bighas, Sq. Yards, and Sq. Feet.
- **Stamp Duty & Registration Calculator**: Computes state-specific stamp duty, registration fees, and cess (Karnataka, Maharashtra, Telangana, Tamil Nadu, Delhi).
- **Bank Loan EMI Estimator**: Calculates monthly EMI, total interest, and total repayment outlay.

---

## 🛠️ System Architecture

```
┌────────────────────────────────────────────────────────┐
│            Frontend (Mobile-First Web / PWA)           │
│  - Architecture: WhatsApp Mobile UI Frame              │
│  - Styling: Tailwind CSS & Lucide Icons                │
│  - Video & Audio: WebRTC + Web Audio API Synthesizer   │
│  - Realtime: WebSocket Client + Voice Recorder         │
│  - Maps: Leaflet.js + OpenStreetMap                    │
└───────────────────────────┬────────────────────────────┘
                            │ REST (HTTPS) + WebSocket (WSS)
┌───────────────────────────▼────────────────────────────┐
│            Backend Server (Python & Starlette)         │
│  - REST Engine: Starlette + Uvicorn ASGI               │
│  - Realtime Signaling: WebSocket Signaling Server      │
│  - Auth & RBAC: JWT (HS256) + Salted SHA-256           │
│  - Cloud Uploads: Boto3 S3 Client for Neon Storage     │
└─────────────┬────────────────────────────┬─────────────┘
              │                            │
┌─────────────▼──────────────┐  ┌──────────▼─────────────┐
│ Neon Serverless PostgreSQL │  │  Neon Object Storage   │
│ - SSL connection pooling   │  │  - Bucket: uploads     │
│ - Users, Listings, Calls   │  │  - Land Photographs    │
└────────────────────────────┘  └────────────────────────┘
```

---

## 🚀 Quick Start & Setup Instructions

### 1. Prerequisites
- Python 3.10+
- Modern Web Browser (Google Chrome, Microsoft Edge, Mozilla Firefox, or Safari)

### 2. Installation & Running

```bash
# Clone the repository
git clone <repository-url>
cd Landconnect

# Start the application server
cd backend
python3 -m uvicorn server:app --host 0.0.0.0 --port 8000
```

Open your browser to:
👉 **`http://localhost:8000`**

*(To test on a mobile phone, connect to the same Wi-Fi network and open `http://<your-computer-ip>:8000`)*

---

## 👥 Testing Personas & RBAC Guide

The application comes pre-seeded with authentic personas for evaluation:

| Persona | Role | Email | Password | Capabilities |
|---|---|---|---|---|
| **Aarav Patel** | **Buyer** | `buyer@landconnect.com` | `buyer123` | Browse land feed, filter listings, chat with owners, place video/audio calls. |
| **Vikram Reddy** | **Seller** | `seller@landconnect.com` | `seller123` | Post new land listings, upload bucket photos, set GPS pin, manage listings. |
| **Ananya Sharma**| **Broker** | `broker@landconnect.com` | `broker123` | Manage client portfolio, post commercial parcels, initiate video meeting rooms. |

*(You can also register a brand-new account with any custom email and role using the registration screen!)*

---

## 🧪 Automated Verification Tests

Run the backend integration test suite:

```bash
python3 -c "
import sys; sys.path.append('backend')
from starlette.testclient import TestClient
from server import app

client = TestClient(app)
assert client.get('/').status_code == 200
assert client.get('/api/listings').status_code == 200
print('✅ Integration tests passed successfully!')
"
```

---

## 📚 Documentation Links
- Detailed Technical Architecture: [TECHNICAL_DOCUMENTATION.md](file:///home/mohitsharma/Documents/Landconnect/TECHNICAL_DOCUMENTATION.md)
- AI Development Methodology: [AI_TOOLS_USAGE_SUMMARY.md](file:///home/mohitsharma/Documents/Landconnect/AI_TOOLS_USAGE_SUMMARY.md)

---
**Developed for LandConnect Technical Assignment by Mohit Sharma**
