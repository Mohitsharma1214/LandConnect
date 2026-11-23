import os
import json
import asyncio
import base64
import uuid
import time
from decimal import Decimal
from datetime import datetime, timezone

from starlette.applications import Starlette
from starlette.responses import JSONResponse, Response, FileResponse
from starlette.routing import Route, WebSocketRoute, Mount
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.staticfiles import StaticFiles
from starlette.websockets import WebSocket, WebSocketDisconnect

from database import (
    init_db, get_connection, DATABASE_URL,
    is_user_blocked, get_blocked_user_ids, block_contact_db, unblock_contact_db, create_report_db,
    load_blocked_cache
)
from auth import register_user, login_user, decode_jwt_token, get_user_profile, create_jwt_token
from seed_data import seed_listings

# Helper to serialize psycopg2 rows (handles Decimal and datetime)
def serialize_dict(d: dict) -> dict:
    clean = {}
    for k, v in d.items():
        if isinstance(v, Decimal):
            clean[k] = float(v)
        elif isinstance(v, datetime):
            if v.tzinfo is None:
                clean[k] = v.isoformat() + "Z"
            else:
                clean[k] = v.isoformat()
        else:
            clean[k] = v
    return clean

def load_users_cache():
    global cached_db_users, cached_db_users_ts
    try:
        conn = get_connection()
        try:
            cursor = conn.cursor()
            cursor.execute("SELECT id, name, email, role, phone_masked, avatar, bio FROM users ORDER BY id ASC")
            cached_db_users = [serialize_dict(dict(r)) for r in cursor.fetchall()]
            cached_db_users_ts = time.time()
            cursor.close()
        finally:
            conn.close()
    except Exception as e:
        print("Warning pre-warming users cache:", e)

# Try initializing database if DATABASE_URL is set
if DATABASE_URL:
    try:
        init_db()
        load_blocked_cache()
        load_users_cache()
        seed_listings()
    except Exception as e:
        print("Warning during DB initialization:", e)

FRONTEND_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "frontend")

# WebSocket connection registry: user_id -> set of WebSocket connections
active_connections = {}

# Deduplication cache: temp_id -> timestamp (prevents duplicate messages from rapid double-clicks / WS+HTTP overlap)
recent_msg_temp_ids = {}

def is_duplicate_temp_id(temp_id: str) -> bool:
    if not temp_id:
        return False
    now = time.time()
    # Prune temp_ids older than 60 seconds
    stale = [k for k, ts in recent_msg_temp_ids.items() if now - ts > 60]
    for k in stale:
        recent_msg_temp_ids.pop(k, None)
    if temp_id in recent_msg_temp_ids:
        return True
    recent_msg_temp_ids[temp_id] = now
    return False

# In-memory recent messages cache: (user_min, user_max) -> list of message dicts
server_messages_cache = {}
server_messages_cache_ts = {}

def get_cached_messages(u1: int, u2: int):
    key = (min(int(u1), int(u2)), max(int(u1), int(u2)))
    if key in server_messages_cache and (time.time() - server_messages_cache_ts.get(key, 0) < 6.0):
        return server_messages_cache[key]
    return None

def set_cached_messages(u1: int, u2: int, msgs: list):
    key = (min(int(u1), int(u2)), max(int(u1), int(u2)))
    server_messages_cache[key] = msgs
    server_messages_cache_ts[key] = time.time()

def invalidate_cached_messages(u1: int, u2: int):
    key = (min(int(u1), int(u2)), max(int(u1), int(u2)))
    server_messages_cache.pop(key, None)
    server_messages_cache_ts.pop(key, None)

def append_to_cached_messages(u1: int, u2: int, msg: dict):
    key = (min(int(u1), int(u2)), max(int(u1), int(u2)))
    if key in server_messages_cache:
        server_messages_cache[key].append(msg)
        server_messages_cache_ts[key] = time.time()

# In-memory users and conversations caches for 0ms chat list loading
cached_db_users = None
cached_db_users_ts = 0

user_conversations_cache = {}
user_conversations_cache_ts = {}

def invalidate_user_conversations(u1: int, u2: int = None):
    try:
        user_conversations_cache.pop(int(u1), None)
        user_conversations_cache_ts.pop(int(u1), None)
        if u2 is not None:
            user_conversations_cache.pop(int(u2), None)
            user_conversations_cache_ts.pop(int(u2), None)
    except Exception:
        pass

def db_mark_read_async(sender_id: int, receiver_id: int):
    try:
        conn = get_connection()
        try:
            cursor = conn.cursor()
            cursor.execute("UPDATE messages SET is_read = 1 WHERE sender_id = %s AND receiver_id = %s AND is_read = 0", (sender_id, receiver_id))
            conn.commit()
            cursor.close()
        finally:
            conn.close()
    except Exception as e:
        print("db_mark_read_async error:", e)

async def register_ws(user_id, websocket: WebSocket):
    try:
        u_id = int(user_id)
        if u_id not in active_connections:
            active_connections[u_id] = set()
        active_connections[u_id].add(websocket)
    except Exception:
        pass

async def unregister_ws(user_id, websocket: WebSocket):
    try:
        u_id = int(user_id)
        if u_id in active_connections:
            active_connections[u_id].discard(websocket)
            if not active_connections[u_id]:
                del active_connections[u_id]
    except Exception:
        pass

async def send_to_user(user_id, message: dict, exclude_ws: WebSocket = None):
    targets = set()
    try:
        u_int = int(user_id)
        if u_int in active_connections:
            targets.update(active_connections[u_int])
    except Exception:
        pass
    try:
        u_str = str(user_id)
        if u_str in active_connections:
            targets.update(active_connections[u_str])
    except Exception:
        pass

    if exclude_ws and exclude_ws in targets:
        targets.discard(exclude_ws)

    if targets:
        dead_sockets = set()
        msg_json = json.dumps(message)
        for ws in targets:
            try:
                await ws.send_text(msg_json)
            except Exception:
                dead_sockets.add(ws)
        if dead_sockets:
            for s in active_connections.values():
                s.difference_update(dead_sockets)

async def broadcast_user_status(user_id, status: str):
    try:
        u_id = int(user_id)
        msg_json = json.dumps({"type": "user_status", "userId": u_id, "status": status})
        dead_sockets = set()
        for uid, conns in list(active_connections.items()):
            if uid != u_id:
                for ws in list(conns):
                    try:
                        await ws.send_text(msg_json)
                    except Exception:
                        dead_sockets.add(ws)
        if dead_sockets:
            for s in active_connections.values():
                s.difference_update(dead_sockets)
    except Exception as e:
        print("broadcast_user_status error:", e)

def db_save_message(sender_id, receiver_id, listing_id, content, message_type):
    conn = get_connection()
    try:
        cursor = conn.cursor()
        is_read_val = 1 if sender_id == receiver_id else 0
        cursor.execute("""
            INSERT INTO messages (sender_id, receiver_id, listing_id, content, message_type, is_read)
            VALUES (%s, %s, %s, %s, %s, %s)
            RETURNING id, created_at;
        """, (sender_id, receiver_id, listing_id, content, message_type, is_read_val))
        row = cursor.fetchone()
        msg_id = row["id"]
        created_at = row["created_at"]
        conn.commit()
        cursor.close()
        if isinstance(created_at, datetime):
            if created_at.tzinfo is None:
                created_at_val = created_at.isoformat() + "Z"
            else:
                created_at_val = created_at.isoformat()
        else:
            created_at_str = str(created_at)
            if not created_at_str.endswith("Z") and "+" not in created_at_str:
                created_at_str = created_at_str.replace(" ", "T") + "Z"
            created_at_val = created_at_str
        return msg_id, created_at_val
    except Exception as e:
        print("Database save message error:", e)
        return None, None
    finally:
        conn.close()

