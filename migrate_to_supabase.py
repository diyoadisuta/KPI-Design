"""
Migrate data.json ke Supabase PostgreSQL
Script backup — bisa juga dilakukan via tombol "Sync ke DB" di dashboard

Usage:
  pip install requests
  python migrate_to_supabase.py
"""

import json
import requests
import sys

# Supabase Configuration
SUPABASE_URL = 'https://nechghbntktjjaoqaezk.supabase.co'
SUPABASE_KEY = 'sb_publishable_cjre4ilGtKJIuwG3fj_t1g_oEvb3RIu'
TABLE = 'kpi_projects'

HEADERS = {
    'apikey': SUPABASE_KEY,
    'Authorization': f'Bearer {SUPABASE_KEY}',
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal'
}

# Field mapping: camelCase (JSON) -> snake_case (PostgreSQL)
FIELD_MAP = {
    'title': 'title',
    'customer': 'customer',
    'productDescription': 'product_description',
    'orderedQty': 'ordered_qty',
    'deliveredQty': 'delivered_qty',
    'assignedTo': 'assigned_to',
    'sales': 'sales',
    'design': 'design',
    'tags': 'tags',
    'stage': 'stage',
    'orderDate': 'order_date',
    'deadline': 'deadline',
    'fileIn': 'file_in',
    'progressAW': 'progress_aw',
    'sendAWkeCust': 'send_aw_ke_cust',
    'accAWdariCust': 'acc_aw_dari_cust',
    'sendKeDigitalPrint': 'send_ke_digital_print',
    'receiveDigital': 'receive_digital',
    'sendDigitalKeCust': 'send_digital_ke_cust',
    'accDigitalDariCust': 'acc_digital_dari_cust',
    'progressDummy': 'progress_dummy',
    'sendDummy': 'send_dummy',
    'accDummyDariCust': 'acc_dummy_dari_cust',
    'progressLayout': 'progress_layout',
    'lemparFileKeCTP': 'lempar_file_ke_ctp',
    'progressLayoutCTP': 'progress_layout_ctp',
    'doneLayoutCTP': 'done_layout_ctp',
    'review': 'review',
    'keluarPlat': 'keluar_plat',
    'progressRevisiAW': 'progress_revisi_aw',
    'progressRevisiDummy': 'progress_revisi_dummy',
    'manufactureBaru': 'manufacture_baru',
    'manufactureRepeat': 'manufacture_repeat',
    'manufactureRepeatPerubahan': 'manufacture_repeat_perubahan',
}

def map_record(record):
    """Convert camelCase JSON record to snake_case DB row."""
    row = {}
    for js_key, db_key in FIELD_MAP.items():
        val = record.get(js_key)
        # Convert empty strings to None for database
        if val == '' or val == 'False':
            val = None
        row[db_key] = val
    return row

def main():
    # Load data.json
    print("📂 Loading data.json...")
    try:
        with open('data.json', 'r', encoding='utf-8') as f:
            data = json.load(f)
        print(f"   ✅ {len(data)} records loaded")
    except FileNotFoundError:
        print("   ❌ data.json tidak ditemukan!")
        sys.exit(1)

    # Test connection
    print("\n🔌 Testing Supabase connection...")
    url = f"{SUPABASE_URL}/rest/v1/{TABLE}?select=count"
    try:
        resp = requests.get(url, headers={**HEADERS, 'Prefer': 'count=exact'})
        if resp.status_code == 200:
            print(f"   ✅ Connected! Current rows: {resp.headers.get('content-range', 'unknown')}")
        elif resp.status_code == 404:
            print("   ❌ Tabel 'kpi_projects' belum dibuat!")
            print("   Jalankan schema.sql di Supabase SQL Editor terlebih dahulu.")
            sys.exit(1)
        else:
            print(f"   ❌ Error: {resp.status_code} - {resp.text}")
            sys.exit(1)
    except requests.exceptions.ConnectionError:
        print("   ❌ Tidak bisa terhubung ke Supabase. Periksa internet.")
        sys.exit(1)

    # Clear existing data
    print("\n🗑️  Clearing existing data...")
    delete_url = f"{SUPABASE_URL}/rest/v1/{TABLE}?id=not.is.null"
    resp = requests.delete(delete_url, headers=HEADERS)
    if resp.status_code in (200, 204):
        print("   ✅ Data lama dihapus")
    else:
        print(f"   ⚠️  Delete response: {resp.status_code} - {resp.text}")

    # Batch insert
    print(f"\n📤 Uploading {len(data)} records...")
    batch_size = 100
    total_inserted = 0

    for i in range(0, len(data), batch_size):
        batch = data[i:i + batch_size]
        db_rows = [map_record(r) for r in batch]

        insert_url = f"{SUPABASE_URL}/rest/v1/{TABLE}"
        resp = requests.post(insert_url, headers=HEADERS, json=db_rows)

        if resp.status_code in (200, 201):
            total_inserted += len(batch)
            batch_num = (i // batch_size) + 1
            total_batches = (len(data) + batch_size - 1) // batch_size
            print(f"   ✅ Batch {batch_num}/{total_batches}: {len(batch)} records inserted ({total_inserted}/{len(data)})")
        else:
            print(f"   ❌ Batch error: {resp.status_code} - {resp.text[:200]}")
            sys.exit(1)

    # Verify
    print(f"\n✅ Migrasi selesai! {total_inserted} records berhasil diupload.")
    print("   Refresh dashboard untuk melihat data dari Supabase.")

if __name__ == '__main__':
    main()
