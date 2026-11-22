import os
import jwt
import datetime
import re
from dotenv import load_dotenv
from database import get_connection, hash_password, verify_password

ENV_PATH = os.path.join(os.path.dirname(__file__), ".env")
load_dotenv(ENV_PATH)

JWT_SECRET = os.environ.get("JWT_SECRET", "landconnect_secure_jwt_token_key_2026")
JWT_ALGORITHM = os.environ.get("JWT_ALGORITHM", "HS256")

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
    except Exception:
        return None

def register_user(name: str, email: str, password: str, role: str, phone: str = ""):
    if role not in ("buyer", "seller", "broker"):
        return {"error": "Invalid role. Must be 'buyer', 'seller', or 'broker'."}
    
    # Enforce minimum 8 characters password length
    if not password or len(password) < 8:
        return {"error": "Password must be at least 8 characters long."}

    # Enforce valid mobile number (minimum 10 digits)
    phone_clean = re.sub(r'\D', '', phone or "").strip()
    if len(phone_clean) < 10:
        return {"error": "A valid 10-digit mobile number is required."}

    phone_10 = phone_clean[-10:]
    masked_phone = f"{phone_10[:3]}*** **{phone_10[-3:]}"
    clean_email = email.lower().strip()

    if not clean_email or "@" not in clean_email:
        return {"error": "A valid email address is required."}

    avatar_by_role = {
        "buyer": "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150&auto=format&fit=crop&q=80",
        "seller": "https://images.unsplash.com/photo-1570295999919-56ceb5ecca61?w=150&auto=format&fit=crop&q=80",
        "broker": "https://images.unsplash.com/photo-1580489944761-15a19d654956?w=150&auto=format&fit=crop&q=80"
    }

    conn = get_connection()
    cursor = conn.cursor()
    try:
        # Check email uniqueness
        cursor.execute("SELECT id FROM users WHERE LOWER(email) = %s", (clean_email,))
        if cursor.fetchone():
            return {"error": "An account with this email address already exists."}

        # Check mobile number uniqueness across all accounts
        cursor.execute("SELECT id FROM users WHERE phone = %s OR (phone IS NULL AND phone_masked = %s)", (phone_10, masked_phone))
        if cursor.fetchone():
            return {"error": "An account with this mobile number already exists. Each mobile number can only be used once."}

        password_hash = hash_password(password)
        cursor.execute("""
            INSERT INTO users (name, email, password_hash, role, phone_masked, phone, avatar)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            RETURNING id;
        """, (name, clean_email, password_hash, role, masked_phone, phone_10, avatar_by_role.get(role)))
        user_id = cursor.fetchone()["id"]
        conn.commit()
        token = create_jwt_token(user_id, role, clean_email)
        return {
            "token": token,
            "user": {
                "id": user_id,
                "name": name,
                "email": clean_email,
                "role": role,
                "phone_masked": masked_phone,
                "avatar": avatar_by_role.get(role)
            }
        }
    except Exception as e:
        conn.rollback()
        err_str = str(e).lower()
        if "users_email_key" in err_str or ("email" in err_str and "unique" in err_str):
            return {"error": "An account with this email address already exists."}
        if "phone" in err_str and "unique" in err_str:
            return {"error": "An account with this mobile number already exists."}
        return {"error": str(e)}
    finally:
        cursor.close()
        conn.close()

def login_user(email: str, password: str):
    conn = get_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT * FROM users WHERE LOWER(email) = %s", (email.lower().strip(),))
        user = cursor.fetchone()
        if not user:
            return {"error": "Invalid email or password."}
        
        is_valid, needs_rehash = verify_password(password, user["password_hash"])
        if not is_valid:
            return {"error": "Invalid email or password."}

        # Seamlessly auto-upgrade legacy hash to PBKDF2 on successful login
        if needs_rehash:
            try:
                new_hash = hash_password(password)
                cursor.execute("UPDATE users SET password_hash = %s WHERE id = %s", (new_hash, user["id"]))
                conn.commit()
            except Exception:
                pass
        
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
                "bio": user.get("bio")
            }
        }
    finally:
        cursor.close()
        conn.close()

def get_user_profile(user_id: int):
    conn = get_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT id, name, email, role, phone_masked, avatar, bio, created_at FROM users WHERE id = %s", (user_id,))
        user = cursor.fetchone()
        if user:
            d = dict(user)
            if "created_at" in d and d["created_at"]:
                d["created_at"] = str(d["created_at"])
            return d
        return None
    finally:
        cursor.close()
        conn.close()
