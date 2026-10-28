"""Recadrage vertical intelligent : suivi du visage du locuteur.

On échantillonne la vidéo (~2,5 images/s) sur les segments conservés, détecte
les visages (OpenCV, cascade de Haar — rapide, sans GPU), puis on construit des
« plans » à cadrage fixe : le cadre ne bouge que lorsque le visage s'est
déplacé nettement et durablement. Cela évite l'effet de tremblement d'un suivi
image par image et ressemble à un recadrage fait à la main.
"""
from __future__ import annotations

from pathlib import Path
from statistics import median

from ..config import settings  # noqa: F401

CASCADE = Path(__file__).resolve().parent.parent / "assets" / "haarcascade_frontalface_default.xml"


def _detector():
    import cv2

    det = cv2.CascadeClassifier(str(CASCADE))
    if det.empty():
        raise RuntimeError(f"Classifieur de visages introuvable : {CASCADE}")
    return det


def sample_face_centers(video: Path, segments: list[tuple[float, float]], step: float = 0.4) -> list[tuple[float, float | None]]:
    """Retourne [(temps_clip, centre_x_normalisé | None)]."""
    import cv2

    det = _detector()
    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        return []
    out: list[tuple[float, float | None]] = []
    offset = 0.0
    try:
        for s, e in segments:
            t = s
            while t < e:
                cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
                ok, frame = cap.read()
                if not ok:
                    break
                h, w = frame.shape[:2]
                scale = 360 / h if h > 360 else 1.0
                small = cv2.resize(frame, (int(w * scale), int(h * scale))) if scale != 1.0 else frame
                gray = cv2.equalizeHist(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY))
                faces = det.detectMultiScale(gray, scaleFactor=1.15, minNeighbors=6, minSize=(int(24), int(24)))
                cx = None
                if len(faces):
                    x, y, fw, fh = max(faces, key=lambda f: f[2] * f[3])  # plus grand visage = locuteur probable
                    cx = (x + fw / 2) / small.shape[1]
                out.append((round(offset + t - s, 3), cx))
                t += step
            offset += e - s
    finally:
        cap.release()
    return out


def plan_shots(samples: list[tuple[float, float | None]], move_threshold: float = 0.12, hold: int = 3) -> list[tuple[float, float]]:
    """Transforme des échantillons bruités en plans à cadrage fixe [(t_début, centre_x)]."""
    known = [c for _, c in samples if c is not None]
    if not known:
        return [(0.0, 0.5)]
    fallback = median(known)
    filled: list[tuple[float, float]] = []
    last = fallback
    for t, c in samples:
        last = c if c is not None else last
        filled.append((t, last))
    # lissage médian sur 5 échantillons
    sm = []
    for i, (t, _) in enumerate(filled):
        win = [c for _, c in filled[max(0, i - 2) : i + 3]]
        sm.append((t, median(win)))
    shots = [(0.0, sm[0][1])]
    i = 0
    while i < len(sm):
        cur = shots[-1][1]
        if abs(sm[i][1] - cur) > move_threshold:
            run = sm[i : i + hold]
            if len(run) == hold and all(abs(c - cur) > move_threshold for _, c in run):
                shots.append((sm[i][0], median(c for _, c in run)))
                i += hold
                continue
        i += 1
    return [(round(t, 3), round(c, 4)) for t, c in shots]


def crop_x_expression(shots: list[tuple[float, float]], src_w: int, crop_w: int) -> str:
    """Expression FFmpeg (évaluée à chaque image) donnant le x du recadrage."""
    def x_for(cx: float) -> int:
        return int(max(0, min(src_w - crop_w, cx * src_w - crop_w / 2)))

    expr = str(x_for(shots[-1][1]))
    for i in range(len(shots) - 2, -1, -1):
        cx, nxt = shots[i][1], shots[i + 1][0]
        expr = f"if(lt(t\\,{nxt:.3f})\\,{x_for(cx)}\\,{expr})"
    return expr
