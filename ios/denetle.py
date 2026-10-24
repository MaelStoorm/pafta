"""iOS derlemesine giren dosyaları denetler: iPhone'da kapalı/gizli tutulan hiçbir özellik uygulamaya girmemeli.

  python3 ios/denetle.py ios/gen/Pafta/site ios/Shell ios/project.yml
"""
import re
import subprocess
import sys
import tempfile
from pathlib import Path

YASAK = [
    r"AndroidBridge", r"android:start", r"android:end", r"[Aa]d[Mm]ob", r"[Rr]eklam", r"rewarded",
    r"purchase", r"[Bb]illing", r"workers\.dev", r"__vekil__", r"[Pp]roxy", r"ExtraCSS",
    r"CLLocationManager", r"UNUserNotificationCenter", r"URLSession", r"Geolocation", r"Reminders",
]
hatalar = []
for kok in sys.argv[1:]:
    yol = Path(kok)
    dosyalar = [yol] if yol.is_file() else [p for p in yol.rglob("*") if p.suffix in (".html", ".js", ".swift", ".yml", ".plist")]
    for f in dosyalar:
        metin = f.read_text(encoding="utf-8", errors="ignore")
        for y in YASAK:
            for m in re.finditer(y, metin):
                satir = metin.count("\n", 0, m.start()) + 1
                hatalar.append(f"{f}:{satir}: yasak ifade: {m.group(0)}")
        if f.suffix == ".html":
            for i, kod in enumerate(re.findall(r"<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)</script>", metin)):
                with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as t:
                    t.write(kod)
                r = subprocess.run(["node", "--check", t.name], capture_output=True, text=True)
                if r.returncode:
                    hatalar.append(f"{f}: betik {i + 1} sözdizimi hatası: {r.stderr.strip()[:300]}")
if hatalar:
    print("\n".join(hatalar))
    sys.exit(1)
print("iOS denetimi: temiz")
