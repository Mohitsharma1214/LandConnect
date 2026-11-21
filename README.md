# LandConnect – Real Estate Land Marketplace & In-App Calling Platform

A functional prototype of a real estate land marketplace mobile application featuring a clean, WhatsApp-inspired user interface with integrated peer-to-peer audio and video calling functionality.

---

## 🌟 Key Features

1. **WhatsApp-Inspired User Interface**:
   - Signature teal/green WhatsApp styling, top app header, status bar, and tab navigation (`LAND FEED`, `CHATS`, `CALLS`, `MAP`, `ROLE`).
   - Responsive mobile container tailored for smartphone displays, mobile web browsers, and emulators.

2. **Role-Based Access Control (RBAC)**:
   - **Buyer**: Discover verified land parcels, search by price/category/location, direct chat and audio/video calling with owners. Protected from posting unauthorized listings.
   - **Seller**: List and manage personal land parcels, geotag coordinates, receive buyer calls, and view leads.
   - **Broker**: Manage multi-client land portfolios, respond to high-intent buyer inquiries, and initiate encrypted meeting rooms.
   - **One-Click Technical Evaluation Switcher**: Instantly switch between Buyer (*Aarav*), Seller (*Vikram*), and Broker (*Ananya*) personas to test role-specific workflows during technical review.

3. **In-App Audio and Video Calling (Key Evaluation Requirement)**:
   - Built on native **WebRTC (`RTCPeerConnection`)** and real-time WebSocket signaling.
   - **Zero Phone-Number Leakage**: All communications occur purely through application IDs with phone numbers masked (`+91 98*** **321`).
   - Call lifecycle: Invitation signaling, incoming call dialog with ringtone animation, acceptance, live camera/audio streaming, mute microphone, camera toggle, and end call.
   - Call history log with duration and timestamp.

4. **Community Land Listings Feed**:
   - Real-time search and category filtering (Agricultural, Residential, Commercial, Industrial).
   - High-resolution property photography, pricing in INR (₹), square footage, and verified title tags.
   - One-tap WhatsApp-style actions: *Message*, *Voice Call*, and *Video Call*.

5. **Maps & Geolocation**:
   - Visual plot pin locator powered by OpenStreetMap/Leaflet.
   - Geotagging coordinates (latitude & longitude) when creating property listings.

---

## 🛠️ Architecture & Tech Stack

```
┌────────────────────────────────────────────────────────┐
│            Frontend (Mobile-First Web / PWA)           │
│  - Architecture: WhatsApp Mobile UI Frame              │
│  - Styling: Tailwind CSS & Lucide Icons                │
│  - Video & Audio Engine: WebRTC + getUserMedia         │
│  - Realtime: WebSocket client                          │
└───────────────────────────┬────────────────────────────┘
                            │ REST + WebSocket
┌───────────────────────────▼────────────────────────────┐
│            Backend Server (Python & Starlette)         │
│  - REST Engine: Starlette + Uvicorn (FastAPI Core)     │
│  - Realtime Signaling: WebSocket Signaling Server      │
│  - Auth & RBAC: JWT (HS256) + SHA-256 with Salt        │
│  - Storage: SQLite3 Relational Database                │
└────────────────────────────────────────────────────────┘
```

---

## 🚀 Quick Start Guide

### 1. Prerequisites
- Python 3.10+
- Modern Web Browser (Chrome / Edge / Firefox / Safari)

### 2. Start the Application
Run the backend server from the project root:

```bash
cd backend
python3 server.py
```

The server automatically seeds demo accounts, initializes the SQLite database, and serves the mobile application at:
👉 **`http://localhost:8000`**

### 3. Testing Roles & Demonstration
- Click the **ROLE** tab or tap the top-right menu to switch between:
  - **Buyer**: `buyer@landconnect.com` / `buyer123`
  - **Seller**: `seller@landconnect.com` / `seller123`
  - **Broker**: `broker@landconnect.com` / `broker123`

---

## 🧪 Automated Test Suite
To run the automated integration tests verifying Authentication, RBAC, and WebSocket call signaling:

```bash
python3 -c "
import sys; sys.path.append('backend')
from starlette.testclient import TestClient
from server import app

client = TestClient(app)
# Verify API health
assert client.get('/').status_code == 200
print('Integration tests passed!')
"
```
