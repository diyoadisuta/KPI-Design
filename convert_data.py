import openpyxl
import json
from datetime import datetime

wb = openpyxl.load_workbook('KPI DESIGN.xlsx')
ws = wb['Sheet1']

headers = [cell.value for cell in ws[1]]
data = []

for i, row in enumerate(ws.iter_rows(min_row=2, max_row=ws.max_row, values_only=True), 2):
    if row[0] is None:
        break
    
    record = {}
    record['title'] = str(row[0]) if row[0] else ''
    record['customer'] = str(row[1]) if row[1] else ''
    record['productDescription'] = str(row[2]) if row[2] else ''
    record['orderedQty'] = row[3] if isinstance(row[3], (int, float)) else 0
    record['deliveredQty'] = row[4] if isinstance(row[4], (int, float)) else 0
    record['assignedTo'] = str(row[5]) if row[5] else ''
    record['sales'] = str(row[6]) if row[6] else ''
    record['design'] = str(row[7]) if row[7] and row[7] is not False else ''
    record['tags'] = str(row[8]) if row[8] else ''
    record['stage'] = str(row[9]) if row[9] else ''
    
    # Date fields - convert to ISO string
    def to_iso(val):
        if isinstance(val, datetime):
            return val.isoformat()
        return None
    
    record['orderDate'] = to_iso(row[10])
    record['deadline'] = to_iso(row[11])
    record['fileIn'] = to_iso(row[12])
    record['progressAW'] = to_iso(row[13])
    record['sendAWkeCust'] = to_iso(row[14])
    record['accAWdariCust'] = to_iso(row[15])
    record['sendKeDigitalPrint'] = to_iso(row[16])
    record['receiveDigital'] = to_iso(row[17])
    record['sendDigitalKeCust'] = to_iso(row[18])
    record['accDigitalDariCust'] = to_iso(row[19])
    record['progressDummy'] = to_iso(row[20])
    record['sendDummy'] = to_iso(row[21])
    record['accDummyDariCust'] = to_iso(row[22])
    record['progressLayout'] = to_iso(row[23])
    record['lemparFileKeCTP'] = to_iso(row[24])
    record['progressLayoutCTP'] = to_iso(row[25])
    record['doneLayoutCTP'] = to_iso(row[26])
    record['review'] = to_iso(row[27])
    record['keluarPlat'] = to_iso(row[28])
    record['progressRevisiAW'] = to_iso(row[29])
    record['progressRevisiDummy'] = to_iso(row[30])
    
    # Boolean fields
    record['manufactureBaru'] = bool(row[31]) if row[31] is not None else False
    record['manufactureRepeat'] = bool(row[32]) if row[32] is not None else False
    record['manufactureRepeatPerubahan'] = bool(row[33]) if row[33] is not None else False
    
    data.append(record)

# Write to JSON
with open('data.json', 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

print(f"Converted {len(data)} records to data.json")

# Quick validation
speeds = []
for r in data:
    file_in = r['fileIn']
    ctp = r['lemparFileKeCTP']
    review = r['review']
    
    if file_in:
        end = ctp if ctp else review
        if end:
            d1 = datetime.fromisoformat(file_in)
            d2 = datetime.fromisoformat(end)
            diff = (d2 - d1).total_seconds() / 86400
            speeds.append(diff)

print(f"Speed calculations available: {len(speeds)}")
print(f"Average speed: {sum(speeds)/len(speeds):.1f} days")
print(f"Min: {min(speeds):.1f}, Max: {max(speeds):.1f}")
negatives = [s for s in speeds if s < 0]
print(f"Anomalies (negative): {len(negatives)}")
