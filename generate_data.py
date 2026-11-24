from pathlib import Path
import math

import numpy as np
import pandas as pd

np.random.seed(42)

# Always write next to this script, whatever folder you run it from.
ROOT = Path(__file__).resolve().parent
OUT_FILE = ROOT / "data" / "campus_energy.csv"       # the path the engine reads
OUT_FILE.parent.mkdir(parents=True, exist_ok=True)   # FIX 1: create the folder if missing

# building: (nominal kW, night floor, peak hour, spread in hours)
# Same load shape as the dashboard simulation, so live readings match this data.
buildings = {
    "Academic Block": (25, 0.25, 11.0, 3.5),
    "Laboratory":     (40, 0.35, 13.0, 4.0),
    "Library":        (18, 0.15, 15.0, 4.0),
    "Administration": (15, 0.20, 11.5, 3.0),
    "Hostel":         (30, 0.45, 21.0, 4.5),
}

OCCUPANCY_FACTOR = 0.4 + 0.6 * 0.70   # 0.82 = dashboard default occupancy of 70%


def load_shape(night, peak, spread, hour):
    d = abs(hour - peak)
    d = min(d, 24 - d)                 # wrap around midnight
    return night + (1 - night) * math.exp(-(d * d) / (2 * spread ** 2))


timestamps = pd.date_range(start="2026-10-01", periods=30 * 24, freq="h")

rows = []

for building, (base, night, peak, spread) in buildings.items():
    for time in timestamps:
        expected = base * OCCUPANCY_FACTOR * load_shape(night, peak, spread, time.hour)
        usage = expected * (1 + np.random.uniform(-0.03, 0.03))   # +/-3% noise
        rows.append([time, building, round(max(usage, 1), 2)])

# FIX 2: column order matches the engine's CSV (timestamp, building, energy_kwh)
df = pd.DataFrame(rows, columns=["timestamp", "building", "energy_kwh"])

# Inject unusual consumption events across different buildings.
anomaly_events = [
    ("Academic Block", "2026-10-03 14:00:00", 2.8),
    ("Laboratory", "2026-10-07 11:00:00", 2.6),
    ("Library", "2026-10-12 16:00:00", 2.7),
    ("Administration", "2026-10-19 10:00:00", 2.8),
    ("Hostel", "2026-10-24 21:00:00", 2.6),
]

for building, timestamp, multiplier in anomaly_events:
    mask = (df["building"] == building) & (df["timestamp"] == pd.Timestamp(timestamp))
    df.loc[mask, "energy_kwh"] *= multiplier

df["energy_kwh"] = df["energy_kwh"].round(2)

df.to_csv(OUT_FILE, index=False)

print("\nARKAGRID DATA GENERATION")
print("------------------------")
print("Dataset created successfully!")
print("Saved to:", OUT_FILE)
print("Buildings:", df["building"].nunique())
print("Total readings:", len(df))
print("Injected unusual events:", len(anomaly_events))
print("\nPreview:")
print(df.head())
