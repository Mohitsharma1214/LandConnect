import os
import json
import asyncio
import base64
import uuid
from decimal import Decimal
from datetime import datetime

from starlette.applications import Starlette
from starlette.responses import JSONResponse, Response, FileResponse
from starlette.routing import Route, WebSocketRoute, Mount
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.staticfiles import StaticFiles
from starlette.websockets import WebSocket, WebSocketDisconnect

from database import init_db, get_connection, DATABASE_URL
from auth import register_user, login_user, decode_jwt_token, get_user_profile
from seed_data import seed_listings

# Helper to serialize psycopg2 rows (handles Decimal and datetime)
def serialize_dict(d: dict) -> dict:
    clean = {}
    for k, v in d.items():
        if isinstance(v, Decimal):
            clean[k] = float(v)
        elif isinstance(v, datetime):
            clean[k] = v.isoformat()
        else:
            clean[k] = v
    return clean

# Try initializing database if DATABASE_URL is set
if DATABASE_URL:
    try:
        init_db()
        seed_listings()
    except Exception as e:
        print("Warning during DB initialization:", e)

FRONTEND_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "frontend")

# WebSocket connection registry: user_id -> set of WebSocket connections
active_connections = {}

async def register_ws(user_id: int, websocket: WebSocket):
    if user_id not in active_connections:
        active_connections[user_id] = set()
    active_connections[user_id].add(websocket)

async def unregister_ws(user_id: int, websocket: WebSocket):
    if user_id in active_connections:
        active_connections[user_id].discard(websocket)
        if not active_connections[user_id]:
            del active_connections[user_id]

async def send_to_user(user_id: int, message: dict):
    if user_id in active_connections:
        dead_sockets = set()
        for ws in active_connections[user_id]:
            try:
                await ws.send_text(json.dumps(message))
            except Exception:
                dead_sockets.add(ws)
        for ws in dead_sockets:
            active_connections[user_id].discard(ws)

# --- REST Endpoints ---

async def api_register(request):
    try:
        data = await request.json()
        name = data.get("name", "").strip()
        email = data.get("email", "").strip()
        password = data.get("password", "")
        role = data.get("role", "buyer").strip().lower()
        phone = data.get("phone", "")

        if not name or not email or not password:
            return JSONResponse({"error": "Name, email, and password are required."}, status_code=400)
        
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
    new_token = create_jwt_token(payload["sub"], updated_profile["email"], new_role)
    return JSONResponse({
        "token": new_token,
        "user": serialize_dict(updated_profile)
    })

# Persistent Storage Bucket configuration
STORAGE_BUCKET_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "storage_bucket")
os.makedirs(STORAGE_BUCKET_DIR, exist_ok=True)

S3_BUCKET_NAME = os.getenv("S3_BUCKET_NAME") or os.getenv("AWS_S3_BUCKET")
AWS_ACCESS_KEY_ID = os.getenv("AWS_ACCESS_KEY_ID")
AWS_SECRET_ACCESS_KEY = os.getenv("AWS_SECRET_ACCESS_KEY")
AWS_ENDPOINT_URL = os.getenv("AWS_ENDPOINT_URL") or os.getenv("AWS_ENDPOINT_URL_S3") or os.getenv("S3_ENDPOINT_URL")
AWS_REGION = os.getenv("AWS_REGION", "us-east-2")

