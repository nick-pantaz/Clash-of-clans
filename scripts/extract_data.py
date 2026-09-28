#!/usr/bin/env python3
"""Extract the Upgrades sheet from the rush spreadsheet into data/upgrades.json.

Standard library only. Re-run after editing the spreadsheet:
    python3 scripts/extract_data.py
"""
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "source" / "coc_th10_to_th18_rush.xlsx"
OUT = ROOT / "data" / "upgrades.json"
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"


def read_sheet(path, sheet_name):
    z = zipfile.ZipFile(path)
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
            shared.append("".join(t.text or "" for t in si.iter("{%s}t" % NS["m"])))

    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    targets = {r.get("Id"): r.get("Target") for r in rels}
    sheet = next(s for s in wb.find("m:sheets", NS) if s.get("name") == sheet_name)
    target = targets[sheet.get(REL_NS)].lstrip("/")
    if not target.startswith("xl/"):
        target = "xl/" + target

    rows = []
    for row in ET.fromstring(z.read(target)).iter("{%s}row" % NS["m"]):
        cells = {}
        for c in row.findall("m:c", NS):
            col = re.match(r"[A-Z]+", c.get("r")).group()
            v = c.find("m:v", NS)
            t = c.get("t")
            if t == "s" and v is not None:
                val = shared[int(v.text)]
            elif t == "inlineStr":
                val = "".join(x.text or "" for x in c.iter("{%s}t" % NS["m"]))
            else:
                val = v.text if v is not None else ""
            cells[col] = val
        rows.append(cells)
    return rows


def num(s):
    f = float(s)
    return int(f) if f.is_integer() else f


def main():
    rows = read_sheet(SRC, "Upgrades")
    header = rows[0]
    col = {v: k for k, v in header.items()}

    def get(r, name):
        return r.get(col[name], "")

    items = []
    for r in rows[1:]:
        rid = get(r, "#")
        if not rid or not rid.strip().isdigit():
            continue
        items.append({
            "id": int(rid),
            "beforeTH": int(num(get(r, "Needed before TH"))),
            "availTH": int(num(get(r, "Available at TH"))),
            "category": get(r, "Category"),
            "name": get(r, "Upgrade"),
            "resource": get(r, "Resource"),
            "cost": num(get(r, "Cost") or 0),
            "days": num(get(r, "Build time (days)") or 0),
            "include": get(r, "Include?").strip().lower() != "no",
            "notes": get(r, "Notes"),
            "requires": [],
        })

    by_name = {it["name"]: it for it in items}

    def need(it, name):
        dep = by_name.get(name)
        if dep is None:
            sys.exit(f"Dependency '{name}' for '{it['name']}' not found")
        if dep["id"] not in it["requires"]:
            it["requires"].append(dep["id"])

    for it in items:
        name = it["name"]
        m = re.match(r"^(.*) -> (\d+)$", name)
        if m:
            prev = f"{m.group(1)} -> {int(m.group(2)) - 1}"
            if prev in by_name:
                need(it, prev)
        if it["category"] == "Town Hall":
            th = int(m.group(2))
            for other in items:
                if other["beforeTH"] == th and other is not it:
                    it["requires"].append(other["id"])
        m = re.match(r"^(Ricochet Cannon|Multi-Archer Tower) #(\d+) \(merge\)$", name)
        if m:
            base = "Cannon" if m.group(1) == "Ricochet Cannon" else "Archer Tower"
            k = int(m.group(2))
            need(it, f"{base} #{2 * k - 1} -> 21")
            need(it, f"{base} #{2 * k} -> 21")
        if name == "Multi-Gear Tower (merge)":
            need(it, "Cannon #7 Gear Up")
            need(it, "Archer Tower #7 Gear Up")
        m = re.match(r"^(Cannon|Archer Tower) #(\d+) Gear Up$", name)
        if m:
            need(it, f"{m.group(1)} #{m.group(2)} -> 21")
        if name == "Inferno Artillery -> 2":
            need(it, "Eagle Artillery -> 7")

    OUT.write_text(json.dumps(items, indent=1) + "\n")

    inc = [i for i in items if i["include"]]
    totals = {res: sum(i["cost"] for i in inc if i["resource"] == res)
              for res in ("Gold", "Elixir", "Dark Elixir")}
    days = sum(i["days"] for i in inc)
    print(f"{len(items)} upgrades -> {OUT.relative_to(ROOT)}")
    print(f"Gold {totals['Gold']:,}  Elixir {totals['Elixir']:,}  "
          f"DE {totals['Dark Elixir']:,}  builder-days {days:.4f}")


if __name__ == "__main__":
    main()
