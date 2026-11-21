import os
import hashlib
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
        with conn.cursor() as cur:
            cur.execute("SELECT 1;")
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

def hash_password(password: str, salt: str = "landconnect_salt_2026") -> str:
    return hashlib.sha256((password + salt).encode('utf-8')).hexdigest()

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
        avatar TEXT,
        bio TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
    """)

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

    conn.commit()

    # Seed Default Demonstration Personas if users table is empty
    cursor.execute("SELECT COUNT(*) as count FROM users")
    res = cursor.fetchone()
    if res["count"] == 0:
        seed_users = [
            (
                "Aarav Patel (Buyer)",
                "buyer@landconnect.com",
                hash_password("buyer123"),
                "buyer",
                "+91 98*** **321",
                "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150&auto=format&fit=crop&q=80",
                "Individual investor looking for agricultural and residential land parcels."
            ),
            (
                "Vikram Malhotra (Seller)",
                "seller@landconnect.com",
                hash_password("seller123"),
                "seller",
                "+91 99*** **789",
                "https://images.unsplash.com/photo-1570295999919-56ceb5ecca61?w=150&auto=format&fit=crop&q=80",
                "Direct landowner offering prime commercial and farm plots in Bengaluru outskirts."
            ),
            (
                "Ananya Sharma (Broker)",
                "broker@landconnect.com",
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

    cursor.close()
    conn.close()

if __name__ == "__main__":
    init_db()