async def persist_chat_message_async(sender_id, receiver_id, listing_id, content, message_type, temp_id):
    try:
        invalidate_cached_messages(sender_id, receiver_id)
        invalidate_user_conversations(sender_id, receiver_id)
        loop = asyncio.get_event_loop()
        msg_id, _ = await loop.run_in_executor(None, db_save_message, sender_id, receiver_id, listing_id, content, message_type)
        if msg_id:
            await send_to_user(sender_id, {"type": "message_synced", "tempId": temp_id, "id": msg_id})
            await send_to_user(receiver_id, {"type": "message_synced", "tempId": temp_id, "id": msg_id})
    except Exception as e:
        print("Async persist error:", e)

# --- REST Endpoints ---

async def api_register(request):
    try:
        data = await request.json()
        name = data.get("name", "").strip()
        email = data.get("email", "").strip()
        password = data.get("password", "")
        role = data.get("role", "buyer").strip().lower()
        phone = data.get("phone", "").strip()

        if not name:
            return JSONResponse({"error": "Full Name is required."}, status_code=400)
        if not email:
            return JSONResponse({"error": "Email address is required."}, status_code=400)
        if not phone:
            return JSONResponse({"error": "Mobile number is required."}, status_code=400)
        if not password:
            return JSONResponse({"error": "Password is required."}, status_code=400)
        if len(password) < 8:
            return JSONResponse({"error": "Password must be at least 8 characters long."}, status_code=400)
        
        result = register_user(name, email, password, role, phone)
        if "error" in result:
            return JSONResponse(result, status_code=400)
        return JSONResponse(result)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

async def api_login(request):
    try:
        data = await request.json()
        email = data.get("email", "").strip()
        password = data.get("password", "")

        if not email or not password:
            return JSONResponse({"error": "Email and password are required."}, status_code=400)

        result = login_user(email, password)
        if "error" in result:
            return JSONResponse(result, status_code=401)
        return JSONResponse(result)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

async def api_me(request):
    auth_header = request.headers.get("Authorization", "")
    token = auth_header.replace("Bearer ", "") if "Bearer " in auth_header else auth_header
    payload = decode_jwt_token(token)
    if not payload:
        return JSONResponse({"error": "Unauthorized or invalid token."}, status_code=401)
    
    profile = get_user_profile(payload["sub"])
    if not profile:
        return JSONResponse({"error": "User not found."}, status_code=404)
    return JSONResponse(serialize_dict(profile))

async def api_switch_role(request):
    auth_header = request.headers.get("Authorization", "")
    token = auth_header.replace("Bearer ", "") if "Bearer " in auth_header else auth_header
    payload = decode_jwt_token(token)
    if not payload:
        return JSONResponse({"error": "Unauthorized or invalid token."}, status_code=401)
    
    data = await request.json()
    new_role = data.get("role", "").lower()
    if new_role not in ["buyer", "seller", "broker"]:
        return JSONResponse({"error": "Invalid role."}, status_code=400)
    
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("UPDATE users SET role = %s WHERE id = %s", (new_role, payload["sub"]))
    conn.commit()
    cursor.close()
    conn.close()

    updated_profile = get_user_profile(payload["sub"])
    new_token = create_jwt_token(payload["sub"], new_role, updated_profile["email"])
    return JSONResponse({
        "token": new_token,
        "user": serialize_dict(updated_profile)
    })

async def api_update_profile(request):
    auth_header = request.headers.get("Authorization", "")
    token = auth_header.replace("Bearer ", "") if "Bearer " in auth_header else auth_header
    payload = decode_jwt_token(token)
    if not payload:
        return JSONResponse({"error": "Unauthorized or invalid token."}, status_code=401)
    
    data = await request.json()
    name = data.get("name", "").strip()
    avatar = data.get("avatar", "").strip()
    bio = data.get("bio", "").strip()

    if not name:
        return JSONResponse({"error": "Name cannot be empty."}, status_code=400)

    user_id = payload["sub"]
    conn = get_connection()
    try:
        cursor = conn.cursor()
        if avatar:
            cursor.execute("UPDATE users SET name = %s, avatar = %s, bio = %s WHERE id = %s", (name, avatar, bio, user_id))
        else:
            cursor.execute("UPDATE users SET name = %s, bio = %s WHERE id = %s", (name, bio, user_id))
        conn.commit()
        cursor.close()
    finally:
        conn.close()

    updated_profile = get_user_profile(user_id)
    new_token = create_jwt_token(user_id, updated_profile["role"], updated_profile["email"])
    return JSONResponse({
        "success": True,
        "token": new_token,
        "user": serialize_dict(updated_profile),
        "message": "Profile updated successfully."
    })

# Persistent Storage Bucket configuration
STORAGE_BUCKET_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "storage_bucket")
os.makedirs(STORAGE_BUCKET_DIR, exist_ok=True)

S3_BUCKET_NAME = os.getenv("S3_BUCKET_NAME") or os.getenv("AWS_S3_BUCKET") or "uploads"
AWS_ACCESS_KEY_ID = os.getenv("AWS_ACCESS_KEY_ID", "")
AWS_SECRET_ACCESS_KEY = os.getenv("AWS_SECRET_ACCESS_KEY", "")
AWS_ENDPOINT_URL = os.getenv("AWS_ENDPOINT_URL") or os.getenv("AWS_ENDPOINT_URL_S3") or os.getenv("S3_ENDPOINT_URL", "")
AWS_REGION = os.getenv("AWS_REGION", "us-east-2")

async def serve_bucket_file(request):
    """
    Serve bucket files from local storage if available; otherwise proxy/stream
    directly from Neon Object Storage S3 bucket and cache locally.
    Protected against path traversal attacks.
    Never return a 404 broken image: fallback to an SVG avatar.
    """
    raw_filename = request.path_params.get("filename", "")
    filename = os.path.basename(raw_filename).strip()
    if not filename or filename in ('.', '..') or '/' in filename or '\\' in filename:
        return Response("Invalid filename.", status_code=400)

    target_path = os.path.abspath(os.path.join(STORAGE_BUCKET_DIR, filename))
    if not target_path.startswith(os.path.abspath(STORAGE_BUCKET_DIR)):
        return Response("Access denied.", status_code=403)

    if os.path.exists(target_path) and os.path.isfile(target_path):
        return FileResponse(target_path)

    # Attempt fetch from Neon Object Storage (S3)
    if S3_BUCKET_NAME and AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY:
        try:
            import boto3
            from botocore.client import Config
            client_kwargs = {
                "aws_access_key_id": AWS_ACCESS_KEY_ID,
                "aws_secret_access_key": AWS_SECRET_ACCESS_KEY,
                "region_name": AWS_REGION,
                "config": Config(s3={'addressing_style': 'path'})
            }
            if AWS_ENDPOINT_URL:
                client_kwargs["endpoint_url"] = AWS_ENDPOINT_URL
            s3 = boto3.client("s3", **client_kwargs)
            obj = await asyncio.to_thread(s3.get_object, Bucket=S3_BUCKET_NAME, Key=filename)
            body = await asyncio.to_thread(obj['Body'].read)
            content_type = obj.get('ContentType', '')
            if not content_type or content_type == 'binary/octet-stream':
                ext = os.path.splitext(filename)[1].lower()
                content_type = 'image/png' if ext == '.png' else ('image/svg+xml' if ext == '.svg' else 'image/jpeg')
            try:
                with open(target_path, "wb") as f:
                    f.write(body)
            except Exception:
                pass
            return Response(body, media_type=content_type, headers={"Cache-Control": "public, max-age=86400"})
        except Exception as s3_err:
            print(f"Warning: Failed to fetch {filename} from S3 bucket: {s3_err}")

    # Fallback SVG so image never breaks
    initials = "LC"
    clean_stem = os.path.splitext(filename)[0]
    if "_" in clean_stem:
        parts = clean_stem.split("_")
        if len(parts) > 1 and parts[1]:
            initials = parts[1][:2].upper()
    svg_fallback = f'''<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">
  <rect width="120" height="120" rx="60" fill="#075E54"/>
  <text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-family="-apple-system,sans-serif" font-weight="bold" font-size="44" fill="#FFFFFF">{initials}</text>
</svg>'''
    return Response(svg_fallback, media_type="image/svg+xml", headers={"Cache-Control": "no-cache"})

