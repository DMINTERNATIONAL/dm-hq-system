#!/usr/bin/env python3
"""앱 전체 다크모드 CSS 만들기 — index.html 의 색을 읽어 어두운 색으로 바꾼 규칙을 만든다.

쓰는 법:  python3 tools/build_dark.py      (index.html 안의 DM-DARK-CSS 블록을 새로 채움)
화면에 새 색을 넣었으면 다시 돌리면 된다. 만든 CSS 는 다크모드를 켠 기기에서만 붙는다(밝은 화면엔 비용 0).
- <style> 안의 규칙: 같은 선택자 앞에 html.dm-dark 를 붙여 색만 바꾼 규칙
- style="..." 로 쓴 색: [style*="background:#fff"] 같은 선택자로 !important 덮어쓰기
- 채팅(cm-)은 손으로 맞춘 html.cm-dark 규칙이 뒤에 있어 그쪽이 이긴다
"""
import re, colorsys, sys, os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
PATH = os.path.join(ROOT, 'index.html')
BEGIN = '<script type="text/plain" id="DM-DARK-CSS">'
END = '</script><!--/DM-DARK-CSS-->'

COLOR_RE = re.compile(r'#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3,4}\b|rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*[\d.]+%?\s*)?\)|\bwhite\b')

def parse(c):
    c = c.lower()
    if c == 'white': return (255, 255, 255, 1.0)
    if c.startswith('#'):
        h = c[1:]
        if len(h) in (3, 4): h = ''.join(x * 2 for x in h)
        r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
        a = int(h[6:8], 16) / 255 if len(h) == 8 else 1.0
        return (r, g, b, a)
    n = [x.strip() for x in c[c.index('(') + 1:-1].split(',')]
    a = 1.0
    if len(n) > 3:
        a = float(n[3][:-1]) / 100 if n[3].endswith('%') else float(n[3])
    return (float(n[0]), float(n[1]), float(n[2]), a)

def hexc(r, g, b):
    return '#%02X%02X%02X' % (max(0, min(255, round(r))), max(0, min(255, round(g))), max(0, min(255, round(b))))

def out(r, g, b, a):
    return hexc(r, g, b) if a >= 0.999 else 'rgba(%d,%d,%d,%s)' % (round(r), round(g), round(b), ('%.2f' % a).rstrip('0').rstrip('.'))

def hls(c):
    r, g, b, a = c
    h, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
    return h, l, s, a

def from_hls(h, l, s, a=1.0):
    r, g, b = colorsys.hls_to_rgb(h, max(0, min(1, l)), max(0, min(1, s)))
    return out(r * 255, g * 255, b * 255, a)

CARD = (28, 28, 30)   # #1C1C1E
def tint(h, s, k=0.20, base=CARD):
    r, g, b = colorsys.hls_to_rgb(h, 0.55, min(0.75, max(0.35, s)))
    return hexc(base[0] * (1 - k) + r * 255 * k, base[1] * (1 - k) + g * 255 * k, base[2] * (1 - k) + b * 255 * k)

def neutral(l, s):
    return s < 0.30 or l > 0.985 or l < 0.06

def bg(c):
    h, l, s, a = hls(c)
    if a < 0.999:
        if l > 0.9 and a >= 0.5: return out(28, 28, 30, a)           # 흰 반투명 판 → 어두운 반투명 판
        if l < 0.25 and a < 0.5 and s < 0.6: return out(255, 255, 255, min(0.12, a * 1.5))  # 연한 그림자 판 → 연한 흰 판
        return None
    if neutral(l, s) or (l > 0.9 and s < 0.45):
        if l >= 0.99: return '#1C1C1E'
        if l >= 0.955: return '#242426'
        if l >= 0.90: return '#2C2C2E'
        if l >= 0.78: return '#3A3A3C'
        if l < 0.30: return '#3A3A3C' if l > 0.06 else None          # 짙은 남색·검정 버튼 → 회색 버튼
        return None
    if l >= 0.80: return tint(h, s)                                   # 파스텔 → 어두운 색조
    return None                                                       # 진한 색 버튼은 그대로

def fg(c):
    h, l, s, a = hls(c)
    if a < 0.999:
        if l < 0.3: return out(242, 242, 242, a)
        return None
    if l >= 0.97: return None                                          # 흰 글씨(색 버튼 위)
    if neutral(l, s):
        if l < 0.5: nl = 1 - l
        elif l <= 0.6: nl = l
        else: nl = 0.6 - (l - 0.6) * 0.5
        nl = max(0.42, min(0.95, nl))
        return from_hls(h, nl, min(s, 0.12))
    if l < 0.66: return from_hls(h, 0.66 + (0.66 - l) * 0.35, min(s, 0.9))
    if l > 0.85: return from_hls(h, 0.45, s * 0.5)                     # 아주 연한 색 글씨
    return None

