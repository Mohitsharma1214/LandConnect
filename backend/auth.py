import jwt
import datetime
from database import get_connection, hash_password

JWT_SECRET = "landconnect_secure_jwt_token_key_2026"
JWT_ALGORITHM = "HS256"

def create_jwt_token(user_id: int, role: str, email: str) -> str:
    payload = {
        "sub": str(user_id),
        "role": role,
        "email": email,
        "exp": datetime.datetime.utcnow() + datetime.timedelta(days=7),
        "iat": datetime.datetime.utcnow()
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)

def decode_jwt_token(token: str):
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        payload["sub"] = int(payload["sub"])
        return payload
    except Exception as e:
        return None

def register_user(name: str, email: str, password: str, role: str, phone: str = ""):
    if role not in ("buyer", "seller", "broker"):
        return {"error": "Invalid role. Must be 'buyer', 'seller', or 'broker'."}
    
    # Mask phone number to protect privacy
    if phone and len(phone) >= 10:
        clean_phone = phone.strip()
        masked_phone = f"{clean_phone[:3]}*** **{clean_phone[-3:]}"
    else:
        masked_phone = "+91 98*** **000"

    avatar_by_role = {
        "buyer": "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150&auto=format&fit=crop&q=80",
        "seller": "https://images.unsplash.com/photo-1570295999919-56ceb5ecca61?w=150&auto=format&fit=crop&q=80",
        "broker": "https://images.unsplash.com/photo-1580489944761-15a19d654956?w=150&auto=format&fit=crop&q=80"
    }

    conn = get_connection()
    cursor = conn.cursor()
    try:
        password_hash = hash_password(password)
        cursor.execute("""
            INSERT INTO users (name, email, password_hash, role, phone_masked, avatar)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (name, email.lower().strip(), password_hash, role, masked_phone, avatar_by_role.get(role)))
        conn.commit()
        user_id = cursor.lastrowid
        token = create_jwt_token(user_id, role, email)
        return {
            "token": token,
            "user": {
                "id": user_id,
                "name": name,
                "email": email,
                "role": role,
                "phone_masked": masked_phone,
                "avatar": avatar_by_role.get(role)
            }
        }
    except Exception as e:
        if "UNIQUE constraint failed: users.email" in str(e):
            return {"error": "An account with this email already exists."}
        return {"error": str(e)}
    finally:
        conn.close()

def login_user(email: str, password: str):
    conn = get_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT * FROM users WHERE LOWER(email) = ?", (email.lower().strip(),))
        user = cursor.fetchone()
        if not user:
            return {"error": "Invalid email or password."}
        
        password_hash = hash_password(password)
        if user["password_hash"] != password_hash:
            return {"error": "Invalid email or password."}
        
        token = create_jwt_token(user["id"], user["role"], user["email"])
        return {
            "token": token,
            "user": {
                "id": user["id"],
                "name": user["name"],
                "email": user["email"],
                "role": user["role"],
                "phone_masked": user["phone_masked"],
                "avatar": user["avatar"],
                "bio": user["bio"]
            }
        }
    finally:
        conn.close()

def get_user_profile(user_id: int):
    conn = get_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT id, name, email, role, phone_masked, avatar, bio, created_at FROM users WHERE id = ?", (user_id,))
        user = cursor.fetchone()
        if user:
            return dict(user)
        return None
    finally:
        conn.close()
