import sqlite3
import os
import json
import hashlib
import hmac

DB_PATH = os.path.join(os.path.dirname(__file__), "landconnect.db")

def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def hash_password(password: str, salt: str = "landconnect_salt_2026") -> str:
    return hashlib.sha256((password + salt).encode('utf-8')).hexdigest()

def init_db():
    conn = get_connection()
    cursor = conn.cursor()

    # Users table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('buyer', 'seller', 'broker')),
        phone_masked TEXT NOT NULL,
        avatar TEXT,
        bio TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)

    # Land Listings table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS listings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        price REAL NOT NULL,
        price_unit TEXT DEFAULT 'total',
        area_sqft REAL NOT NULL,
        property_type TEXT NOT NULL,
        location_address TEXT NOT NULL,
        city TEXT NOT NULL,
        state TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        images TEXT NOT NULL, -- JSON array of image URLs
        features TEXT, -- JSON array of features
        owner_id INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (owner_id) REFERENCES users(id)
    );
    """)

    # Messages table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id INTEGER NOT NULL,
        receiver_id INTEGER NOT NULL,
        listing_id INTEGER,
        content TEXT NOT NULL,
        message_type TEXT DEFAULT 'text',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_read INTEGER DEFAULT 0,
        FOREIGN KEY (sender_id) REFERENCES users(id),
        FOREIGN KEY (receiver_id) REFERENCES users(id),
        FOREIGN KEY (listing_id) REFERENCES listings(id)
    );
    """)

    # Call logs table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS call_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        caller_id INTEGER NOT NULL,
        receiver_id INTEGER NOT NULL,
        listing_id INTEGER,
        call_type TEXT NOT NULL CHECK(call_type IN ('audio', 'video')),
        status TEXT NOT NULL CHECK(status IN ('completed', 'missed', 'rejected', 'busy')),
        duration_seconds INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (caller_id) REFERENCES users(id),
        FOREIGN KEY (receiver_id) REFERENCES users(id)
    );
    """)

    conn.commit()

    # Seed demo users if empty
    cursor.execute("SELECT COUNT(*) as count FROM users")
    if cursor.fetchone()["count"] == 0:
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
        cursor.executemany("""
            INSERT INTO users (name, email, password_hash, role, phone_masked, avatar, bio)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, seed_users)
        conn.commit()
        print("Seeded 3 default test users (Buyer, Seller, Broker).")

    conn.close()

if __name__ == "__main__":
    init_db()
