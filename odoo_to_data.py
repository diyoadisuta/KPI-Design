"""
Odoo to KPI Dashboard Data Converter

Downloads project task data from Odoo and converts it to the data.json format
used by the KPI Design Dashboard (Divisi Design).

Usage: python odoo_to_data.py
       python odoo_to_data.py --output data.json    (overwrite data.json directly)

This script:
1. Authenticates with Odoo via JSON-RPC API
2. Downloads all project tasks (project_id = 4, "All Project")
3. Downloads all task.dojob records (workflow timestamps)
4. Maps Odoo fields to the KPI dashboard data.json format
5. Saves the converted data
"""

import json
import urllib.request
import os
import sys
import io
from datetime import datetime

# Force UTF-8 output on Windows
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

# ===== Configuration =====
ODOO_URL = 'http://192.168.1.102:10014/jsonrpc'
ODOO_DB = 'live8'
ODOO_USER = 'dio'
ODOO_API_KEY = 'fb9cc214a89d16ab2e9ccfc903fdee0bd6aa84fe'

# Only fetch tasks from "All Project" (project_id = 4)
PROJECT_ID = 4

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# ===== task.do ID -> data.json field name mapping =====
DOJOB_FIELD_MAP = {
    1:  'fileIn',               # File In
    2:  'progressAW',           # Progress AW
    3:  'sendAWkeCust',         # Send AW ke Cust
    4:  'accAWdariCust',        # ACC AW dari Cust
    5:  'sendKeDigitalPrint',   # Send ke Digital Print
    6:  'receiveDigital',       # Receive Digital
    7:  'sendDigitalKeCust',    # Send Digital ke Cust
    8:  'accDigitalDariCust',   # ACC Digital dari Cust
    9:  'progressDummy',        # Progress Dummy
    10: 'sendDummy',            # Send Dummy
    11: 'accDummyDariCust',     # ACC Dummy dari Cust
    12: 'progressLayout',       # Progress Layout
    13: 'lemparFileKeCTP',      # Lempar file ke CTP
    14: 'progressLayoutCTP',    # Progress Layout CTP
    15: 'doneLayoutCTP',        # Done Layout CTP
    16: 'review',               # Review
    17: 'keluarPlat',           # Keluar Plat
    21: 'progressRevisiAW',     # Progress Revisi AW
    22: 'progressRevisiDummy',  # Progress Revisi Dummy
}

# Tag IDs
TAG_BARU = 26
TAG_REPEAT = 25


def json_rpc(service, method, args):
    """Send a JSON-RPC request to Odoo."""
    payload = json.dumps({
        'jsonrpc': '2.0',
        'method': 'call',
        'params': {
            'service': service,
            'method': method,
            'args': args,
        },
        'id': 1,
    }).encode('utf-8')

    req = urllib.request.Request(
        ODOO_URL,
        data=payload,
        headers={'Content-Type': 'application/json'},
    )

    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read().decode('utf-8'))

    if 'error' in data:
        raise Exception('Odoo error: ' + json.dumps(data['error'], indent=2))

    return data.get('result')


def odoo_datetime_to_iso(val):
    """Convert Odoo datetime string (e.g. '2026-06-17 08:26:35') to ISO format.
    Returns None if val is falsy."""
    if not val:
        return None
    # Odoo datetimes are in UTC, format: 'YYYY-MM-DD HH:MM:SS'
    try:
        dt = datetime.strptime(val, '%Y-%m-%d %H:%M:%S')
        return dt.strftime('%Y-%m-%dT%H:%M:%S')
    except (ValueError, TypeError):
        return val if val else None


def odoo_date_to_iso(val):
    """Convert Odoo date string (e.g. '2026-06-17') to ISO format.
    Returns None if val is falsy."""
    if not val:
        return None
    try:
        dt = datetime.strptime(val, '%Y-%m-%d')
        return dt.strftime('%Y-%m-%dT00:00:00')
    except (ValueError, TypeError):
        return val if val else None


def extract_name(val):
    """Extract display name from an Odoo many2one field [id, name]."""
    if isinstance(val, list) and len(val) == 2:
        return val[1]
    return '' if not val else str(val)


