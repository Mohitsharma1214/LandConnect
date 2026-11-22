import os
import hashlib
import hmac
import secrets
import json
import psycopg2
from psycopg2.pool import ThreadedConnectionPool
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv

# Load environment variables from .env
ENV_PATH = os.path.join(os.path.dirname(__file__), ".env")
load_dotenv(ENV_PATH)

DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()

_pool = None

def is_connection_alive(conn):
    try:
        if conn.closed != 0:
            return False
        return True
    except Exception:
        return False

class PooledConnectionWrapper:
    def __init__(self, conn, pool):
        self._conn = conn
        self._pool = pool
        self._closed = False

    def close(self):
        if not self._closed:
            self._closed = True
            is_broken = False
            try:
                if self._conn.closed != 0:
                    is_broken = True
                else:
                    self._conn.rollback()
            except Exception:
                is_broken = True
            
            try:
                self._pool.putconn(self._conn, close=is_broken)
            except Exception:
                pass

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()

    def __getattr__(self, name):
        return getattr(self._conn, name)

def get_connection():
    global _pool
    if not DATABASE_URL:
        raise ValueError("DATABASE_URL is not set. Please provide your Neon DB PostgreSQL connection string in backend/.env")
    
    if _pool is None:
        try:
            _pool = ThreadedConnectionPool(minconn=1, maxconn=15, dsn=DATABASE_URL, cursor_factory=RealDictCursor)
        except Exception as e:
            print(f"Warning during connection pool init: {e}")
            _pool = None

    if _pool is not None:
        # Check health of retrieved connection; prune if server closed idle connection
        for _ in range(3):
            try:
                conn = _pool.getconn()
                if is_connection_alive(conn):
                    return PooledConnectionWrapper(conn, _pool)
                else:
                    _pool.putconn(conn, close=True)
            except Exception:
                pass

    return psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)

def hash_password(password: str) -> str:
    """
    Secure password hashing using PBKDF2-HMAC-SHA256 with 100,000 iterations
    and a cryptographically random 16-byte salt.
    """
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt.encode('utf-8'), 100000)
    return f"pbkdf2:sha256:100000${salt}${dk.hex()}"

def verify_password(password: str, stored_hash: str) -> tuple[bool, bool]:
    """
    Verifies a password against the stored hash.
    Returns (is_valid, needs_rehash).
    Supports both secure PBKDF2 hashes and legacy SHA-256 hashes for seamless backwards compatibility.
    """
    if not stored_hash or not password:
        return False, False

    if stored_hash.startswith("pbkdf2:sha256:"):
        try:
            parts = stored_hash.split("$")
            if len(parts) == 3:
                iterations = int(parts[0].split(":")[2])
                salt = parts[1]
                target_hash = parts[2]
                computed = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt.encode('utf-8'), iterations).hex()
                return hmac.compare_digest(computed, target_hash), False
        except Exception:
            return False, False

    # Legacy SHA-256 fallback (landconnect_salt_2026)
    legacy_hash = hashlib.sha256((password + "landconnect_salt_2026").encode('utf-8')).hexdigest()
    if hmac.compare_digest(legacy_hash, stored_hash):
        return True, True  # Valid, but needs automatic upgrade to PBKDF2

    return False, False