async def api_upload_image(request):
    auth_header = request.headers.get("Authorization", "")
    token = auth_header.replace("Bearer ", "") if "Bearer " in auth_header else auth_header
    payload = decode_jwt_token(token)
    if not payload:
        return JSONResponse({"error": "Unauthorized."}, status_code=401)

    try:
        data = await request.json()
        raw_file_data = data.get("file_data")
        raw_filename = data.get("filename", "property_plot.jpg")

        if not raw_file_data:
            return JSONResponse({"error": "No file data provided."}, status_code=400)

        # Strip data URL prefix if present (e.g. data:image/jpeg;base64,...)
        if "," in raw_file_data:
            raw_file_data = raw_file_data.split(",", 1)[1]

        file_bytes = base64.b64decode(raw_file_data)
        ext = os.path.splitext(raw_filename)[1] or ".jpg"
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
                public_url = f"{AWS_ENDPOINT_URL}/{S3_BUCKET_NAME}/{unique_name}" if AWS_ENDPOINT_URL else f"/bucket/{unique_name}"
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
    """List available users/contacts for chat & calling"""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT id, name, email, role, phone_masked, avatar, bio FROM users ORDER BY id ASC")
    users = [serialize_dict(dict(row)) for row in cursor.fetchall()]
    cursor.close()
    conn.close()
    return JSONResponse(users)

async def api_get_listings(request):
    conn = get_connection()
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
        d["images"] = json.loads(d["images"]) if isinstance(d["images"], str) else (d["images"] or [])
        d["features"] = json.loads(d["features"]) if isinstance(d["features"], str) else (d["features"] or [])
        listings.append(d)
    cursor.close()
    conn.close()
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
        d["images"] = json.loads(d["images"]) if isinstance(d["images"], str) else (d["images"] or [])
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
    
    my_id = payload["sub"]
    conn = get_connection()
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
    for r in cursor.fetchall():
        d = serialize_dict(dict(r))
        if d.get("listing_images"):
            try:
                d["listing_images"] = json.loads(d["listing_images"]) if isinstance(d["listing_images"], str) else d["listing_images"]
            except Exception:
                d["listing_images"] = []
        rows.append(d)
    cursor.close()
    conn.close()
    return JSONResponse(rows)

