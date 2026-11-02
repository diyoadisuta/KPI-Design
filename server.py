"""
KPI Dashboard Server with Odoo API Proxy + Local Ollama AI Assistant

Custom HTTP server that:
1. Serves static files (index.html, app.js, style.css, etc.)
2. Provides API endpoints for Odoo integration:
   - POST /api/odoo/sync       — Fetch all tasks from Odoo, convert, save to data.json
   - POST /api/odoo/update-task — Update task fields (designer, stage) in Odoo
   - POST /api/odoo/update-dojob — Create/update workflow timestamps in Odoo
3. Provides AI Assistant endpoint:
   - POST /api/ai/chat         — Send message + KPI context to Local Ollama, return reply
   - POST /api/ai/report       — Generate structured JSON insights for the AI PPTX report

Usage: python server.py
       python server.py --port 8000
"""

import json
import urllib.request
import os
import sys
import io
import re
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from datetime import datetime
import traceback

# Force UTF-8 output on Windows
if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

# ===== Odoo Configuration =====
ODOO_URL = 'http://192.168.1.102:10014/jsonrpc'
ODOO_DB = 'live8'
ODOO_USER = 'dio'
ODOO_API_KEY = 'fb9cc214a89d16ab2e9ccfc903fdee0bd6aa84fe'
PROJECT_ID = 4  # "All Project"
DATE_FROM = '2026-01-02 00:00:00'

# ===== Odoo Field Mappings =====
DOJOB_FIELD_MAP = {
    1:  'fileIn',
    2:  'progressAW',
    3:  'sendAWkeCust',
    4:  'accAWdariCust',
    5:  'sendKeDigitalPrint',
    6:  'receiveDigital',
    7:  'sendDigitalKeCust',
    8:  'accDigitalDariCust',
    9:  'progressDummy',
    10: 'sendDummy',
    11: 'accDummyDariCust',
    12: 'progressLayout',
    13: 'lemparFileKeCTP',
    14: 'progressLayoutCTP',
    15: 'doneLayoutCTP',
    16: 'review',
    17: 'keluarPlat',
    21: 'progressRevisiAW',
    22: 'progressRevisiDummy',
}

# Reverse map: field name -> task.do ID
FIELD_TO_DOJOB_ID = {v: k for k, v in DOJOB_FIELD_MAP.items()}

TAG_BARU = 26
TAG_REPEAT = 25

# ===== Local Ollama AI Configuration =====
OLLAMA_BASE_URL = 'http://192.168.1.9:11434'
OLLAMA_MODELS = ['qwen2.5:14b', 'gemma4:12b']

SYSTEM_PROMPT = """Kamu adalah AI Assistant KPI untuk Divisi Design di sebuah perusahaan percetakan.
Tugas kamu:
1. Menganalisis data KPI (kecepatan kerja, beban kerja designer)
2. Mengidentifikasi masalah dalam alur kerja (workflow)
3. Memberikan rekomendasi konkret dan actionable untuk meningkatkan efisiensi
4. Menjawab pertanyaan spesifik tentang performa designer atau tahapan produksi

Gunakan bahasa Indonesia yang natural dan profesional. 
Jawaban harus:
- Spesifik berdasarkan data yang diberikan
- Berikan angka/fakta dari data aktual
- Actionable (bisa langsung diterapkan)
- Singkat tapi informatif (max 300 kata per jawaban)
- Gunakan emoji secara wajar untuk keterbacaan

Konteks bisnis:
- Divisi Design mengerjakan berbagai produk cetak (paperbag, brosur, kartu nama, kalender, dll)
- Alur kerja: File In → Progress AW → Send AW → ACC AW → (Digital/Dummy/Layout) → CTP
- KPI utama: kecepatan (target ≤12 hari dari File In ke CTP), jumlah project (≥16/bulan)
- Designer: Dio, Dina, Rizky, Galang, Rizky Mahendra, Effendy, Naufal
"""

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# Cached Odoo UID
_odoo_uid = None