async def api_upload_image(request):
    auth_header = request.headers.get("Authorization", "")
    token = auth_header.replace("Bearer ", "") if "Bearer " in auth_header else auth_header
    payload = decode_jwt_token(token)
    if not payload:
        return JSONResponse({"error": "Unauthorized."}, status_code=401)

    try:
        data = await request.json()
        raw_file_data = data.get("file_data") or data.get("image")
        raw_filename = data.get("filename", "property_plot.jpg")

        if not raw_file_data:
            return JSONResponse({"error": "No file data provided."}, status_code=400)

        # Strip data URL prefix if present (e.g. data:image/jpeg;base64,...)
        if "," in raw_file_data:
            raw_file_data = raw_file_data.split(",", 1)[1]

        file_bytes = base64.b64decode(raw_file_data)
        MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB
        if len(file_bytes) > MAX_FILE_SIZE:
            return JSONResponse({"error": "File size exceeds the 10 MB maximum limit."}, status_code=413)

        ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
        raw_ext = os.path.splitext(raw_filename)[1].lower()
        ext = raw_ext if raw_ext in ALLOWED_EXTENSIONS else ".jpg"

        # Validate image signature / magic bytes
        is_valid_image = (
            file_bytes.startswith(b"\xff\xd8\xff") or  # JPEG
            file_bytes.startswith(b"\x89PNG\r\n\x1a\n") or  # PNG
            (file_bytes.startswith(b"RIFF") and b"WEBP" in file_bytes[:16])  # WebP
        )
        if not is_valid_image and len(file_bytes) > 4:
            return JSONResponse({"error": "Invalid image file format. Only JPEG, PNG, and WebP images are allowed."}, status_code=400)

        unique_name = f"land_{uuid.uuid4().hex[:12]}{ext}"
        target_path = os.path.join(STORAGE_BUCKET_DIR, unique_name)

        with open(target_path, "wb") as f:
            f.write(file_bytes)

        public_url = f"/bucket/{unique_name}"
        bucket_provider = "Local Persistent Storage Bucket"

        # If Cloud S3 / Neon bucket is configured
        if S3_BUCKET_NAME and AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY:
            try:
                import boto3
                from botocore.client import Config
                client_kwargs = {
                    "aws_access_key_id": AWS_ACCESS_KEY_ID,
                    "aws_secret_access_key": AWS_SECRET_ACCESS_KEY,
                    "region_name": AWS_REGION,
                    "config": Config(s3={'addressing_style': 'path'})
                }
                if AWS_ENDPOINT_URL:
                    client_kwargs["endpoint_url"] = AWS_ENDPOINT_URL
                s3 = boto3.client("s3", **client_kwargs)
                s3.upload_file(target_path, S3_BUCKET_NAME, unique_name)
                public_url = f"/bucket/{unique_name}"
                bucket_provider = f"Neon Object Storage ({S3_BUCKET_NAME})"
            except Exception as s3_err:
                print(f"Warning: Cloud S3 bucket upload failed, using local bucket: {s3_err}")

        return JSONResponse({
            "success": True,
            "url": public_url,
            "filename": unique_name,
            "bucket": bucket_provider,
            "size": len(file_bytes)
        })
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

async def api_users(request):
    """List available users/contacts for chat & calling (0ms in-memory cached)"""
    global cached_db_users, cached_db_users_ts
    now = time.time()
    if cached_db_users is None or (now - cached_db_users_ts > 15.0):
        def fetch_users():
            conn = get_connection()
            try:
                cursor = conn.cursor()
                cursor.execute("SELECT id, name, email, role, phone_masked, avatar, bio FROM users ORDER BY id ASC")
                raw = [serialize_dict(dict(r)) for r in cursor.fetchall()]
                cursor.close()
                return raw
            finally:
                conn.close()
        cached_db_users = await asyncio.to_thread(fetch_users)
        cached_db_users_ts = now

    users = []
    for u in (cached_db_users or []):
        d = dict(u)
        uid = int(d["id"])
        d["is_online"] = (uid in active_connections and bool(active_connections[uid]))
        users.append(d)
    return JSONResponse(users)

async def api_user_detail(request):
    """Get full WhatsApp-style profile of a user with listings, status, and stats"""
    user_id = request.path_params.get("id")
    def fetch_user():
        conn = get_connection()
        try:
            cursor = conn.cursor()
            cursor.execute("SELECT id, name, email, role, phone_masked, avatar, bio, created_at FROM users WHERE id = %s", (user_id,))
            row = cursor.fetchone()
            if not row:
                return None
            u = serialize_dict(dict(row))
            u["is_online"] = (int(u["id"]) in active_connections and bool(active_connections[int(u["id"])]))
            
            # Fetch active listings by this user
            cursor.execute("""
                SELECT id, title, price, price_unit, area_sqft, property_type, location_address, city, state, images, created_at
                FROM listings
                WHERE owner_id = %s
                ORDER BY id DESC
            """, (user_id,))
            listings = []
            for l in cursor.fetchall():
                ld = serialize_dict(dict(l))
                if ld.get("images") and isinstance(ld["images"], str):
                    try:
                        ld["images"] = json.loads(ld["images"])
                    except Exception:
                        ld["images"] = []
                listings.append(ld)
            u["listings"] = listings

            # Total meeting rooms participant count
            cursor.execute("""
                SELECT COUNT(DISTINCT room_id) as room_count
                FROM meeting_room_participants
                WHERE user_id = %s
            """, (user_id,))
            m_row = cursor.fetchone()
            u["meeting_rooms_count"] = m_row["room_count"] if m_row else 0

            cursor.close()
            return u
        finally:
            conn.close()

    user_data = await asyncio.to_thread(fetch_user)
    if not user_data:
        return JSONResponse({"error": "User not found."}, status_code=404)
    return JSONResponse(user_data)

async def api_get_listings(request):
    def fetch_listings():
        conn = get_connection()
        try:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT l.*, u.name as owner_name, u.role as owner_role, u.phone_masked as owner_phone, u.avatar as owner_avatar
                FROM listings l
                JOIN users u ON l.owner_id = u.id
                ORDER BY l.id DESC
            """)
            rows = cursor.fetchall()
            listings = []
            for r in rows:
                d = serialize_dict(dict(r))
                raw_imgs = json.loads(d["images"]) if isinstance(d["images"], str) else (d["images"] or [])
                clean_imgs = []
                for img in raw_imgs:
                    if "/uploads/land_" in img:
                        clean_imgs.append(f"/bucket/{img.split('/uploads/')[1]}")
                    else:
                        clean_imgs.append(img)
                d["images"] = clean_imgs
                d["features"] = json.loads(d["features"]) if isinstance(d["features"], str) else (d["features"] or [])
                listings.append(d)
            cursor.close()
            return listings
        finally:
            conn.close()
    listings = await asyncio.to_thread(fetch_listings)
    return JSONResponse(listings)

async def api_create_listing(request):
    auth_header = request.headers.get("Authorization", "")
    token = auth_header.replace("Bearer ", "") if "Bearer " in auth_header else auth_header
    payload = decode_jwt_token(token)
    if not payload:
        return JSONResponse({"error": "Unauthorized. Please log in."}, status_code=401)
    
    role = payload.get("role")
    if role not in ("seller", "broker"):
        return JSONResponse({"error": "Permission denied. Only Sellers and Brokers can create land listings."}, status_code=403)
    
    try:
        data = await request.json()
        title = data.get("title", "").strip()
        description = data.get("description", "").strip()
        price = float(data.get("price", 0))
        area_sqft = float(data.get("area_sqft", 0))
        property_type = data.get("property_type", "Residential")
        location_address = data.get("location_address", "").strip()
        city = data.get("city", "Bengaluru").strip()
        state = data.get("state", "Karnataka").strip()
        latitude = float(data.get("latitude", 12.9716))
        longitude = float(data.get("longitude", 77.5946))
        images = json.dumps(data.get("images", ["https://images.unsplash.com/photo-1500382017468-9049fed747ef?w=800"]))
        features = json.dumps(data.get("features", ["Verified Title"]))
        owner_id = payload["sub"]

        conn = get_connection()
        try:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO listings (title, description, price, price_unit, area_sqft, property_type,
                                      location_address, city, state, latitude, longitude, images, features, owner_id)
                VALUES (%s, %s, %s, 'total', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING id;
            """, (title, description, price, area_sqft, property_type, location_address, city, state, latitude, longitude, images, features, owner_id))
            listing_id = cursor.fetchone()["id"]
            conn.commit()
            cursor.close()
            return JSONResponse({"success": True, "id": listing_id, "message": "Land listing created successfully."})
        finally:
            conn.close()
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=400)