def bd(c):
    h, l, s, a = hls(c)
    if a < 0.999:
        if l < 0.3: return out(255, 255, 255, min(0.14, a * 1.4))
        return None
    if neutral(l, s) or (l > 0.88 and s < 0.45):
        if l >= 0.80: return '#2C2C2E'
        if l >= 0.65: return '#3A3A3C'
        if l < 0.2: return '#3A3A3C'
        return None
    if l >= 0.75: return tint(h, s, 0.38)
    return None

ROLE = {}
def role(prop):
    p = prop.lower()
    if p.startswith('background'): return bg
    if p in ('color', 'caret-color', '-webkit-text-fill-color'): return fg
    if p.startswith('border') or p.startswith('outline') or p == 'column-rule': return bd
    return None

VAR_BG = {'var(--text)': '#3A3A3C', 'var(--text-1,#111)': '#3A3A3C', 'var(--text-3)': '#48484A'}

def tx(prop, val):
    f = role(prop)
    if f is bg and val.strip() in VAR_BG: return VAR_BG[val.strip()]   # 글씨색을 바탕으로 쓴 짙은 칩
    if not f or 'var(' in val and not COLOR_RE.search(val): return None
    changed = [False]
    def rep(m):
        try: n = f(parse(m.group(0)))
        except Exception: return m.group(0)
        if n is None: return m.group(0)
        changed[0] = True
        return n
    v = COLOR_RE.sub(rep, val)
    return v if changed[0] else None

# ---------- CSS 파서 ----------
def strip_comments(css):
    return re.sub(r'/\*.*?\*/', '', css, flags=re.S)

def blocks(css):
    """[(prelude, body_or_children)] — @media 등은 children 재귀"""
    i, n, res = 0, len(css), []
    while i < n:
        j = css.find('{', i)
        if j < 0: break
        pre = css[i:j].strip()
        depth, k = 1, j + 1
        while k < n and depth:
            ch = css[k]
            if ch == '{': depth += 1
            elif ch == '}': depth -= 1
            k += 1
        body = css[j + 1:k - 1]
        # 앞에 붙은 ; 로 끝나는 @import 같은 것 제거
        if ';' in pre and not pre.startswith('@'): pre = pre[pre.rfind(';') + 1:].strip()
        res.append((pre, body))
        i = k
    return res

def decls(body):
    out_, buf, depth = [], '', 0
    for ch in body:
        if ch == '(': depth += 1
        elif ch == ')': depth -= 1
        if ch == ';' and depth == 0:
            out_.append(buf); buf = ''
        else: buf += ch
    out_.append(buf)
    res = []
    for d in out_:
        if ':' not in d: continue
        p, v = d.split(':', 1)
        p = p.strip(); v = v.strip()
        if p and v: res.append((p, v))
    return res

def prefix(sel):
    res = []
    for s in split_sel(sel):
        s = s.strip()
        if not s: continue
        if 'cm-dark' in s or 'dm-dark' in s: return None
        if s.startswith(':root'): res.append('html.dm-dark' + s[5:])
        elif re.match(r'html\b', s): res.append('html.dm-dark' + s[4:])
        elif re.match(r'body\b', s): res.append('html.dm-dark ' + s)
        else: res.append('html.dm-dark ' + s)
    return ','.join(res) if res else None

def split_sel(sel):
    parts, buf, depth = [], '', 0
    for ch in sel:
        if ch in '([': depth += 1
        elif ch in ')]': depth -= 1
        if ch == ',' and depth == 0: parts.append(buf); buf = ''
        else: buf += ch
    parts.append(buf)
    return parts

ROOT_VARS = {
    '--bg-page': '#000000', '--card': '#1C1C1E', '--border': '#2C2C2E', '--border-soft': '#242426',
    '--text': '#F2F2F2', '--text-2': '#AEAEB2', '--text-3': '#8E8E93',
    '--blue': '#4C8DF6', '--blue-bg': '#1E2A3F', '--green-bg': '#16302A', '--purple-bg': '#2A2440',
    '--orange-bg': '#3A2F17', '--red-bg': '#3D1F1F', '--pink-bg': '#3A1F2E',
    '--shadow': 'none', '--shadow-md': '0 4px 12px rgba(0,0,0,.5)',
}

def gen_rules(css):
    lines = []
    for pre, body in blocks(css):
        if pre.startswith('@media') or pre.startswith('@supports'):
            inner = gen_rules(body)
            if inner: lines.append(pre + '{' + ''.join(inner) + '}')
            continue
        if pre.startswith('@'): continue
        if not pre or pre.startswith(':root') and False: pass
        sel = prefix(pre)
        if not sel: continue
        ds = []
        for p, v in decls(body):
            if p in ROOT_VARS and pre.strip() == ':root':
                ds.append('%s:%s' % (p, ROOT_VARS[p])); continue
            imp = '!important' in v
            vv = v.replace('!important', '').strip()
            n = tx(p, vv)
            if n: ds.append('%s:%s%s' % (p, n, '!important' if imp else ''))
        if ds: lines.append(sel + '{' + ';'.join(ds) + '}')
    return lines

