"""Одноразово: скачивает 24 современных постера (по 3 на стиль), кадрирует до 4:5 (600x750)
и кладёт в bot/app/gallery/tile-<стиль>-<номер>.webp."""
import io, os, sys, time, urllib.request
from PIL import Image

OUT = os.path.join("bot", "app", "gallery")
UA = "Mozilla/5.0 (compatible; DiSignUniversityTiles/1.0; +https://github.com/karoleenok/di-sign-audit)"
SRC = {
 "br": ["25/b7/3c/25b73cb164542a10f491079e8d94727c", "a1/03/e9/a103e97432e361c624d66fbd5a3f507f", "03/d4/3f/03d43fb5c337480c03a8c9128deae40a"],
 "sw": ["ee/bb/36/eebb36b5e6993b10e754227648d1690f", "37/8c/34/378c34a18b3e777fd13bd5cbf90c364c", "c7/42/fd/c742fd1323c0506a45bcf923a8d9a452"],
 "rf": ["30/7d/99/307d99003b81d91d62c94f922c6ff4fb", "06/4a/b4/064ab4c86223cf3cb825b7a4973f9106", "7c/df/53/7cdf53f29575333036577ec5e5d3ef9a"],
 "ad": ["1e/e0/b3/1ee0b3b00d8e7f0e596aabe8435190cb", "c1/5f/cc/c15fccd506e3a51f11f739f6a260b788", "96/7a/51/967a51abbe08c4e8b970121de4fa4b09"],
 "mm": ["62/6b/f6/626bf6886545099cc8549723d4a60a52", "2e/20/b9/2e20b95586849b1fcfffe878bd52c56e", "e4/85/05/e4850552300ef1e4efc9486d47b82aa9"],
 "nw": ["a4/27/ac/a427aca3f2c8efdb9ef0af5e980d29fc", "98/4a/62/984a627fa634ee8c8aaba700455c137c", "2c/b8/92/2cb89246a200163902018464b5bc3d2b"],
 "bh": ["2c/4b/3a/2c4b3ae7ee82b53fb93d3624a3a95336", "54/8e/b9/548eb96956311eb9fbda357ce91ef637", "7e/8f/6c/7e8f6c1a9c3d6bd9299a7bd0aae9375c"],
 "jp": ["9d/44/ca/9d44cade543d4203dc1d2b0283bf3608", "79/e2/87/79e2876b31b57ef7d813e2cedd30ca4e", "8d/64/9a/8d649ad09a27de356fc11bfaed070c52"],
}

def get(path):
    for ext in ("jpg", "png"):
        for size in ("originals", "736x"):
            url = f"https://i.pinimg.com/{size}/{path}.{ext}"
            try:
                req = urllib.request.Request(url, headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=60) as r:
                    return r.read(), url
            except Exception as e:
                print("miss", url, e, file=sys.stderr)
                time.sleep(1)
    raise SystemExit("не скачалось: " + path)

def crop(img, tw=600, th=750, bias=0.4):
    img = img.convert("RGB")
    k = max(tw / img.width, th / img.height)
    img = img.resize((max(tw, round(img.width * k)), max(th, round(img.height * k))), Image.LANCZOS)
    x = (img.width - tw) // 2
    y = round((img.height - th) * bias)
    return img.crop((x, y, x + tw, y + th))

def save(img, path):
    for q in (82, 72, 62, 52, 42):
        buf = io.BytesIO()
        img.save(buf, "WEBP", quality=q, method=6)
        if buf.tell() <= 90 * 1024:
            break
    open(path, "wb").write(buf.getvalue())
    return buf.tell(), q

for key, paths in SRC.items():
    for n, p in enumerate(paths, 1):
        raw, url = get(p)
        im = Image.open(io.BytesIO(raw))
        out = f"tile-{key}-{n}.webp"
        size, q = save(crop(im), os.path.join(OUT, out))
        print(out, im.size, size, "q", q, url)
        time.sleep(1)
print("готово")