async def api_my_listings(request):
    auth_header = request.headers.get("Authorization", "")
    token = auth_header.replace("Bearer ", "") if "Bearer " in auth_header else auth_header
    payload = decode_jwt_token(token)
    if not payload:
        return JSONResponse({"error": "Unauthorized."}, status_code=401)
    
    my_id = payload["sub"]
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT l.*, u.name as owner_name, u.role as owner_role, u.phone_masked as owner_phone, u.avatar as owner_avatar
        FROM listings l
        JOIN users u ON l.owner_id = u.id
        WHERE l.owner_id = %s
        ORDER BY l.id DESC
    """, (my_id,))
    rows = cursor.fetchall()
    listings = []
    for r in rows:
        d = serialize_dict(dict(r))
        raw_imgs = json.loads(d["images"]) if isinstance(d["images"], str) else (d["images"] or [])
        clean_imgs = []
        for img in raw_imgs:
            if "/uploads/land_" in img:
                clean_imgs.append(f"/bucket/{img.split('/uploads/')[1]}")
            else:
                clean_imgs.append(img)
        d["images"] = clean_imgs
        d["features"] = json.loads(d["features"]) if isinstance(d["features"], str) else (d["features"] or [])
        listings.append(d)
    cursor.close()
    conn.close()
    return JSONResponse(listings)

async def api_update_listing(request):
    listing_id = int(request.path_params["id"])
    auth_header = request.headers.get("Authorization", "")
    token = auth_header.replace("Bearer ", "") if "Bearer " in auth_header else auth_header
    payload = decode_jwt_token(token)
    if not payload:
        return JSONResponse({"error": "Unauthorized."}, status_code=401)

    my_id = payload["sub"]
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT owner_id FROM listings WHERE id = %s", (listing_id,))
    row = cursor.fetchone()
    if not row:
        cursor.close()
        conn.close()
        return JSONResponse({"error": "Listing not found."}, status_code=404)
    if row["owner_id"] != my_id:
        cursor.close()
        conn.close()
        return JSONResponse({"error": "Forbidden: You are not the owner of this listing."}, status_code=403)

    try:
        data = await request.json()
        title = data.get("title", "").strip()
        description = data.get("description", "").strip()
        price = float(data.get("price", 0))
        area_sqft = float(data.get("area_sqft", 0))
        property_type = data.get("property_type", "Residential")
        location_address = data.get("location_address", "").strip()
        latitude = float(data.get("latitude", 12.9716))
        longitude = float(data.get("longitude", 77.5946))
        images = json.dumps(data.get("images", ["https://images.unsplash.com/photo-1500382017468-9049fed747ef?w=800"]))

        cursor.execute("""
            UPDATE listings
            SET title = %s, description = %s, price = %s, area_sqft = %s,
                property_type = %s, location_address = %s, latitude = %s, longitude = %s, images = %s
            WHERE id = %s
        """, (title, description, price, area_sqft, property_type, location_address, latitude, longitude, images, listing_id))
        conn.commit()
        cursor.close()
        conn.close()
        return JSONResponse({"success": True, "message": "Listing updated successfully."})
    except Exception as e:
        cursor.close()
        conn.close()
        return JSONResponse({"error": str(e)}, status_code=400)

async def api_delete_listing(request):
    listing_id = int(request.path_params["id"])
    auth_header = request.headers.get("Authorization", "")
    token = auth_header.replace("Bearer ", "") if "Bearer " in auth_header else auth_header
    payload = decode_jwt_token(token)
    if not payload:
        return JSONResponse({"error": "Unauthorized."}, status_code=401)

    my_id = payload["sub"]
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT owner_id FROM listings WHERE id = %s", (listing_id,))
    row = cursor.fetchone()
    if not row:
        cursor.close()
        conn.close()
        return JSONResponse({"error": "Listing not found."}, status_code=404)
    if row["owner_id"] != my_id:
        cursor.close()
        conn.close()
        return JSONResponse({"error": "Forbidden: You are not the owner of this listing."}, status_code=403)

    cursor.execute("DELETE FROM listings WHERE id = %s", (listing_id,))
    conn.commit()
    cursor.close()
    conn.close()
    return JSONResponse({"success": True, "message": "Listing deleted successfully."})

async def api_get_messages(request):
    other_user_id = int(request.path_params["user_id"])
    auth_header = request.headers.get("Authorization", "")
    token = auth_header.replace("Bearer ", "") if "Bearer " in auth_header else auth_header
    payload = decode_jwt_token(token)
    if not payload:
        return JSONResponse({"error": "Unauthorized."}, status_code=401)
    
    my_id = int(payload["sub"])

    # 1. Instant cache return (<1ms zero latency)
    cached = get_cached_messages(my_id, other_user_id)
    if cached is not None:
        if other_user_id != my_id:
            asyncio.create_task(send_to_user(other_user_id, {"type": "messages_seen", "reader_id": my_id}))
        return JSONResponse(cached)

    def fetch_msgs():
        conn = get_connection()
        try:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT m.*, 
                       s.name as sender_name, s.avatar as sender_avatar,
                       r.name as receiver_name, r.avatar as receiver_avatar,
                       l.title as listing_title, l.price as listing_price, l.images as listing_images
                FROM messages m
                JOIN users s ON m.sender_id = s.id
                JOIN users r ON m.receiver_id = r.id
                LEFT JOIN listings l ON m.listing_id = l.id
                WHERE (m.sender_id = %s AND m.receiver_id = %s)
                   OR (m.sender_id = %s AND m.receiver_id = %s)
                ORDER BY m.created_at ASC
            """, (my_id, other_user_id, other_user_id, my_id))
            rows = []
            has_unread = False
            for r in cursor.fetchall():
                d = serialize_dict(dict(r))
                if d.get("receiver_id") == my_id and d.get("is_read") == 0:
                    has_unread = True
                if d.get("listing_images"):
                    try:
                        d["listing_images"] = json.loads(d["listing_images"]) if isinstance(d["listing_images"], str) else d["listing_images"]
                    except Exception:
                        d["listing_images"] = []
                rows.append(d)
            cursor.close()
            return rows, has_unread
        finally:
            conn.close()

    rows, has_unread = await asyncio.to_thread(fetch_msgs)
    set_cached_messages(my_id, other_user_id, rows)

    # Mark unread asynchronously without delaying response
    if has_unread:
        asyncio.create_task(asyncio.to_thread(db_mark_read_async, other_user_id, my_id))

    if other_user_id != my_id:
        asyncio.create_task(send_to_user(other_user_id, {"type": "messages_seen", "reader_id": my_id}))
    return JSONResponse(rows)