def init_db():
    if not DATABASE_URL:
        print("Waiting for Neon DB DATABASE_URL to be set...")
        return

    conn = get_connection()
    cursor = conn.cursor()

    # Users Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL CHECK(role IN ('buyer', 'seller', 'broker')),
        phone_masked VARCHAR(50) NOT NULL,
        phone VARCHAR(50),
        avatar TEXT,
        bio TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
    """)
    cursor.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(50);")

    # Land Listings Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS listings (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT NOT NULL,
        price NUMERIC NOT NULL,
        price_unit VARCHAR(50) DEFAULT 'total',
        area_sqft NUMERIC NOT NULL,
        property_type VARCHAR(100) NOT NULL,
        location_address TEXT NOT NULL,
        city VARCHAR(100) NOT NULL,
        state VARCHAR(100) NOT NULL,
        latitude DOUBLE PRECISION NOT NULL,
        longitude DOUBLE PRECISION NOT NULL,
        images TEXT NOT NULL,
        features TEXT,
        owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
    """)

    # Messages Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        listing_id INTEGER REFERENCES listings(id) ON DELETE SET NULL,
        content TEXT NOT NULL,
        message_type VARCHAR(50) DEFAULT 'text',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        is_read INTEGER DEFAULT 0
    );
    """)

    # Call Logs Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS call_logs (
        id SERIAL PRIMARY KEY,
        caller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        listing_id INTEGER REFERENCES listings(id) ON DELETE SET NULL,
        call_type VARCHAR(20) NOT NULL CHECK(call_type IN ('audio', 'video')),
        status VARCHAR(20) NOT NULL CHECK(status IN ('completed', 'missed', 'rejected', 'busy')),
        duration_seconds INTEGER DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
    """)

    # Virtual Meeting Room History Tables
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS meeting_room_logs (
        id SERIAL PRIMARY KEY,
        room_id VARCHAR(100) UNIQUE NOT NULL,
        host_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(255) DEFAULT 'LandConnect Virtual Meeting Room',
        duration_seconds INTEGER DEFAULT 0,
        participants_summary TEXT DEFAULT '',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS meeting_room_participants (
        id SERIAL PRIMARY KEY,
        room_id VARCHAR(100) NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_name VARCHAR(150),
        user_avatar TEXT,
        user_role VARCHAR(50),
        joined_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT unique_room_user UNIQUE(room_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_meeting_room_id ON meeting_room_logs (room_id);
    CREATE INDEX IF NOT EXISTS idx_meeting_part_user ON meeting_room_participants (user_id);
    """)

    cursor.execute("""
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages (sender_id, receiver_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_rev ON messages (receiver_id, sender_id, created_at);
    """)

    conn.commit()

    # Backfill past meeting rooms from messages table if needed
    try:
        cursor.execute("SELECT COUNT(*) as count FROM meeting_room_logs")
        if cursor.fetchone()["count"] == 0:
            cursor.execute("""
                SELECT m.id, m.sender_id, m.receiver_id, m.content, m.created_at,
                       u1.name as s_name, u1.role as s_role, u1.avatar as s_avatar,
                       u2.name as r_name, u2.role as r_role, u2.avatar as r_avatar
                FROM messages m
                JOIN users u1 ON m.sender_id = u1.id
                JOIN users u2 ON m.receiver_id = u2.id
                WHERE m.message_type = 'meeting'
                ORDER BY m.id ASC
            """)
            past_meetings = cursor.fetchall()
            for pm in past_meetings:
                content = pm["content"] or ""
                import re
                match = re.search(r'(?:Room Code:|room=)\s*([a-zA-Z0-9_\-]+)', content, re.I)
                r_id = match.group(1) if match else "land-deal-room"
                parts_str = f"{pm['s_name']} ({pm['s_role'].title()}), {pm['r_name']} ({pm['r_role'].title()})"
                cursor.execute("""
                    INSERT INTO meeting_room_logs (room_id, host_id, title, duration_seconds, participants_summary, created_at)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    ON CONFLICT (room_id) DO UPDATE SET 
                        participants_summary = EXCLUDED.participants_summary,
                        updated_at = EXCLUDED.created_at;
                """, (r_id, pm["sender_id"], "Virtual Meeting Room", 185, parts_str, pm["created_at"]))

                cursor.execute("""
                    INSERT INTO meeting_room_participants (room_id, user_id, user_name, user_avatar, user_role, joined_at)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    ON CONFLICT (room_id, user_id) DO NOTHING;
                """, (r_id, pm["sender_id"], pm["s_name"], pm["s_avatar"], pm["s_role"], pm["created_at"]))

                cursor.execute("""
                    INSERT INTO meeting_room_participants (room_id, user_id, user_name, user_avatar, user_role, joined_at)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    ON CONFLICT (room_id, user_id) DO NOTHING;
                """, (r_id, pm["receiver_id"], pm["r_name"], pm["r_avatar"], pm["r_role"], pm["created_at"]))
            conn.commit()
    except Exception as e:
        print("Backfill meeting rooms error:", e)

    # Seed Default Demonstration Personas if users table is empty
    cursor.execute("SELECT COUNT(*) as count FROM users")
    res = cursor.fetchone()
    if res["count"] == 0:
        seed_users = [
            (
                "Aarav Patel (Buyer)",
                "buyer@landconnect.si",
                hash_password("buyer123"),
                "buyer",
                "+91 98*** **321",
                "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150&auto=format&fit=crop&q=80",
                "Individual investor looking for agricultural and residential land parcels."
            ),
            (
                "Vikram Malhotra (Seller)",
                "seller@landconnect.si",
                hash_password("seller123"),
                "seller",
                "+91 99*** **789",
                "https://images.unsplash.com/photo-1570295999919-56ceb5ecca61?w=150&auto=format&fit=crop&q=80",
                "Direct landowner offering prime commercial and farm plots in Bengaluru outskirts."
            ),
            (
                "Ananya Sharma (Broker)",
                "broker@landconnect.si",
                hash_password("broker123"),
                "broker",
                "+91 97*** **456",
                "https://images.unsplash.com/photo-1580489944761-15a19d654956?w=150&auto=format&fit=crop&q=80",
                "Certified RERA Real Estate Broker specializing in greenfield projects & high ROI land."
            )
        ]
        for u in seed_users:
            cursor.execute("""
                INSERT INTO users (name, email, password_hash, role, phone_masked, avatar, bio)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (email) DO NOTHING
            """, u)
        conn.commit()
        print("Seeded demo users into Neon PostgreSQL.")

    try:
        cursor.execute("UPDATE users SET email = 'buyer@landconnect.si' WHERE email = 'buyer@landconnect.com';")
        cursor.execute("UPDATE users SET email = 'seller@landconnect.si' WHERE email = 'seller@landconnect.com';")
        cursor.execute("UPDATE users SET email = 'broker@landconnect.si' WHERE email = 'broker@landconnect.com';")
        conn.commit()
    except Exception:
        pass

    cursor.close()
    conn.close()

if __name__ == "__main__":
    init_db()
