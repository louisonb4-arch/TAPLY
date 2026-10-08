#!/usr/bin/env python3
"""Migrate visible Taply logos to the approved image-generated wordmark."""
from pathlib import Path
import re

ROOT=Path(__file__).resolve().parents[2]
PAGES=[
    "index.html", "connexion.html", "creer-compte.html", "join.html",
    "dashboard/index.html", "404.html", "cgu.html", "cgv.html",
    "confidentialite.html", "cookies.html", "mentions-legales.html",
]
logo_rx=re.compile(r'(<(a|span)\b[^>]*\bclass="[^"]*\blogo\b[^"]*"[^>]*>)(.*?)(</\2>)',re.S)
all_count=0
for name in PAGES:
    file=ROOT/name
    html=file.read_text()
    src_prefix='../images/' if name.startswith('dashboard/') else 'images/'
    if name == '404.html':src_prefix='/images/'
    dark=f'<img class="logo__asset logo__asset--dark" src="{src_prefix}taply-wordmark-noir.png" width="1697" height="644" alt="" aria-hidden="true">'
    light=f'<img class="logo__asset logo__asset--light" src="{src_prefix}taply-wordmark-blanc.png" width="1697" height="644" alt="" aria-hidden="true">'
    changed=[0]
    def patch(m):
        inside=m.group(3)
        if 'logo__asset' in inside:return m.group(0)
        if 'Taply' not in inside or '<svg' not in inside:
            raise RuntimeError(f'{name}: unexpected logo contents: {inside[:130]!r}')
        changed[0]+=1
        return m.group(1)+dark+light+m.group(4)
    out=logo_rx.sub(patch,html)
    if name=='404.html':
        out=out.replace('<a class="logo" href="/"', '<a class="logo logo--on-deep" href="/"')
    if changed[0]<=0:raise RuntimeError(f'No old logos found in {name}')
    file.write_text(out)
    all_count+=changed[0]
    print(f'{name}: {changed[0]} logo(s) updated')
print(f'TOTAL: {all_count} logos')