async def api_clear_messages(request):
    other_user_id = int(request.path_params["user_id"])
    auth_header = request.headers.get("Authorization", "")
    token = auth_header.replace("Bearer ", "") if "Bearer " in auth_header else auth_header
    payload = decode_jwt_token(token)
    if not payload:
        return JSONResponse({"error": "Unauthorized."}, status_code=401)
    
    my_id = int(payload["sub"])
    invalidate_cached_messages(my_id, other_user_id)
    invalidate_user_conversations(my_id, other_user_id)

    def clear_db():
        conn = get_connection()
        try:
            cursor = conn.cursor()
            cursor.execute("""
                DELETE FROM messages
                WHERE (sender_id = %s AND receiver_id = %s)
                   OR (sender_id = %s AND receiver_id = %s);
            """, (my_id, other_user_id, other_user_id, my_id))
            conn.commit()
            cursor.close()
            return True
        finally:
            conn.close()

    await asyncio.to_thread(clear_db)
    return JSONResponse({"success": True, "message": "Chat cleared successfully."})

async def api_conversations(request):
    auth_header = request.headers.get("Authorization", "")
    token = auth_header.replace("Bearer ", "") if "Bearer " in auth_header else auth_header
    payload = decode_jwt_token(token)
    if not payload:
        return JSONResponse({"error": "Unauthorized."}, status_code=401)
    
    my_id = int(payload["sub"])
    now = time.time()

    # 1. 0ms instant cached return
    if my_id in user_conversations_cache and (now - user_conversations_cache_ts.get(my_id, 0) < 6.0):
        return JSONResponse(user_conversations_cache[my_id])

    def fetch_convs():
        conn = get_connection()
        try:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT 
                    u.id AS peer_id,
                    u.name AS peer_name,
                    u.avatar AS peer_avatar,
                    u.role AS peer_role,
                    u.phone_masked AS peer_phone_masked,
                    last_m.content AS last_message,
                    last_m.message_type AS last_message_type,
                    last_m.created_at AS last_message_time,
                    last_m.sender_id AS last_message_sender_id,
                    COALESCE(last_m.is_read, 0) AS last_message_is_read,
                    COALESCE(unread.cnt, 0) AS unread_count
                FROM (
                    SELECT DISTINCT 
                        CASE WHEN sender_id = %s THEN receiver_id ELSE sender_id END AS other_user_id
                    FROM messages
                    WHERE sender_id = %s OR receiver_id = %s
                ) conv
                JOIN users u ON u.id = conv.other_user_id
                LEFT JOIN LATERAL (
                    SELECT content, message_type, created_at, sender_id, is_read
                    FROM messages
                    WHERE (sender_id = %s AND receiver_id = conv.other_user_id)
                       OR (sender_id = conv.other_user_id AND receiver_id = %s)
                    ORDER BY created_at DESC
                    LIMIT 1
                ) last_m ON true
                LEFT JOIN (
                    SELECT sender_id, COUNT(*) AS cnt
                    FROM messages
                    WHERE receiver_id = %s AND sender_id != %s AND is_read = 0
                    GROUP BY sender_id
                ) unread ON unread.sender_id = conv.other_user_id
                ORDER BY last_m.created_at DESC NULLS LAST;
            """, (my_id, my_id, my_id, my_id, my_id, my_id, my_id))
            rows = [serialize_dict(dict(r)) for r in cursor.fetchall()]
            cursor.close()
            return rows
        finally:
            conn.close()

    rows = await asyncio.to_thread(fetch_convs)
    user_conversations_cache[my_id] = rows
    user_conversations_cache_ts[my_id] = now
    return JSONResponse(rows)

async def api_send_message(request):
    auth_header = request.headers.get("Authorization", "")
    token = auth_header.replace("Bearer ", "") if "Bearer " in auth_header else auth_header
    payload = decode_jwt_token(token)
    if not payload:
        return JSONResponse({"error": "Unauthorized."}, status_code=401)
    
    data = await request.json()
    sender_id = int(payload["sub"])
    receiver_id = int(data.get("receiver_id"))
    listing_id = data.get("listing_id")
    content = data.get("content", "").strip()
    message_type = data.get("message_type", "text")
    temp_id = data.get("tempId") or f"msg_{uuid.uuid4().hex[:12]}"

    if not receiver_id or not content:
        return JSONResponse({"error": "Receiver and message content are required."}, status_code=400)

    # Trust & Safety: Check if user is blocked
    is_blocked = await asyncio.to_thread(is_user_blocked, sender_id, receiver_id)
    if is_blocked:
        return JSONResponse({"error": "Cannot send message. Contact is blocked."}, status_code=403)

    is_self = (sender_id == receiver_id)
    instant_msg = {
        "id": temp_id,
        "tempId": temp_id,
        "sender_id": sender_id,
        "receiver_id": receiver_id,
        "listing_id": listing_id,
        "content": content,
        "message_type": message_type,
        "is_read": 1 if is_self else 0,
        "created_at": datetime.utcnow().isoformat(),
        "sender_name": data.get("sender_name", ""),
        "sender_avatar": data.get("sender_avatar", ""),
        "listing_title": data.get("listing_title", ""),
        "listing_price": data.get("listing_price", 0),
        "listing_images": data.get("listing_images", []),
        "contact_id": data.get("contact_id"),
        "contact_name": data.get("contact_name"),
        "contact_role": data.get("contact_role"),
        "contact_avatar": data.get("contact_avatar"),
        "contact_phone": data.get("contact_phone"),
        "contact_bio": data.get("contact_bio")
    }

    # Deduplication guard: if this message was already dispatched/persisted (e.g. via WebSocket), do not duplicate
    if is_duplicate_temp_id(temp_id):
        return JSONResponse(instant_msg)

    # 1. INSTANT DISPATCH TO RECEIVER (0ms delay - do not wait for DB network latency!)
    if is_self:
        await send_to_user(sender_id, {
            "type": "new_message",
            "message": instant_msg
        })
    else:
        await send_to_user(receiver_id, {
            "type": "new_message",
            "message": instant_msg
        })

    # 2. Persist to Neon DB in executor so loop is not blocked
    loop = asyncio.get_event_loop()
    msg_id, created_at = await loop.run_in_executor(None, db_save_message, sender_id, receiver_id, listing_id, content, message_type)
    if msg_id:
        instant_msg["id"] = msg_id
        if created_at:
            instant_msg["created_at"] = created_at
        # Send sync confirmation
        await send_to_user(sender_id, {"type": "message_synced", "tempId": temp_id, "id": msg_id})
        await send_to_user(receiver_id, {"type": "message_synced", "tempId": temp_id, "id": msg_id})

    return JSONResponse(instant_msg)

async def api_call_logs(request):
    auth_header = request.headers.get("Authorization", "")
    token = auth_header.replace("Bearer ", "") if "Bearer " in auth_header else auth_header
    payload = decode_jwt_token(token)
    if not payload:
        return JSONResponse({"error": "Unauthorized."}, status_code=401)
    
    user_id = payload["sub"]

    def fetch_logs():
        conn = get_connection()
        try:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT c.*, 
                       u_caller.name as caller_name, u_caller.avatar as caller_avatar, u_caller.role as caller_role,
                       u_rec.name as receiver_name, u_rec.avatar as receiver_avatar, u_rec.role as receiver_role
                FROM call_logs c
                JOIN users u_caller ON c.caller_id = u_caller.id
                JOIN users u_rec ON c.receiver_id = u_rec.id
                WHERE c.caller_id = %s OR c.receiver_id = %s
                ORDER BY c.created_at DESC
                LIMIT 30
            """, (user_id, user_id))
            logs = [serialize_dict(dict(r)) for r in cursor.fetchall()]
            cursor.close()
            return logs
        finally:
            conn.close()

    logs = await asyncio.to_thread(fetch_logs)
    return JSONResponse(logs)