# ===== Odoo JSON-RPC =====
def json_rpc(service, method, args):
    """Send a JSON-RPC request to Odoo."""
    payload = json.dumps({
        'jsonrpc': '2.0',
        'method': 'call',
        'params': {'service': service, 'method': method, 'args': args},
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
        raise Exception('Odoo error: ' + json.dumps(data['error']))

    return data.get('result')


def get_uid():
    """Authenticate and return UID (cached)."""
    global _odoo_uid
    if _odoo_uid is None:
        _odoo_uid = json_rpc('common', 'authenticate',
                             [ODOO_DB, ODOO_USER, ODOO_API_KEY, {}])
        if not _odoo_uid:
            raise Exception('Authentication failed')
    return _odoo_uid


def odoo_execute(model, method, args, kwargs=None):
    """Execute an Odoo model method."""
    uid = get_uid()
    call_args = [ODOO_DB, uid, ODOO_API_KEY, model, method, args]
    if kwargs:
        call_args.append(kwargs)
    return json_rpc('object', 'execute_kw', call_args)


# ===== Data Conversion =====
def odoo_datetime_to_iso(val):
    if not val:
        return None
    try:
        dt = datetime.strptime(val, '%Y-%m-%d %H:%M:%S')
        return dt.strftime('%Y-%m-%dT%H:%M:%S')
    except (ValueError, TypeError):
        return val if val else None


def odoo_date_to_iso(val):
    if not val:
        return None
    try:
        dt = datetime.strptime(val, '%Y-%m-%d')
        return dt.strftime('%Y-%m-%dT00:00:00')
    except (ValueError, TypeError):
        return val if val else None


def extract_name(val):
    if isinstance(val, list) and len(val) == 2:
        return val[1]
    return '' if not val else str(val)


def extract_id(val):
    if isinstance(val, list) and len(val) == 2:
        return val[0]
    return val if val else None


def convert_task(task, dojob_map):
    """Convert a single Odoo task to dashboard format."""
    task_id = task['id']
    tag_ids = task.get('tag_ids', [])
    manufacture_baru = TAG_BARU in tag_ids
    manufacture_repeat = TAG_REPEAT in tag_ids

    tags_list = []
    if manufacture_baru:
        tags_list.append('Baru')
    if manufacture_repeat:
        tags_list.append('Repeat')

    # Build dojob timestamps
    dojob_records = dojob_map.get(task_id, [])
    dojob_timestamps = {}
    dojob_ids = {}  # field_name -> dojob record id
    for dj in dojob_records:
        do_id = dj['task_do_id'][0] if isinstance(dj['task_do_id'], list) else dj['task_do_id']
        field_name = DOJOB_FIELD_MAP.get(do_id)
        if field_name:
            dojob_timestamps[field_name] = odoo_datetime_to_iso(dj.get('do_date'))
            dojob_ids[field_name] = dj['id']

    sales = extract_name(task.get('user_sales'))
    design = extract_name(task.get('user_design'))

    return {
        'odooId': task_id,
        'odooStageId': extract_id(task.get('stage_id')),
        'odooDesignId': extract_id(task.get('user_design')),
        'dojobIds': dojob_ids,
        'title': task.get('name', ''),
        'customer': extract_name(task.get('partner_id')),
        'productDescription': task.get('product_description', '') or '',
        'orderedQty': int(task.get('ordered_qty', 0)),
        'deliveredQty': int(task.get('delivered_qty', 0)),
        'assignedTo': extract_name(task.get('user_id')),
        'sales': sales.lower() if sales else '',
        'design': design.lower() if design else '',
        'tags': ', '.join(tags_list),
        'stage': extract_name(task.get('stage_id')),
        'orderDate': odoo_date_to_iso(task.get('sale_order_date')),
        'deadline': odoo_date_to_iso(task.get('date_deadline')),
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
        'manufactureBaru': manufacture_baru,
        'manufactureRepeat': manufacture_repeat,
        'manufactureRepeatPerubahan': False,
    }


# ===== API Handlers =====
def handle_sync():
    """Fetch all tasks from Odoo, convert, save to data.json."""
    uid = get_uid()

    # Fetch tasks
    domain = [
        ['project_id', '=', PROJECT_ID],
        ['create_date', '>=', DATE_FROM],
    ]
    tasks = odoo_execute('project.task', 'search_read', [domain], {
        'order': 'sale_order_date desc, create_date desc',
        'context': {'active_test': False},
    })

    # Fetch dojob records
    all_dojob_ids = []
    for t in tasks:
        all_dojob_ids.extend(t.get('task_dojob', []))

    dojob_records = []
    BATCH = 5000
    for i in range(0, len(all_dojob_ids), BATCH):
        batch_ids = all_dojob_ids[i:i + BATCH]
        batch = odoo_execute('task.dojob', 'search_read',
                             [[['id', 'in', batch_ids]]],
                             {'fields': ['id', 'task_do_id', 'do_date', 'task_id', 'description']})
        dojob_records.extend(batch)

    # Build dojob map
    dojob_map = {}
    for dj in dojob_records:
        tid = dj['task_id'][0] if isinstance(dj['task_id'], list) else dj['task_id']
        dojob_map.setdefault(tid, []).append(dj)

    # Fetch stages for the kanban
    stages = odoo_execute('project.task.type', 'search_read',
                          [[]],
                          {'fields': ['id', 'name', 'sequence', 'fold']})

    # Fetch designers (users with design role)
    designer_ids = list(set([extract_id(t.get('user_design')) for t in tasks if t.get('user_design')]))
    valid_designer_ids = [d for d in designer_ids if isinstance(d, int)]
    if valid_designer_ids:
        designers = odoo_execute('res.users', 'search_read',
                                 [[['id', 'in', valid_designer_ids]]],
                                 {'fields': ['id', 'name']})
    else:
        designers = []

    # Convert tasks
    converted = [convert_task(t, dojob_map) for t in tasks]

    # Save to data.json
    output_path = os.path.join(SCRIPT_DIR, 'data.json')
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(converted, f, indent=2, ensure_ascii=False)

    active_count = sum(1 for t in tasks if t.get('active'))
    archived_count = sum(1 for t in tasks if not t.get('active'))

    return {
        'success': True,
        'total': len(converted),
        'active': active_count,
        'archived': archived_count,
        'stages': sorted(stages, key=lambda s: s.get('sequence', 0)),
        'designers': designers,
    }


def handle_update_task(body):
    """Update task fields in Odoo (stage, designer)."""
    task_id = body.get('taskId')
    if not task_id:
        raise ValueError('taskId is required')

    vals = {}

    # Update stage
    stage_id = body.get('stageId')
    if stage_id is not None:
        vals['stage_id'] = int(stage_id)

    # Update designer
    design_id = body.get('designId')
    if design_id is not None:
        vals['user_design'] = int(design_id) if design_id else False

    if not vals:
        raise ValueError('No fields to update')

    odoo_execute('project.task', 'write', [[int(task_id)], vals])

    return {'success': True, 'taskId': task_id, 'updated': vals}


def handle_update_dojob(body):
    """Create or update a dojob record (workflow timestamp)."""
    task_id = body.get('taskId')
    field_name = body.get('fieldName')
    do_date = body.get('doDate')  # ISO format or null
    dojob_id = body.get('dojobId')  # existing dojob record ID, if any

    if not task_id or not field_name:
        raise ValueError('taskId and fieldName are required')

    do_id = FIELD_TO_DOJOB_ID.get(field_name)
    if not do_id:
        raise ValueError('Unknown fieldName: ' + field_name)

    # Convert ISO to Odoo datetime format
    odoo_date = None
    if do_date:
        try:
            dt = datetime.fromisoformat(do_date.replace('Z', '+00:00'))
            odoo_date = dt.strftime('%Y-%m-%d %H:%M:%S')
        except (ValueError, TypeError):
            odoo_date = do_date

    if dojob_id and odoo_date:
        # Update existing record
        odoo_execute('task.dojob', 'write',
                     [[int(dojob_id)], {'do_date': odoo_date}])
        return {'success': True, 'action': 'updated', 'dojobId': dojob_id}
    elif dojob_id and not odoo_date:
        # Delete the record (clear timestamp)
        odoo_execute('task.dojob', 'unlink', [[int(dojob_id)]])
        return {'success': True, 'action': 'deleted', 'dojobId': dojob_id}
    elif odoo_date:
        # Create new record
        new_id = odoo_execute('task.dojob', 'create', [{
            'task_id': int(task_id),
            'task_do_id': do_id,
            'do_date': odoo_date,
        }])
        return {'success': True, 'action': 'created', 'dojobId': new_id}
    else:
        return {'success': True, 'action': 'noop'}


# ===== AI Chat Handler =====
def handle_ai_chat(body):
    """Send user message + KPI context to local Ollama and return AI reply."""
    user_message = body.get('message', '').strip()
    context = body.get('context', {})
    history = body.get('history', [])

    if not user_message:
        return {'error': 'Message kosong'}

    # Build context string from KPI data
    ctx_parts = []
    if context.get('totalTasks') is not None:
        ctx_parts.append(f"Total task aktif: {context['totalTasks']}")
    if context.get('avgSpeed') is not None:
        ctx_parts.append(f"Rata-rata kecepatan: {context['avgSpeed']} hari")
    if context.get('designers'):
        designers_info = []
        for d in context['designers']:
            info = f"  - {d['name']}: {d['count']} task"
            if d.get('avgSpeed') is not None:
                info += f", avg {d['avgSpeed']} hari"
            designers_info.append(info)
        ctx_parts.append("Beban kerja designer:\n" + "\n".join(designers_info))
    if context.get('stageDistribution'):
        stages = [f"  - {s['name']}: {s['count']} task" for s in context['stageDistribution']]
        ctx_parts.append("Distribusi stage:\n" + "\n".join(stages))
    if context.get('workflowAvg'):
        wf = [f"  - {w['label']}: {w['avg']} hari avg ({w['count']} data)" for w in context['workflowAvg'] if w.get('avg') is not None]
        ctx_parts.append("Rata-rata durasi tahapan workflow:\n" + "\n".join(wf))

    context_str = "\n\n".join(ctx_parts) if ctx_parts else "Tidak ada data tersedia saat ini."

    user_prompt = f"=== DATA KPI SAAT INI ===\n{context_str}\n\n=== PERTANYAAN USER ===\n{user_message}"

    messages = [{"role": "system", "content": SYSTEM_PROMPT}]

    # Include recent history if provided
    if isinstance(history, list):
        for h in history[-4:]:
            role = 'assistant' if h.get('role') == 'assistant' else 'user'
            text = h.get('text') or h.get('content') or ''
            if text:
                messages.append({"role": role, "content": text})

    messages.append({"role": "user", "content": user_prompt})

    last_error = None
    for model_name in OLLAMA_MODELS:
        url = f"{OLLAMA_BASE_URL}/api/chat"
        payload = json.dumps({
            "model": model_name,
            "messages": messages,
            "stream": False,
            "options": {
                "temperature": 0.7
            }
        }).encode('utf-8')

        req = urllib.request.Request(
            url,
            data=payload,
            headers={'Content-Type': 'application/json'},
            method='POST'
        )

        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                resp_data = json.loads(resp.read().decode('utf-8'))

            raw_reply = resp_data.get('message', {}).get('content', '')
            if raw_reply:
                # Remove <think>...</think> reasoning blocks if present
                clean_reply = re.sub(r'<think>[\s\S]*?</think>', '', raw_reply).strip()
                final_reply = clean_reply if clean_reply else raw_reply
                return {'reply': final_reply, 'success': True, 'model': model_name}
            else:
                last_error = f'Ollama ({model_name}) tidak memberikan respons'
        except urllib.error.HTTPError as e:
            err_body = e.read().decode('utf-8')
            last_error = f'Ollama API error {e.code}: {err_body}'
            continue
        except Exception as e:
            last_error = f'Gagal menghubungi Ollama ({model_name}): {str(e)}'
            continue

    return {'error': last_error or 'Semua model Ollama gagal dihubungi'}


# ===== AI Report (PPTX) Handler =====
def _extract_json(text):
    """Extract the first JSON object from a model reply (handles ```json fences / extra text)."""
    text = re.sub(r'<think>[\s\S]*?</think>', '', text or '').strip()
    text = re.sub(r'^```(?:json)?\s*|\s*```$', '', text).strip()
    try:
        return json.loads(text)
    except Exception:
        start, end = text.find('{'), text.rfind('}')
        if start != -1 and end > start:
            return json.loads(text[start:end + 1])
        raise


def handle_ai_report(body):
    """Generate structured (JSON) report insights for the PPTX generator via local Ollama."""
    system = body.get('system') or SYSTEM_PROMPT
    prompt = (body.get('prompt') or '').strip()
    if not prompt:
        return {'error': 'Prompt kosong'}

    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": prompt},
    ]

    last_error = None
    for model_name in OLLAMA_MODELS:
        payload = json.dumps({
            "model": model_name,
            "messages": messages,
            "stream": False,
            "format": "json",
            "options": {"temperature": 0.4, "num_ctx": 8192},
        }).encode('utf-8')
        req = urllib.request.Request(
            f"{OLLAMA_BASE_URL}/api/chat",
            data=payload,
            headers={'Content-Type': 'application/json'},
            method='POST'
        )
        try:
            with urllib.request.urlopen(req, timeout=240) as resp:
                resp_data = json.loads(resp.read().decode('utf-8'))
            raw = resp_data.get('message', {}).get('content', '')
            insights = _extract_json(raw)
            return {'success': True, 'model': model_name, 'insights': insights}
        except Exception as e:
            last_error = f'{model_name}: {e}'
            continue

    return {'error': last_error or 'Semua model Ollama gagal dihubungi'}


# ===== HTTP Server =====
class KPIHandler(SimpleHTTPRequestHandler):
    """Custom handler with API routes + static file serving."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=SCRIPT_DIR, **kwargs)

    def do_POST(self):
        """Handle API POST requests."""
        if self.path.startswith('/api/'):
            try:
                with open(os.path.join(SCRIPT_DIR, 'server_debug.log'), 'a', encoding='utf-8') as logf:
                    logf.write(f"[{datetime.now()}] Received POST {self.path}\n")

                content_len = int(self.headers.get('Content-Length', 0))
                body_raw = self.rfile.read(content_len) if content_len else b'{}'
                body = json.loads(body_raw.decode('utf-8')) if body_raw else {}

                if self.path == '/api/odoo/sync':
                    result = handle_sync()
                elif self.path == '/api/odoo/update-task':
                    result = handle_update_task(body)
                elif self.path == '/api/odoo/update-dojob':
                    result = handle_update_dojob(body)
                elif self.path == '/api/ai/chat':
                    result = handle_ai_chat(body)
                elif self.path == '/api/ai/report':
                    result = handle_ai_report(body)
                else:
                    self.send_json(404, {'error': 'Not found'})
                    return

                with open(os.path.join(SCRIPT_DIR, 'server_debug.log'), 'a', encoding='utf-8') as logf:
                    logf.write(f"[{datetime.now()}] Endpoint {self.path} finished successfully. Sending 200 JSON...\n")

                self.send_json(200, result)

            except Exception as e:
                err_str = traceback.format_exc()
                with open(os.path.join(SCRIPT_DIR, 'server_debug.log'), 'a', encoding='utf-8') as logf:
                    logf.write(f"[{datetime.now()}] ERROR in {self.path}:\n{err_str}\n")
                try:
                    self.send_json(500, {'error': str(e), 'type': type(e).__name__})
                except Exception:
                    pass
        else:
            self.send_error(405, 'Method Not Allowed')

    def send_json(self, code, data):
        """Send a JSON response."""
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        """Send cache-control headers so browser immediately gets latest JS and CSS."""
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def do_OPTIONS(self):
        """Handle CORS preflight."""
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def log_message(self, format, *args):
        """Custom log format."""
        try:
            msg = format % args
            sys.stderr.write('[SERVER] %s\n' % msg)
            sys.stderr.flush()
        except Exception:
            pass


def main():
    port = 8080
    if '--port' in sys.argv:
        idx = sys.argv.index('--port')
        if idx + 1 < len(sys.argv):
            port = int(sys.argv[idx + 1])

    # Test Odoo connection on startup
    print('=' * 50)
    print('  KPI Dashboard Server')
    print('=' * 50)
    print()
    print('[CONFIG] Odoo: {}'.format(ODOO_URL))
    print('[CONFIG] Database: {}'.format(ODOO_DB))
    print('[CONFIG] User: {}'.format(ODOO_USER))
    print('[CONFIG] Ollama AI: {} (Models: {})'.format(OLLAMA_BASE_URL, ', '.join(OLLAMA_MODELS)))
    print()

    try:
        uid = get_uid()
        print('[OK] Odoo connected (UID: {})'.format(uid))
    except Exception as e:
        print('[WARNING] Odoo connection failed: {}'.format(e))
        print('         Sync features will not work until Odoo is reachable.')

    print()
    print('[SERVER] Starting on http://localhost:{}  ...'.format(port))
    print('[SERVER] Press Ctrl+C to stop')
    print()

    server = ThreadingHTTPServer(('0.0.0.0', port), KPIHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n[SERVER] Stopped.')
        server.server_close()


if __name__ == '__main__':
    main()