# ---------- style="..." 안의 색 ----------
PROPS = r'background(?:-color|-image)?|color|border(?:-(?:top|bottom|left|right))?(?:-color)?|outline(?:-color)?'
DECL_RE = re.compile(r'(?<![\w-])(' + PROPS + r')\s*:\s*([^;"\'<>{}]*)')

def serial(val):
    """브라우저가 style 을 다시 쓸 때의 모양: #fff → rgb(255, 255, 255), 쉼표 뒤 한 칸"""
    def rep(m):
        try: r, g, b, a = parse(m.group(0))
        except Exception: return m.group(0)
        if a >= 0.999: return 'rgb(%d, %d, %d)' % (r, g, b)
        return 'rgba(%d, %d, %d, %s)' % (r, g, b, ('%g' % round(a, 2)))
    v = COLOR_RE.sub(rep, val)
    return re.sub(r'\s*,\s*', ', ', v)

def camel(p):
    return re.sub(r'[A-Z]', lambda m: '-' + m.group(0).lower(), p)

def inline_rules(src):
    segs = [m.group(1) for m in re.finditer(r'style="([^"]*)"', src)]
    segs += [m.group(2) for m in re.finditer(r"cssText\s*\+?=\s*(['\"])(.*?)\1", src)]
    segs += [camel(m.group(1)) + ':' + m.group(3) for m in re.finditer(r"\.style\.([a-zA-Z]+)\s*=\s*(['\"])(.*?)\2", src)]
    # 자바스크립트 값으로 넣는 색({bg:'#ede9fe'} → 'background:'+c.bg)도 잡히게: 소스에 나오는 모든 색을 배경 · 글씨 둘 다로
    lits = set(m.group(0).lower() for m in re.finditer(r"(?<=['\"])#[0-9a-fA-F]{6}(?=['\"])|(?<=['\"])#[0-9a-fA-F]{3}(?=['\"])", src))
    segs += ['background:%s;color:%s' % (c, c) for c in sorted(lits)]
    found = {}
    for seg in segs:
        for d in DECL_RE.finditer(seg):
            prop, val = d.group(1), d.group(2).rstrip()
            if not COLOR_RE.search(val) and val.strip() not in VAR_BG: continue
            n = tx(prop, val)
            key = seg[d.start():d.start(2)].strip() + val
            found[key.lower()] = (prop, val, n)
            # style 을 자바스크립트로 건드리면 브라우저가 'background: rgb(255, 255, 255)' 모양으로 다시 쓴다
            found[(prop + ': ' + serial(val)).lower()] = (prop, val, n)
    # 짧은 것이 긴 것의 앞부분이면 긴 것도 규칙을 낸다(같은 우선순위 → 뒤에 오는 긴 것이 이김)
    keys = sorted(found, key=len)
    changed = [k for k in keys if found[k][2]]
    lines = []
    for k in keys:
        prop, val, n = found[k]
        if not n:
            if not any(k != c and k.startswith(c) for c in changed): continue
            n = val
        q = k.replace('"', '\\"')
        if prop == 'color':
            sel = 'html.dm-dark [style^="%s" i],html.dm-dark [style*=";%s" i],html.dm-dark [style*="; %s" i]' % (q, q, q)
        else:
            sel = 'html.dm-dark [style*="%s" i]' % q
        lines.append('%s{%s:%s!important}' % (sel, prop, n))
    return lines

def main():
    s = open(PATH, encoding='utf-8').read()
    a = s.find(BEGIN)
    body_src = s
    if a >= 0:
        b = s.index(END, a)
        body_src = s[:a] + s[b + len(END):]
    # <script> 안의 <style>(계약서·명세서 인쇄 문서 등)은 앱 화면이 아니라 뺀다
    styles = re.findall(r'<style[^>]*>(.*?)</style>', re.sub(r'<script\b[^>]*>.*?</script>', '', body_src, flags=re.S), re.S)
    css = strip_comments('\n'.join(styles))
    rules = gen_rules(css)
    inl = inline_rules(re.sub(r'<style[^>]*>.*?</style>', '', body_src, flags=re.S))
    base = [
        'html.dm-dark{color-scheme:dark}',
        'html.dm-dark body{background:#000;color:#F2F2F2}',
        'html.dm-dark input,html.dm-dark select,html.dm-dark textarea{background-color:#1C1C1E;color:#F2F2F2;border-color:#3A3A3C}',
        'html.dm-dark input::placeholder,html.dm-dark textarea::placeholder{color:#6E6E73}',
        'html.dm-dark img,html.dm-dark video{color-scheme:light}',
    ]
    out_css = '@media screen{\n' + '\n'.join(base + rules + inl) + '\n}'
    block = BEGIN + '\n' + out_css + '\n' + END
    if a >= 0:
        b = s.index(END, a)
        s = s[:a] + block + s[b + len(END):]
    else:
        h = s.index('</head>')
        s = s[:h] + block + '\n' + s[h:]
    open(PATH, 'w', encoding='utf-8').write(s)
    print('rules', len(rules), 'inline', len(inl), 'bytes', len(out_css))

if __name__ == '__main__':
    main()