async def api_meeting_room_history(request):
    auth_header = request.headers.get("Authorization", "")
    token = auth_header.replace("Bearer ", "") if "Bearer " in auth_header else auth_header
    payload = decode_jwt_token(token)
    if not payload:
        return JSONResponse({"error": "Unauthorized."}, status_code=401)
    
    user_id = payload["sub"]

    def fetch_room_logs():
        conn = get_connection()
        try:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT m.*, 
                       u_host.name as host_name, u_host.avatar as host_avatar, u_host.role as host_role
                FROM meeting_room_logs m
                JOIN users u_host ON m.host_id = u_host.id
                WHERE m.host_id = %s OR m.room_id IN (
                    SELECT room_id FROM meeting_room_participants WHERE user_id = %s
                )
                ORDER BY m.updated_at DESC
                LIMIT 50;
            """, (user_id, user_id))
            logs = [serialize_dict(dict(r)) for r in cursor.fetchall()]
            cursor.close()
            return logs
        finally:
            conn.close()

    logs = await asyncio.to_thread(fetch_room_logs)
    return JSONResponse(logs)

# --- Trust & Safety: Contact Blocking & Reporting ---

async def api_get_blocks(request):
    auth_header = request.headers.get("Authorization", "")
    token = auth_header.replace("Bearer ", "") if "Bearer " in auth_header else auth_header
    payload = decode_jwt_token(token)
    if not payload:
        return JSONResponse({"error": "Unauthorized."}, status_code=401)
    user_id = payload["sub"]
    blocked_ids = await asyncio.to_thread(get_blocked_user_ids, user_id)
    return JSONResponse({"blocked_ids": blocked_ids})

async def api_block_contact(request):
    auth_header = request.headers.get("Authorization", "")
    token = auth_header.replace("Bearer ", "") if "Bearer " in auth_header else auth_header
    payload = decode_jwt_token(token)
    if not payload:
        return JSONResponse({"error": "Unauthorized."}, status_code=401)
    user_id = int(payload["sub"])
    target_id = int(request.path_params["target_id"])
    if user_id == target_id:
        return JSONResponse({"error": "Cannot block yourself."}, status_code=400)
    
    await asyncio.to_thread(block_contact_db, user_id, target_id)
    # Real-time WebSocket sync to both blocker and blocked
    await send_to_user(target_id, {
        "type": "contact_blocked_update",
        "peerId": user_id,
        "isBlocked": True,
        "blockedByMe": False
    })
    await send_to_user(user_id, {
        "type": "contact_blocked_update",
        "peerId": target_id,
        "isBlocked": True,
        "blockedByMe": True
    })
    return JSONResponse({"success": True, "blocked_id": target_id})

async def api_unblock_contact(request):
    auth_header = request.headers.get("Authorization", "")
    token = auth_header.replace("Bearer ", "") if "Bearer " in auth_header else auth_header
    payload = decode_jwt_token(token)
    if not payload:
        return JSONResponse({"error": "Unauthorized."}, status_code=401)
    user_id = int(payload["sub"])
    target_id = int(request.path_params["target_id"])
    
    await asyncio.to_thread(unblock_contact_db, user_id, target_id)
    await send_to_user(target_id, {
        "type": "contact_blocked_update",
        "peerId": user_id,
        "isBlocked": False,
        "blockedByMe": False
    })
    await send_to_user(user_id, {
        "type": "contact_blocked_update",
        "peerId": target_id,
        "isBlocked": False,
        "blockedByMe": True
    })
    return JSONResponse({"success": True, "unblocked_id": target_id})

async def api_report_contact(request):
    auth_header = request.headers.get("Authorization", "")
    token = auth_header.replace("Bearer ", "") if "Bearer " in auth_header else auth_header
    payload = decode_jwt_token(token)
    if not payload:
        return JSONResponse({"error": "Unauthorized."}, status_code=401)
    user_id = int(payload["sub"])
    try:
        data = await request.json()
    except Exception:
        data = {}
    
    reported_id = int(data.get("reported_id") or 0)
    reason = str(data.get("reason", "Inappropriate behavior")).strip()
    details = str(data.get("details", "")).strip()
    also_block = bool(data.get("also_block", False))

    if not reported_id:
        return JSONResponse({"error": "Reported user is required."}, status_code=400)
    if reported_id == user_id:
        return JSONResponse({"error": "Cannot report yourself."}, status_code=400)

    report_id = await asyncio.to_thread(create_report_db, user_id, reported_id, reason, details)

    if also_block:
        await asyncio.to_thread(block_contact_db, user_id, reported_id)
        await send_to_user(reported_id, {
            "type": "contact_blocked_update",
            "peerId": user_id,
            "isBlocked": True,
            "blockedByMe": False
        })
        await send_to_user(user_id, {
            "type": "contact_blocked_update",
            "peerId": reported_id,
            "isBlocked": True,
            "blockedByMe": True
        })

    return JSONResponse({
        "success": True,
        "report_id": report_id,
        "also_blocked": also_block,
        "message": "Report submitted successfully."
    })

# --- Real-Time WebSocket for Signaling (Audio / Video Calls, Meeting Rooms & Live Chat) ---

# Active multi-participant meeting rooms:
# room_id -> { "id": str, "created_by": int, "participants": { user_id: { "id": int, "name": str, "avatar": str, "role": str } } }
active_meeting_rooms: Dict[str, Dict[str, Any]] = {}

# Active 1-to-1 direct calls tracking: user_id -> peer_user_id
active_direct_calls: Dict[int, int] = {}

async def websocket_signaling(websocket: WebSocket):
    await websocket.accept()
    authenticated_user_id = None
    try:
        while True:
            raw_data = await websocket.receive_text()
            data = json.loads(raw_data)
            msg_type = data.get("type")

            if msg_type == "authenticate":
                token = data.get("token")
                payload = decode_jwt_token(token)
                if payload:
                    authenticated_user_id = payload["sub"]
                    await register_ws(authenticated_user_id, websocket)
                    online_uids = [int(uid) for uid, conns in active_connections.items() if conns]
                    await websocket.send_text(json.dumps({
                        "type": "authenticated",
                        "userId": authenticated_user_id,
                        "onlineUsers": online_uids
                    }))
                    await broadcast_user_status(authenticated_user_id, "online")
                else:
                    await websocket.send_text(json.dumps({
                        "type": "auth_error",
                        "message": "Invalid token"
                    }))

            elif msg_type == "ping":
                await websocket.send_text(json.dumps({"type": "pong"}))

            elif msg_type == "mark_as_read":
                target_sender_id = data.get("sender_id") or data.get("targetUserId")
                if target_sender_id and authenticated_user_id:
                    def update_read():
                        conn = get_connection()
                        try:
                            cur = conn.cursor()
                            cur.execute("UPDATE messages SET is_read = 1 WHERE sender_id = %s AND receiver_id = %s AND is_read = 0", (int(target_sender_id), authenticated_user_id))
                            conn.commit()
                            cur.close()
                        finally:
                            conn.close()
                    asyncio.create_task(asyncio.to_thread(update_read))
                    if int(target_sender_id) != int(authenticated_user_id):
                        await send_to_user(int(target_sender_id), {
                            "type": "messages_seen",
                            "reader_id": authenticated_user_id
                        })

            elif msg_type == "typing":
                target_user_id = data.get("targetUserId")
                is_typing = bool(data.get("isTyping", False))
                if target_user_id and authenticated_user_id:
                    await send_to_user(target_user_id, {
                        "type": "typing",
                        "senderId": authenticated_user_id,
                        "isTyping": is_typing
                    })

            elif msg_type == "chat_message":
                if not authenticated_user_id:
                    continue
                try:
                    auth_uid = int(authenticated_user_id)
                    receiver_id = int(data.get("receiver_id"))
                    content = data.get("content", "").strip()
                    message_type = data.get("message_type", "text")
                    listing_id = data.get("listing_id")
                    temp_id = data.get("tempId") or f"msg_{uuid.uuid4().hex[:12]}"
                    is_self = (receiver_id == auth_uid)

                    # Deduplication guard: if already processed within 60s, just ack and skip
                    if is_duplicate_temp_id(temp_id):
                        await websocket.send_text(json.dumps({
                            "type": "message_sent_ack",
                            "tempId": temp_id,
                            "is_read": 1 if is_self else 0
                        }))
                        continue

                    # Check if contact is blocked (in-memory 0ms)
                    if not is_self and is_user_blocked(auth_uid, receiver_id):
                        await websocket.send_text(json.dumps({
                            "type": "chat_error",
                            "tempId": temp_id,
                            "message": "Cannot send message. Contact is blocked."
                        }))
                        continue

                    instant_msg = {
                        "id": temp_id,
                        "tempId": temp_id,
                        "sender_id": auth_uid,
                        "receiver_id": receiver_id,
                        "listing_id": listing_id,
                        "content": content,
                        "message_type": message_type,
                        "is_read": 1 if is_self else 0,
                        "created_at": datetime.now(timezone.utc).isoformat(),
                        "sender_name": data.get("sender_name", ""),
                        "sender_avatar": data.get("sender_avatar", ""),
                        "listing_title": data.get("listing_title", ""),
                        "listing_price": data.get("listing_price", 0),
                        "listing_images": data.get("listing_images", []),
                        "contact_id": data.get("contact_id"),
                        "contact_name": data.get("contact_name"),
                        "contact_role": data.get("contact_role"),
                        "contact_avatar": data.get("contact_avatar"),
                        "contact_phone": data.get("contact_phone"),
                        "contact_bio": data.get("contact_bio")
                    }

                    # 1. INSTANT DISPATCH TO RECEIVER OVER WS (0ms)
                    if is_self:
                        # For self-chat, deliver to other open tabs/windows of this user
                        await send_to_user(auth_uid, {
                            "type": "new_message",
                            "message": instant_msg
                        }, exclude_ws=websocket)
                    else:
                        await send_to_user(receiver_id, {
                            "type": "new_message",
                            "message": instant_msg
                        })

                    # 2. IMMEDIATE ACK TO SENDER (0ms)
                    await websocket.send_text(json.dumps({
                        "type": "message_sent_ack",
                        "tempId": temp_id,
                        "is_read": 1 if is_self else 0
                    }))

                    # 3. Async DB write without blocking
                    asyncio.create_task(persist_chat_message_async(auth_uid, receiver_id, listing_id, content, message_type, temp_id))
                except Exception as e:
                    print("WS chat_message error:", e)

            elif msg_type == "initiate_call":
                if not authenticated_user_id:
                    continue
                receiver_id = data.get("receiverId")
                call_type = data.get("callType", "video")
                listing_id = data.get("listingId")
                caller_info = data.get("callerInfo", {})
                
                # Check if contact is blocked
                if await asyncio.to_thread(is_user_blocked, authenticated_user_id, receiver_id):
                    await websocket.send_text(json.dumps({
                        "type": "call_rejected",
                        "reason": "Contact is unavailable"
                    }))
                    continue
                
                try:
                    u_int = int(authenticated_user_id)
                    r_int = int(receiver_id)
                    active_direct_calls[u_int] = r_int
                    active_direct_calls[r_int] = u_int
                except Exception:
                    pass

                await send_to_user(receiver_id, {
                    "type": "incoming_call",
                    "callerId": authenticated_user_id,
                    "callerInfo": caller_info,
                    "callType": call_type,
                    "listingId": listing_id
                })

            elif msg_type == "accept_call":
                if not authenticated_user_id:
                    continue
                caller_id = data.get("callerId")
                await send_to_user(caller_id, {
                    "type": "call_accepted",
                    "receiverId": authenticated_user_id
                })

            elif msg_type == "reject_call":
                if not authenticated_user_id:
                    continue
                caller_id = data.get("callerId")
                reason = data.get("reason", "Call declined")
                try:
                    u_int = int(authenticated_user_id)
                    c_int = int(caller_id)
                    active_direct_calls.pop(u_int, None)
                    active_direct_calls.pop(c_int, None)
                except Exception:
                    pass
                await send_to_user(caller_id, {
                    "type": "call_rejected",
                    "reason": reason
                })

            elif msg_type == "end_call":
                if not authenticated_user_id:
                    continue
                target_user_id = data.get("targetUserId")
                duration = data.get("duration", 0)
                call_type = data.get("callType", "video")
                try:
                    u_int = int(authenticated_user_id)
                    t_int = int(target_user_id) if target_user_id else None
                    active_direct_calls.pop(u_int, None)
                    if t_int:
                        active_direct_calls.pop(t_int, None)
                except Exception:
                    pass
                if target_user_id:
                    await send_to_user(target_user_id, {
                        "type": "call_ended",
                        "by": authenticated_user_id
                    })
                if target_user_id and authenticated_user_id and DATABASE_URL:
                    def log_call_sync():
                        try:
                            conn = get_connection()
                            c = conn.cursor()
                            c.execute("""
                                INSERT INTO call_logs (caller_id, receiver_id, call_type, status, duration_seconds)
                                VALUES (%s, %s, %s, 'completed', %s)
                            """, (authenticated_user_id, target_user_id, call_type, duration))
                            conn.commit()
                            c.close()
                            conn.close()
                        except Exception as e:
                            print("Error logging call:", e)
                    asyncio.create_task(asyncio.to_thread(log_call_sync))

            elif msg_type in ("webrtc_offer", "webrtc_answer", "ice_candidate"):
                target_id = data.get("targetUserId")
                if target_id and authenticated_user_id:
                    data["senderId"] = authenticated_user_id
                    await send_to_user(target_id, data)

            # --- Multi-Party Meeting Room Signaling ---
            elif msg_type == "join_meeting_room":
                if not authenticated_user_id:
                    continue
                room_id = data.get("roomId", "").strip()
                if not room_id:
                    continue
                user_info = data.get("userInfo") or {}

                if room_id not in active_meeting_rooms:
                    active_meeting_rooms[room_id] = {
                        "id": room_id,
                        "created_by": authenticated_user_id,
                        "participants": {}
                    }

                room = active_meeting_rooms[room_id]
                existing_peers = [p for uid, p in room["participants"].items() if uid != authenticated_user_id]

                user_entry = {
                    "id": authenticated_user_id,
                    "name": user_info.get("name") or f"User #{authenticated_user_id}",
                    "avatar": user_info.get("avatar") or "",
                    "role": user_info.get("role") or "Member"
                }
                room["participants"][authenticated_user_id] = user_entry

                # 1. Send confirmation and existing peers to newly joined participant
                await websocket.send_text(json.dumps({
                    "type": "meeting_room_joined",
                    "roomId": room_id,
                    "participants": existing_peers,
                    "self": user_entry
                }))

                # 2. Announce to all existing peers in this room
                for peer in existing_peers:
                    await send_to_user(peer["id"], {
                        "type": "meeting_peer_joined",
                        "roomId": room_id,
                        "peer": user_entry
                    })

                # 3. Async persist meeting room and participant
                if DATABASE_URL:
                    def log_room_join_sync(r_id, h_id, u_info):
                        try:
                            c_conn = get_connection()
                            c_cur = c_conn.cursor()
                            c_cur.execute("""
                                INSERT INTO meeting_room_logs (room_id, host_id, title, created_at, updated_at)
                                VALUES (%s, %s, %s, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                                ON CONFLICT (room_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP;
                            """, (r_id, h_id, "Virtual Meeting Room"))

                            c_cur.execute("""
                                INSERT INTO meeting_room_participants (room_id, user_id, user_name, user_avatar, user_role, joined_at)
                                VALUES (%s, %s, %s, %s, %s, CURRENT_TIMESTAMP)
                                ON CONFLICT (room_id, user_id) DO UPDATE SET joined_at = CURRENT_TIMESTAMP;
                            """, (r_id, h_id, u_info.get("name", "User"), u_info.get("avatar", ""), u_info.get("role", "Member")))

                            c_cur.execute("""
                                SELECT user_name, user_role FROM meeting_room_participants WHERE room_id = %s ORDER BY joined_at ASC;
                            """, (r_id,))
                            all_parts = c_cur.fetchall()
                            summary_str = ", ".join([f"{p['user_name']} ({p['user_role'].title()})" for p in all_parts])

                            c_cur.execute("""
                                UPDATE meeting_room_logs 
                                SET participants_summary = %s, updated_at = CURRENT_TIMESTAMP 
                                WHERE room_id = %s;
                            """, (summary_str, r_id))

                            c_conn.commit()
                            c_cur.close()
                            c_conn.close()
                        except Exception as e:
                            print("Error logging meeting room join:", e)

                    asyncio.create_task(asyncio.to_thread(log_room_join_sync, room_id, authenticated_user_id, user_entry))

            elif msg_type == "leave_meeting_room":
                if not authenticated_user_id:
                    continue
                room_id = data.get("roomId", "").strip()
                duration = int(data.get("duration", 0))
                if room_id in active_meeting_rooms:
                    room = active_meeting_rooms[room_id]
                    if authenticated_user_id in room["participants"]:
                        del room["participants"][authenticated_user_id]
                        for uid in list(room["participants"].keys()):
                            await send_to_user(uid, {
                                "type": "meeting_peer_left",
                                "roomId": room_id,
                                "peerId": authenticated_user_id
                            })
                        if not room["participants"]:
                            del active_meeting_rooms[room_id]

                if duration > 0 and DATABASE_URL:
                    def update_room_duration_sync(r_id, dur):
                        try:
                            c_conn = get_connection()
                            c_cur = c_conn.cursor()
                            c_cur.execute("""
                                UPDATE meeting_room_logs 
                                SET duration_seconds = GREATEST(duration_seconds, %s), updated_at = CURRENT_TIMESTAMP
                                WHERE room_id = %s;
                            """, (dur, r_id))
                            c_conn.commit()
                            c_cur.close()
                            c_conn.close()
                        except Exception as e:
                            print("Error updating room duration:", e)
                    asyncio.create_task(asyncio.to_thread(update_room_duration_sync, room_id, duration))

            elif msg_type in ("meeting_offer", "meeting_answer", "meeting_ice_candidate"):
                target_id = data.get("targetUserId")
                if target_id and authenticated_user_id:
                    data["senderId"] = authenticated_user_id
                    await send_to_user(target_id, data)

    except (WebSocketDisconnect, Exception):
        if authenticated_user_id:
            await unregister_ws(authenticated_user_id, websocket)
            u_id = int(authenticated_user_id)
            if u_id not in active_connections or not active_connections[u_id]:
                await broadcast_user_status(u_id, "offline")

            # Clean up active 1-to-1 direct call if caller or receiver disconnects
            peer_id = active_direct_calls.pop(u_id, None)
            if peer_id:
                active_direct_calls.pop(peer_id, None)
                await send_to_user(peer_id, {
                    "type": "call_ended",
                    "by": u_id,
                    "reason": "Peer disconnected"
                })

            # Clean up user from active meeting rooms
            for r_id, r_info in list(active_meeting_rooms.items()):
                if u_id in r_info.get("participants", {}):
                    del r_info["participants"][u_id]
                    for remaining_uid in list(r_info["participants"].keys()):
                        await send_to_user(remaining_uid, {
                            "type": "meeting_peer_left",
                            "roomId": r_id,
                            "peerId": u_id
                        })
                    if not r_info["participants"]:
                        del active_meeting_rooms[r_id]

# --- Static Frontend Serving ---

async def serve_index(request):
    index_file = os.path.join(FRONTEND_DIR, "index.html")
    if os.path.exists(index_file):
        resp = FileResponse(index_file)
        resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
        return resp
    return Response("LandConnect Frontend is building...", media_type="text/plain")

async def serve_sw(request):
    sw_file = os.path.join(FRONTEND_DIR, "sw.js")
    if os.path.exists(sw_file):
        resp = FileResponse(sw_file, media_type="application/javascript")
        resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
        return resp
    return Response("// SW not found", media_type="application/javascript")

async def serve_app_js(request):
    js_file = os.path.join(FRONTEND_DIR, "app.js")
    if os.path.exists(js_file):
        resp = FileResponse(js_file, media_type="application/javascript")
        resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
        return resp
    return Response("// app.js not found", media_type="application/javascript")

async def serve_manifest(request):
    m_file = os.path.join(FRONTEND_DIR, "manifest.json")
    if os.path.exists(m_file):
        return FileResponse(m_file, media_type="application/manifest+json")
    return Response("{}", media_type="application/manifest+json")

async def serve_favicon(request):
    fav = os.path.join(FRONTEND_DIR, "icons", "favicon.ico")
    if os.path.exists(fav):
        return FileResponse(fav, media_type="image/x-icon")
    return Response(status_code=404)

routes = [
    Route("/api/auth/register", api_register, methods=["POST"]),
    Route("/api/auth/login", api_login, methods=["POST"]),
    Route("/api/auth/me", api_me, methods=["GET"]),
    Route("/api/auth/role", api_switch_role, methods=["PUT"]),
    Route("/api/auth/profile", api_update_profile, methods=["PUT"]),
    Route("/api/upload", api_upload_image, methods=["POST"]),
    Route("/api/users", api_users, methods=["GET"]),
    Route("/api/users/{id:int}", api_user_detail, methods=["GET"]),
    Route("/api/listings", api_get_listings, methods=["GET"]),
    Route("/api/listings", api_create_listing, methods=["POST"]),
    Route("/api/listings/my", api_my_listings, methods=["GET"]),
    Route("/api/listings/{id:int}", api_update_listing, methods=["PUT"]),
    Route("/api/listings/{id:int}", api_delete_listing, methods=["DELETE"]),
    Route("/api/messages/{user_id:int}", api_get_messages, methods=["GET"]),
    Route("/api/messages/{user_id:int}", api_clear_messages, methods=["DELETE"]),
    Route("/api/messages", api_send_message, methods=["POST"]),
    Route("/api/conversations", api_conversations, methods=["GET"]),
    Route("/api/calls/history", api_call_logs, methods=["GET"]),
    Route("/api/meeting-rooms/history", api_meeting_room_history, methods=["GET"]),
    Route("/api/blocks", api_get_blocks, methods=["GET"]),
    Route("/api/blocks/{target_id:int}", api_block_contact, methods=["POST"]),
    Route("/api/blocks/{target_id:int}", api_unblock_contact, methods=["DELETE"]),
    Route("/api/reports", api_report_contact, methods=["POST"]),
    WebSocketRoute("/ws", websocket_signaling),
    Route("/bucket/{filename:path}", serve_bucket_file),
    Route("/static/app.js", serve_app_js),
    Route("/sw.js", serve_sw),
    Route("/manifest.json", serve_manifest),
    Route("/favicon.ico", serve_favicon),
    Route("/", serve_index),
]

middleware = [
    Middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
]

app = Starlette(debug=True, routes=routes, middleware=middleware)

if os.path.exists(FRONTEND_DIR):
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    print(f"Starting LandConnect Server on http://0.0.0.0:{port}...")
    uvicorn.run("server:app", host="0.0.0.0", port=port, reload=True)