def convert_task(task, dojob_map):
    """Convert a single Odoo task record to data.json format."""
    task_id = task['id']

    # Get the stage name
    stage_name = extract_name(task.get('stage_id'))

    # Get customer name
    customer = extract_name(task.get('partner_id'))

    # Get assigned user
    assigned_to = extract_name(task.get('user_id'))

    # Get sales person
    sales = extract_name(task.get('user_sales'))

    # Get designer
    design = extract_name(task.get('user_design'))

    # Get tag names for manufacture type
    tag_ids = task.get('tag_ids', [])
    manufacture_baru = TAG_BARU in tag_ids
    manufacture_repeat = TAG_REPEAT in tag_ids
    # If neither tag, check if it has a stage that implies repeat with changes
    manufacture_repeat_perubahan = False

    # Determine tags string
    tags_list = []
    if manufacture_baru:
        tags_list.append('Baru')
    if manufacture_repeat:
        tags_list.append('Repeat')
    tags = ', '.join(tags_list)

    # Build the dojob timestamps for this task
    dojob_records = dojob_map.get(task_id, [])
    dojob_timestamps = {}
    for dj in dojob_records:
        do_id = dj['task_do_id'][0] if isinstance(dj['task_do_id'], list) else dj['task_do_id']
        field_name = DOJOB_FIELD_MAP.get(do_id)
        if field_name:
            dojob_timestamps[field_name] = odoo_datetime_to_iso(dj.get('do_date'))

    # Build the output record
    record = {
        'title': task.get('name', ''),
        'customer': customer,
        'productDescription': task.get('product_description', '') or '',
        'orderedQty': int(task.get('ordered_qty', 0)),
        'deliveredQty': int(task.get('delivered_qty', 0)),
        'assignedTo': assigned_to,
        'sales': sales.lower() if sales else '',
        'design': design.lower() if design else '',
        'tags': tags,
        'stage': stage_name,
        'orderDate': odoo_date_to_iso(task.get('sale_order_date')),
        'deadline': odoo_date_to_iso(task.get('date_deadline')),

        # Workflow timestamps from dojob
        'fileIn': dojob_timestamps.get('fileIn'),
        'progressAW': dojob_timestamps.get('progressAW'),
        'sendAWkeCust': dojob_timestamps.get('sendAWkeCust'),
        'accAWdariCust': dojob_timestamps.get('accAWdariCust'),
        'sendKeDigitalPrint': dojob_timestamps.get('sendKeDigitalPrint'),
        'receiveDigital': dojob_timestamps.get('receiveDigital'),
        'sendDigitalKeCust': dojob_timestamps.get('sendDigitalKeCust'),
        'accDigitalDariCust': dojob_timestamps.get('accDigitalDariCust'),
        'progressDummy': dojob_timestamps.get('progressDummy'),
        'sendDummy': dojob_timestamps.get('sendDummy'),
        'accDummyDariCust': dojob_timestamps.get('accDummyDariCust'),
        'progressLayout': dojob_timestamps.get('progressLayout'),
        'lemparFileKeCTP': dojob_timestamps.get('lemparFileKeCTP'),
        'progressLayoutCTP': dojob_timestamps.get('progressLayoutCTP'),
        'doneLayoutCTP': dojob_timestamps.get('doneLayoutCTP'),
        'review': dojob_timestamps.get('review'),
        'keluarPlat': dojob_timestamps.get('keluarPlat'),
        'progressRevisiAW': dojob_timestamps.get('progressRevisiAW'),
        'progressRevisiDummy': dojob_timestamps.get('progressRevisiDummy'),

        # Manufacture flags
        'manufactureBaru': manufacture_baru,
        'manufactureRepeat': manufacture_repeat,
        'manufactureRepeatPerubahan': manufacture_repeat_perubahan,
    }

    return record