async def api_send_message(request):
    auth_header = request.headers.get("Authorization", "")
    token = auth_header.replace("Bearer ", "") if "Bearer " in auth_header else auth_header
    payload = decode_jwt_token(token)
    if not payload:
        return JSONResponse({"error": "Unauthorized."}, status_code=401)
    
    data = await request.json()
    sender_id = payload["sub"]
    receiver_id = int(data.get("receiver_id"))
    listing_id = data.get("listing_id")
    content = data.get("content", "").strip()
    message_type = data.get("message_type", "text")

    if not receiver_id or not content:
        return JSONResponse({"error": "Receiver and message content are required."}, status_code=400)
    
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO messages (sender_id, receiver_id, listing_id, content, message_type)
        VALUES (%s, %s, %s, %s, %s)
        RETURNING id;
    """, (sender_id, receiver_id, listing_id, content, message_type))
    msg_id = cursor.fetchone()["id"]
    conn.commit()

    cursor.execute("""
        SELECT m.*, 
               s.name as sender_name, s.avatar as sender_avatar,
               l.title as listing_title, l.price as listing_price, l.images as listing_images
        FROM messages m
        JOIN users s ON m.sender_id = s.id
        LEFT JOIN listings l ON m.listing_id = l.id
        WHERE m.id = %s
    """, (msg_id,))
    msg_data = serialize_dict(dict(cursor.fetchone()))
    if msg_data.get("listing_images"):
        try:
            msg_data["listing_images"] = json.loads(msg_data["listing_images"]) if isinstance(msg_data["listing_images"], str) else msg_data["listing_images"]
        except Exception:
            msg_data["listing_images"] = []
    cursor.close()
    conn.close()

    # Dispatch via WebSocket
    await send_to_user(receiver_id, {
        "type": "new_message",
        "message": msg_data
    })

    return JSONResponse(msg_data)

async def api_call_logs(request):
    auth_header = request.headers.get("Authorization", "")
    token = auth_header.replace("Bearer ", "") if "Bearer " in auth_header else auth_header
    payload = decode_jwt_token(token)
    if not payload:
        return JSONResponse({"error": "Unauthorized."}, status_code=401)
    
    user_id = payload["sub"]
    conn = get_connection()
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
    conn.close()
    return JSONResponse(logs)

# --- Real-Time WebSocket for Signaling (Audio / Video Calls & Live Chat) ---

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
                    await websocket.send_text(json.dumps({
                        "type": "authenticated",
                        "userId": authenticated_user_id
                    }))
                else:
                    await websocket.send_text(json.dumps({
                        "type": "auth_error",
                        "message": "Invalid token"
                    }))

            elif msg_type == "initiate_call":
                receiver_id = data.get("receiverId")
                call_type = data.get("callType", "video")
                listing_id = data.get("listingId")
                caller_info = data.get("callerInfo", {})
                
                await send_to_user(receiver_id, {
                    "type": "incoming_call",
                    "callerId": authenticated_user_id,
                    "callerInfo": caller_info,
                    "callType": call_type,
                    "listingId": listing_id
                })

            elif msg_type == "accept_call":
                caller_id = data.get("callerId")
                await send_to_user(caller_id, {
                    "type": "call_accepted",
                    "receiverId": authenticated_user_id
                })

            elif msg_type == "reject_call":
                caller_id = data.get("callerId")
                reason = data.get("reason", "Call declined")
                await send_to_user(caller_id, {
                    "type": "call_rejected",
                    "reason": reason
                })

            elif msg_type == "end_call":
                target_user_id = data.get("targetUserId")
                duration = data.get("duration", 0)
                call_type = data.get("callType", "video")
                if target_user_id:
                    await send_to_user(target_user_id, {
                        "type": "call_ended",
                        "by": authenticated_user_id
                    })
                if target_user_id and authenticated_user_id and DATABASE_URL:
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

            elif msg_type in ("webrtc_offer", "webrtc_answer", "ice_candidate"):
                target_id = data.get("targetUserId")
                if target_id:
                    await send_to_user(target_id, data)

    except WebSocketDisconnect:
        if authenticated_user_id:
            await unregister_ws(authenticated_user_id, websocket)
    except Exception:
        if authenticated_user_id:
            await unregister_ws(authenticated_user_id, websocket)

# --- Static Frontend Serving ---

async def serve_index(request):
    index_file = os.path.join(FRONTEND_DIR, "index.html")
    if os.path.exists(index_file):
        return FileResponse(index_file)
    return Response("LandConnect Frontend is building...", media_type="text/plain")

routes = [
    Route("/api/auth/register", api_register, methods=["POST"]),
    Route("/api/auth/login", api_login, methods=["POST"]),
    Route("/api/auth/me", api_me, methods=["GET"]),
    Route("/api/auth/role", api_switch_role, methods=["PUT"]),
    Route("/api/upload", api_upload_image, methods=["POST"]),
    Route("/api/users", api_users, methods=["GET"]),
    Route("/api/listings", api_get_listings, methods=["GET"]),
    Route("/api/listings", api_create_listing, methods=["POST"]),
    Route("/api/listings/my", api_my_listings, methods=["GET"]),
    Route("/api/listings/{id:int}", api_update_listing, methods=["PUT"]),
    Route("/api/listings/{id:int}", api_delete_listing, methods=["DELETE"]),
    Route("/api/messages/{user_id:int}", api_get_messages, methods=["GET"]),
    Route("/api/messages", api_send_message, methods=["POST"]),
    Route("/api/calls/history", api_call_logs, methods=["GET"]),
    WebSocketRoute("/ws", websocket_signaling),
    Route("/", serve_index),
]

middleware = [
    Middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
]

app = Starlette(debug=True, routes=routes, middleware=middleware)

if os.path.exists(FRONTEND_DIR):
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")

if os.path.exists(STORAGE_BUCKET_DIR):
    app.mount("/bucket", StaticFiles(directory=STORAGE_BUCKET_DIR), name="bucket")

if __name__ == "__main__":
    import uvicorn
    print("Starting LandConnect Server on http://0.0.0.0:8000...")
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)
