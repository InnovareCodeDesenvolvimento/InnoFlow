"""
Gera os derivados do mascote da landing a partir de `Mascote_InnoFlow.png` (raiz do repositório).

Uso (a partir de `frontend/`):  python scripts/gerar-mascote.py

Por que existe: o PNG original (1145x1374, 1,7 MB) traz um halo semitransparente esverdeado ao redor do
robô (o "brilho" da arte). Sobre fundo claro ele vira uma nuvem suja; sobre o escuro, uma mancha desigual.
A landing aplica o próprio brilho em CSS (controlável, animável), então aqui o halo é REMOVIDO:

  1. máscara = alpha original >= 140 (o corpo é opaco, o halo fica abaixo de ~100);
  2. mediana 5x5 (tira salpicos), erosão 1px (tira a franja de halo na borda) e desfoque gaussiano 1,1px;
  3. curva em torno de 0,5 => borda suave (anti-alias) sem halo.

Saídas (em `src/assets/landing/`, importadas com hash pelo Vite):
  mascote-{320,480,640,900}.webp   corpo inteiro recortado (srcset do hero e do CTA final)
  mascote-rosto-{64,128}.webp      rosto em quadrado (avatar do selo do hero e do rodapé)
Requer Pillow + numpy.
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

RAIZ = Path(__file__).resolve().parents[2]
FONTE = RAIZ / "Mascote_InnoFlow.png"
SAIDA = Path(__file__).resolve().parents[1] / "src" / "assets" / "landing"
SAIDA.mkdir(parents=True, exist_ok=True)

src = Image.open(FONTE).convert("RGBA")
a = np.array(src)

mask = Image.fromarray(((a[:, :, 3] >= 140) * 255).astype("uint8"))
mask = mask.filter(ImageFilter.MedianFilter(5)).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(1.1))
m = np.clip((np.array(mask).astype("float32") / 255.0 - 0.35) / 0.45, 0, 1)
a[:, :, 3] = (m * 255).astype("uint8")
limpo = Image.fromarray(a)

# corpo inteiro: recorta no conteúdo (+ margem de 6px) para não carregar área transparente
x0, y0, x1, y1 = limpo.getbbox()
corpo = limpo.crop((max(0, x0 - 6), max(0, y0 - 6), min(limpo.width, x1 + 6), min(limpo.height, y1 + 6)))
print("corpo", corpo.size)
for w in (320, 480, 640, 900):
    h = round(corpo.height * w / corpo.width)
    corpo.resize((w, h), Image.LANCZOS).save(SAIDA / f"mascote-{w}.webp", "WEBP", quality=82, alpha_quality=90, method=6)
    print(f"mascote-{w}.webp", w, h, (SAIDA / f"mascote-{w}.webp").stat().st_size)

# rosto (capacete): quadrado de 660px no original
rosto = limpo.crop((255, 5, 915, 665))
for w in (64, 128):
    rosto.resize((w, w), Image.LANCZOS).save(SAIDA / f"mascote-rosto-{w}.webp", "WEBP", quality=85, alpha_quality=90, method=6)
    print(f"mascote-rosto-{w}.webp", (SAIDA / f"mascote-rosto-{w}.webp").stat().st_size)