def main():
    # Parse arguments
    output_file = 'odoo_data.json'
    if '--output' in sys.argv:
        idx = sys.argv.index('--output')
        if idx + 1 < len(sys.argv):
            output_file = sys.argv[idx + 1]

    print('=' * 60)
    print('  Odoo -> KPI Dashboard Data Converter')
    print('=' * 60)

    # Step 1: Authenticate
    print('\n[AUTH] Authenticating with Odoo...')
    uid = json_rpc('common', 'authenticate', [ODOO_DB, ODOO_USER, ODOO_API_KEY, {}])
    if not uid:
        print('[ERROR] Authentication failed!')
        sys.exit(1)
    print('[OK] Authenticated as UID: {}'.format(uid))

    # Step 2: Fetch tasks from "All Project"
    # Filter: active = true/false (include archived), created on >= 2026-01-02
    DATE_FROM = '2026-01-02 00:00:00'
    domain = [
        ['project_id', '=', PROJECT_ID],
        ['create_date', '>=', DATE_FROM],
    ]
    print('\n[TASKS] Fetching tasks from "All Project" (id={})...'.format(PROJECT_ID))
    print('   Filter: active=true/false, create_date >= {}'.format(DATE_FROM))

    # Use active_test=False in context to include both active AND archived tasks
    tasks = json_rpc('object', 'execute_kw', [
        ODOO_DB, uid, ODOO_API_KEY,
        'project.task', 'search_read',
        [domain],
        {
            'order': 'sale_order_date desc, create_date desc',
            'context': {'active_test': False},
        }
    ])
    active_count = sum(1 for t in tasks if t.get('active'))
    archived_count = sum(1 for t in tasks if not t.get('active'))
    print('[OK] Fetched {} tasks (active: {}, archived: {})'.format(
        len(tasks), active_count, archived_count))

    # Step 3: Collect all task_dojob IDs
    print('\n[DOJOB] Collecting workflow timestamps...')
    all_dojob_ids = []
    for t in tasks:
        all_dojob_ids.extend(t.get('task_dojob', []))
    print('   Total dojob records to fetch: {}'.format(len(all_dojob_ids)))

    # Step 4: Fetch all dojob records (paginated)
    dojob_records = []
    BATCH = 500
    for i in range(0, len(all_dojob_ids), BATCH):
        batch_ids = all_dojob_ids[i:i + BATCH]
        batch = json_rpc('object', 'execute_kw', [
            ODOO_DB, uid, ODOO_API_KEY,
            'task.dojob', 'search_read',
            [[['id', 'in', batch_ids]]],
            {
                'fields': ['id', 'task_do_id', 'do_date', 'task_id', 'description'],
            }
        ])
        dojob_records.extend(batch)
        print('   Fetched {} / {} dojob records...'.format(len(dojob_records), len(all_dojob_ids)))

    # Build a map: task_id -> [dojob_records]
    dojob_map = {}
    for dj in dojob_records:
        tid = dj['task_id'][0] if isinstance(dj['task_id'], list) else dj['task_id']
        dojob_map.setdefault(tid, []).append(dj)

    print('[OK] Mapped dojob records for {} tasks'.format(len(dojob_map)))

    # Step 5: Convert all tasks
    print('\n[CONVERT] Converting to KPI dashboard format...')
    converted = []
    for task in tasks:
        record = convert_task(task, dojob_map)
        converted.append(record)

    # Step 6: Save output
    output_path = os.path.join(SCRIPT_DIR, output_file)
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(converted, f, indent=2, ensure_ascii=False)

    file_size_kb = os.path.getsize(output_path) / 1024
    print('\n[OK] Saved {} records to {}'.format(len(converted), output_file))
    print('   File size: {:.1f} KB'.format(file_size_kb))

    # Step 7: Summary statistics
    designers_count = {}
    stages_count = {}
    for rec in converted:
        d = rec.get('design', '') or 'unassigned'
        designers_count[d] = designers_count.get(d, 0) + 1
        s = rec.get('stage', '') or 'unknown'
        stages_count[s] = stages_count.get(s, 0) + 1

    print('\n[STATS] By Designer:')
    for name, count in sorted(designers_count.items(), key=lambda x: -x[1]):
        print('   {}: {} tasks'.format(name, count))

    print('\n[STATS] By Stage:')
    for name, count in sorted(stages_count.items(), key=lambda x: -x[1]):
        print('   {}: {} tasks'.format(name, count))

    with_dojob = sum(1 for r in converted if any(r.get(f) for f in DOJOB_FIELD_MAP.values()))
    print('\n[STATS] Tasks with workflow timestamps: {} / {}'.format(with_dojob, len(converted)))

    baru = sum(1 for r in converted if r['manufactureBaru'])
    repeat = sum(1 for r in converted if r['manufactureRepeat'])
    print('[STATS] Manufacture Baru: {}, Repeat: {}'.format(baru, repeat))

    print('\n[SAMPLE] First converted record:')
    if converted:
        print(json.dumps(converted[0], indent=2, ensure_ascii=False))

    print('\n' + '=' * 60)
    print('  Done! Run with --output data.json to update your dashboard')
    print('=' * 60)


if __name__ == '__main__':
    main()
