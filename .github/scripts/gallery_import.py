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
 "ad": [
  ("Roger Broders Agay 1928.jpg", "Roger Broders", "Agay", "1928"),
  ("Roger Broders Antibes c 1928.jpg", "Roger Broders", "Antibes", "ок. 1928"),
  ("Roger Broders - Poster La Plage de Calvi (PLM).jpg", "Roger Broders", "La Plage de Calvi", "1928"),
  ("Roger Broders Menton c 1923.jpg", "Roger Broders", "Menton", "ок. 1923"),
  ("Paul Colin.Serge Lyfar.1935.jpg", "Paul Colin", "Serge Lifar", "1935"),
  ("Edward McKnight Kauffer - Play Between 6 and 12.jpg", "Edward McKnight Kauffer", "Play Between 6 and 12", "1930"),
  ("Plakat - Summer in Germany - L Hohlwein - 1927.jpg", "Ludwig Hohlwein", "Summer in Germany", "1927"),
 ],
 "bh": [
  ("Postkarte Bauhaus Wassily Kandinsky Postkarte für die Bauhaus-Ausstellung.jpg", "Wassily Kandinsky", "Открытка к выставке Баухауса", "1923"),
  ("Postkarte Bauhaus Oskar Schlemmer Postkarte für die Bauhaus-Ausstellung.jpg", "Oskar Schlemmer", "Открытка к выставке Баухауса", "1923"),
  ("Joost-schmidt-mechanical-stage-design-1925-1926-ink-and-tempera-on-paper-64-x-44-cm1.jpg", "Joost Schmidt", "Эскиз механической сцены", "1925–1926"),
  ("Ein Loch in der Tasche! Da fällt Geld heraus! - Joost Schmidt, Junkers.jpg", "Joost Schmidt", "Junkers", "1926"),
  ("Oskar Schlemmer - Bauhaustreppe 1932.jpg", "Oskar Schlemmer", "Bauhaustreppe", "1932"),
  ("Oskar Schlemmer Triadisches Ballett 400.jpg", "Oskar Schlemmer", "Триадический балет", "1922"),
  ("Libertad de Cultos - Libertad de Palabra - Libres de Miseria - Libres de Temor (Freedom of religion - Freedom of Speech - freedom from misery - freedom from fear) - DPLA - 84704c789978cf3057ff06d5ae4859ed.jpg", "Herbert Bayer", "Libertad de Cultos, Libertad de Palabra", ""),
 ],
 "sw": [
  ("Kunsthalle Basel Gubler Zurkinden 1959.jpg", "Armin Hofmann", "Kunsthalle Basel: Gubler, Zurkinden", "1959"),
  ("1959 - Gewerbemuseum Basel - Alte und neue Formen in Japan.jpg", "Armin Hofmann", "Alte und neue Formen in Japan", "1959"),
  ("1959 - Kunsthalle Basel - 4 Bildhauer.jpg", "Armin Hofmann", "4 Bildhauer", "1959"),
  ("1962 - Kunsthalle Basel - Rothko Chillida.jpg", "Armin Hofmann", "Rothko, Chillida", "1962"),
  ("Musica Viva. Müller-Brockmann.jpg", "Josef Müller-Brockmann", "Musica Viva", "1959"),
  ("Josef Müller-Brockmann der Film.jpg", "Josef Müller-Brockmann", "Der Film", "1960"),
  ("Josef Müller-Brockmann. beethoven poster(1955).jpg", "Josef Müller-Brockmann", "Beethoven", "1955"),
 ],
 "br": [
  ("Trellick Tower 02.JPG", "Ernő Goldfinger", "Trellick Tower, фото Edwardx", "1972"),
  ("Barbican Estate 2007-03-08.jpg", "Chamberlin, Powell and Bon", "Barbican Estate, фото Ewan-M", ""),
  ("Boston city hall.jpg", "Kallmann McKinnell & Knowles", "Boston City Hall, фото Daniel Schwen", "1968"),
  ("Habitat 67 in winter.jpg", "Moshe Safdie", "Habitat 67, фото AlainV", "1967"),
  ("Sheffield, Park Hill flats - geograph.org.uk - 793583.jpg", "Jack Lynn, Ivor Smith", "Park Hill, фото Chris Downer", ""),
  ("Unité d'Habitation de Marseille 4.JPG", "Le Corbusier", "Unité d'Habitation, фото Anapuig", "1952"),
  ("Alexandra Road Estate - 2024-06-23 - 21.jpg", "Neave Brown", "Alexandra Road Estate, фото Felipe Tofani", "1978"),
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
