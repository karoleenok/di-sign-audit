"""Одноразовая загрузка картинок галереи с Wikimedia Commons.
Скачивает файлы, приводит к 4:5 (800x1000, вписывает целиком на фон #dce8f4),
сохраняет в WebP до ~100 КБ в bot/app/gallery и дописывает bot/app/gallery/data.json."""
import io, json, os, sys, time, urllib.parse, urllib.request
from PIL import Image

OUT = os.path.join("bot", "app", "gallery")
UA = "DiSignUniversityGallery/1.0 (https://github.com/karoleenok/di-sign-audit)"
BG = (220, 232, 244)
PAGE = "https://commons.wikimedia.org/wiki/File:"
FILE = "https://commons.wikimedia.org/wiki/Special:FilePath/"

W = {
 "jp": [
  ("Tanaka 1.jpg", "Ikko Tanaka", "Афиша театра Но", ""),
  ("Ikko tanaka noh.jpg", "Ikko Tanaka", "Афиша театра Но", ""),
  ("Ikko Tanaka 3.jpg", "Ikko Tanaka", "", ""),
  ("Ikko Tanaka 4.jpg", "Ikko Tanaka", "", ""),
  ("Ikko Tanaka 5.jpg", "Ikko Tanaka", "", ""),
  ("Momoyagusa1-Kamisaka Sekka-BMA.jpg", "Kamisaka Sekka", "Momoyogusa", "1909–1910"),
  ("Momoyagusa2-Kamisaka Sekka-BMA.jpg", "Kamisaka Sekka", "Momoyogusa", "1909–1910"),
 ],
 "rf": [
  ("JPL Visions of the Future, Mars.jpg", "NASA/JPL-Caltech", "Visions of the Future: Mars", ""),
  ("JPL Visions of the Future, Venus.jpg", "NASA/JPL-Caltech", "Visions of the Future: Venus", ""),
  ("JPL Visions of the Future, Europa.jpg", "NASA/JPL-Caltech", "Visions of the Future: Europa", ""),
  ("JPL Visions of the Future, Enceladus.jpg", "NASA/JPL-Caltech", "Visions of the Future: Enceladus", ""),
  ("JPL Visions of the Future, Earth.jpg", "NASA/JPL-Caltech", "Visions of the Future: Earth", ""),
  ("JPL Visions of the Future, Grand Tour.jpg", "NASA/JPL-Caltech", "Visions of the Future: Grand Tour", ""),
  ("JPL Visions of the Future, HD 40307g.jpg", "NASA/JPL-Caltech", "Visions of the Future: HD 40307 g", ""),
 ],
 "mm": [
  ("Memphis - MADRAS table by Natalie Du Pasquier 1986.jpg", "Nathalie Du Pasquier", "Стол Madras", "1986"),
  ("Memphis carpet by Nathalier Du Pasquier 1985.jpg", "Nathalie Du Pasquier", "Ковёр", "1985"),
  ("Memphis Emerald by Nathalie Du Pasquier - 31064843947.jpg", "Nathalie Du Pasquier", "Emerald", ""),
  ("Ettore sottsass per memphis, tavolo tartar, 1985.JPG", "Ettore Sottsass", "Стол Tartar", "1985"),
  ("Ettore sottsass per porcellana san marco le nove e memphis srl., vaso euphrates, 1983.jpg", "Ettore Sottsass", "Ваза Euphrates", "1983"),
  ("Ettore sottsass, sedia 'miss, don't you like caviar, 1987.jpg", "Ettore Sottsass", "Стул «Miss, don't you like caviar»", "1987"),
  ("Ettore sottsass, prototipo della poltrona mandarin, 1986 ca.jpg", "Ettore Sottsass", "Кресло Mandarin, прототип", "ок. 1986"),
 ],
}

def get(url):
    for n in range(5):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except Exception as e:
            print("retry", n, url, e, file=sys.stderr)
            time.sleep(5 * (n + 1))
    raise SystemExit("не скачалось: " + url)

def fit(img):
    img = img.convert("RGB")
    tw, th = 800, 1000
    k = min(tw / img.width, th / img.height)
    img = img.resize((max(1, round(img.width * k)), max(1, round(img.height * k))), Image.LANCZOS)
    canvas = Image.new("RGB", (tw, th), BG)
    canvas.paste(img, ((tw - img.width) // 2, (th - img.height) // 2))
    return canvas

def save(img, path):
    for q in (82, 72, 62, 52, 42):
        buf = io.BytesIO()
        img.save(buf, "WEBP", quality=q, method=6)
        if buf.tell() <= 100 * 1024:
            break
    with open(path, "wb") as f:
        f.write(buf.getvalue())
    return buf.tell(), q

dpath = os.path.join(OUT, "data.json")
data = json.load(open(dpath, encoding="utf-8")) if os.path.exists(dpath) else {}
for key, items in W.items():
    data[key] = []
    for n, (fname, author, title, year) in enumerate(items, 1):
        raw = get(FILE + urllib.parse.quote(fname) + "?width=1400")
        img = Image.open(io.BytesIO(raw))
        out = f"{key}-{n:02d}.webp"
        size, q = save(fit(img), os.path.join(OUT, out))
        print(out, img.size, size, "q", q)
        e = {"a": author}
        if title: e["t"] = title
        if year: e["y"] = year
        e["u"] = PAGE + urllib.parse.quote(fname.replace(" ", "_"), safe="/,()'!-._~")
        e["i"] = out
        data[key].append(e)
        time.sleep(2)
json.dump(data, open(dpath, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("готово")
