import json
import os
from database import get_connection, DATABASE_URL

SAMPLE_LISTINGS = [
    {
        "title": "Prime 2-Acre Farm Land near Devanahalli",
        "description": "Fertile agricultural land with clear legal title, perimeter fencing, borewell connection, and 30ft road frontage. Just 15 mins drive from Kempegowda International Airport.",
        "price": 8500000,
        "price_unit": "total",
        "area_sqft": 87120,
        "property_type": "Agricultural",
        "location_address": "Devanahalli North, Near Airport Corridor",
        "city": "Bengaluru",
        "state": "Karnataka",
        "latitude": 13.2450,
        "longitude": 77.7126,
        "images": json.dumps([
            "https://images.unsplash.com/photo-1500382017468-9049fed747ef?w=800&auto=format&fit=crop&q=80",
            "https://images.unsplash.com/photo-1500076656116-558758c991c1?w=800&auto=format&fit=crop&q=80",
            "https://images.unsplash.com/photo-1464226184884-fa280b87c399?w=800&auto=format&fit=crop&q=80"
        ]),
        "features": json.dumps(["Borewell Water", "Fenced Boundary", "30ft Tar Road", "Clear RERA Title", "Electricity Available"]),
        "owner_id": 2 # Vikram Malhotra (Seller)
    },
    {
        "title": "Commercial Plot near Whitefield ITPL Extension",
        "description": "High-value commercial conversion approved plot suitable for tech park ancillary offices, logistics warehouse, or hotel development. Excellent highway visibility.",
        "price": 24000000,
        "price_unit": "total",
        "area_sqft": 15000,
        "property_type": "Commercial",
        "location_address": "ITPL Main Road Extension, Kadugodi",
        "city": "Bengaluru",
        "state": "Karnataka",
        "latitude": 12.9856,
        "longitude": 77.7499,
        "images": json.dumps([
            "https://images.unsplash.com/photo-1513836279014-a89f7a76ae86?w=800&auto=format&fit=crop&q=80",
            "https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?w=800&auto=format&fit=crop&q=80"
        ]),
        "features": json.dumps(["Commercial Approval", "Highway Facing", "High Footfall", "3-Phase Power", "Immediate Registration"]),
        "owner_id": 3 # Ananya Sharma (Broker)
    },
    {
        "title": "Gated Community Residential Villa Plot - Sarjapur",
        "description": "BMRDA approved villa site situated inside a serene green gated layout with underground drainage, club house amenities, and 24/7 security. Ready for immediate construction.",
        "price": 4800000,
        "price_unit": "total",
        "area_sqft": 2400,
        "property_type": "Residential",
        "location_address": "Sarjapur-Attibele Road, Near Greenwood High",
        "city": "Bengaluru",
        "state": "Karnataka",
        "latitude": 12.8614,
        "longitude": 77.7788,
        "images": json.dumps([
            "https://images.unsplash.com/photo-1592595896551-12b371d546d5?w=800&auto=format&fit=crop&q=80",
            "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=800&auto=format&fit=crop&q=80"
        ]),
        "features": json.dumps(["BMRDA Approved", "Clubhouse Access", "Underground Drainage", "Blacktop Roads", "Bank Loans Available"]),
        "owner_id": 3 # Ananya Sharma (Broker)
    },
    {
        "title": "Industrial Land Parcel - Peenya 4th Phase",
        "description": "Industrial zone land ready for light manufacturing, CNC machine setup, or cold storage facility. Ample truck maneuvering space and power substation nearby.",
        "price": 32000000,
        "price_unit": "total",
        "area_sqft": 20000,
        "property_type": "Industrial",
        "location_address": "Peenya Industrial Area Phase 4",
        "city": "Bengaluru",
        "state": "Karnataka",
        "latitude": 13.0334,
        "longitude": 77.5186,
        "images": json.dumps([
            "https://images.unsplash.com/photo-1586528116311-ad8dd3c8310d?w=800&auto=format&fit=crop&q=80",
            "https://images.unsplash.com/photo-1581091226825-a6a2a5aee158?w=800&auto=format&fit=crop&q=80"
        ]),
        "features": json.dumps(["KIADB Clearance", "Heavy Vehicle Access", "High Tension Power Line", "Water Connection", "Fire NOC Approved"]),
        "owner_id": 2 # Vikram Malhotra (Seller)
    }
]

def seed_listings():
    if not DATABASE_URL:
        return
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) as count FROM listings")
    res = cursor.fetchone()
    if res["count"] == 0:
        for listing in SAMPLE_LISTINGS:
            cursor.execute("""
                INSERT INTO listings (title, description, price, price_unit, area_sqft, property_type,
                                      location_address, city, state, latitude, longitude, images, features, owner_id)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """, (
                listing["title"], listing["description"], listing["price"], listing["price_unit"],
                listing["area_sqft"], listing["property_type"], listing["location_address"],
                listing["city"], listing["state"], listing["latitude"], listing["longitude"],
                listing["images"], listing["features"], listing["owner_id"]
            ))
        conn.commit()
        print(f"Seeded {len(SAMPLE_LISTINGS)} sample land listings into Neon PostgreSQL.")
    cursor.close()
    conn.close()

if __name__ == "__main__":
    seed_listings()
