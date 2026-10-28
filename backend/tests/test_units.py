"""Tests unitaires : horodatages, sous-titres, transcription, sélection IA, cadrage."""
from __future__ import annotations

import subprocess
from types import SimpleNamespace

import pytest

from app.pipeline import framing, scoring, segmentation, selection, subtitles, transcription
from app.pipeline.render import RenderSpec, render
from app.pipeline.media import probe


def W(text: str, start: float = 0.0, step: float = 0.4, gaps: dict[int, float] | None = None) -> list[dict]:
    out, t = [], start
    for i, w in enumerate(text.split()):
        t += (gaps or {}).get(i, 0)
        out.append({"w": w, "s": round(t, 3), "e": round(t + step - 0.05, 3)})
        t += step
    return out


# --------------------------------------------------------------------------- horodatages
def test_split_sentences_on_punctuation_and_pauses():
    words = W("Bonjour à tous. Voici le plan aujourd'hui et ensuite on verra", gaps={6: 1.5})
    s = segmentation.split_sentences(words)
    assert [x.text for x in s] == ["Bonjour à tous.", "Voici le plan", "aujourd'hui et ensuite on verra"]
    assert s[1].start == words[3]["s"]


def _sentences(n=10, dur=5.0):
    words, t = [], 0.0
    for i in range(n):
        for j in range(10):
            words.append({"w": f"mot{i}_{j}" + ("." if j == 9 else ""), "s": t, "e": t + dur / 10 - 0.05})
            t += dur / 10
    return words, segmentation.split_sentences(words)


def test_validate_rejects_bad_indices_and_overlaps():
    words, sents = _sentences()
    raw = [
        {"start_sentence": 0, "end_sentence": 3, "score": 9},
        {"start_sentence": 1, "end_sentence": 4, "score": 8},  # chevauche
        {"start_sentence": 7, "end_sentence": 99, "score": 7},  # hors limites
        {"start_sentence": "x", "end_sentence": 2, "score": 6},
    ]
    valid, rejected = segmentation.validate_selections(raw, sents, words, 15, 30, 50, 5)
    assert len(valid) == 1 and valid[0].start_sentence == 0
    assert len(rejected) == 3


def test_validate_trims_too_long_and_extends_too_short():
    words, sents = _sentences()
    valid, _ = segmentation.validate_selections(
        [{"start_sentence": 0, "end_sentence": 9, "score": 5}, {"start_sentence": 8, "end_sentence": 8, "score": 4}],
        sents, words, 10, 20, 50, 5)
    assert all(10 - 0.5 <= v.duration <= 20 + 0.5 for v in valid)
    assert valid[0].end_sentence < 9


def test_keep_segments_removes_long_pauses_and_fillers():
    words = W("Une idée euh simple.", gaps={2: 0})
    words += [{"w": "Ensuite", "s": 5.0, "e": 5.4}, {"w": "fin.", "s": 5.5, "e": 5.9}]
    segs = segmentation.keep_segments(words, 0.0, 6.0, True)
    assert len(segs) == 2
    assert segmentation.total_duration(segs) < 4.5
    assert segmentation.keep_segments(words, 0, 6, remove_silences=False) == [(0, 6)]


def test_remap_words_to_clip_timeline():
    words = [{"w": "a", "s": 10.0, "e": 10.3}, {"w": "b", "s": 20.0, "e": 20.4}]
    out = segmentation.remap_words(words, [(9.8, 10.5), (19.9, 20.6)])
    assert out[0]["s"] == pytest.approx(0.2) and out[1]["s"] == pytest.approx(0.7 + 0.1)


# --------------------------------------------------------------------------- sous-titres
def test_ass_highlights_active_word_and_keywords():
    st = subtitles.SubtitleStyle(keywords=["argent"], uppercase=True)
    ass = subtitles.build_ass(W("Votre argent dort ici"), st)
    lines = [l for l in ass.splitlines() if l.startswith("Dialogue")]
    assert len(lines) == 4  # 2 groupes (3 + 1 mots), un événement par mot actif
    assert ass_color("#A78BFA") in lines[0] and "ARGENT" in lines[0]
    assert ass_color("#FACC15") in lines[0]  # mot-clé coloré quand il n'est pas actif


def ass_color(h):
    return subtitles.ass_color(h)


def test_subtitle_word_mode_and_times():
    ass = subtitles.build_ass(W("un deux trois"), subtitles.SubtitleStyle(mode="word"))
    assert ass.count("Dialogue") == 3
    assert subtitles.ass_time(3725.456) == "1:02:05.46"
    assert subtitles.srt_time(61.5) == "00:01:01,500"


def test_subtitle_style_validation():
    with pytest.raises(Exception):
        subtitles.SubtitleStyle(text_color="red")
    with pytest.raises(Exception):
        subtitles.SubtitleStyle(size=999)


def test_srt_sync_is_monotonic():
    srt = subtitles.build_srt(W("a b c d e f g h i j k l m n o p", step=0.3))
    times = [l for l in srt.splitlines() if "-->" in l]
    assert len(times) >= 2 and times == sorted(times)


# --------------------------------------------------------------------------- transcription
def test_parse_srt_and_vtt():
    srt = "1\n00:00:01,000 --> 00:00:03,000\nBonjour <i>tout</i> le monde\n\n2\n00:00:04,000 --> 00:00:05,000\nSalut.\n"
    w = transcription.parse_subtitles(srt)
    assert [x["w"] for x in w] == ["Bonjour", "tout", "le", "monde", "Salut."]
    assert w[0]["s"] == 1.0 and w[3]["e"] <= 3.0
    vtt = "WEBVTT\n\n00:01.000 --> 00:02.500\nHello world\n"
    assert len(transcription.parse_subtitles(vtt)) == 2


def test_transcription_errors_are_reported():
    with pytest.raises(transcription.TranscriptionError):
        transcription.parse_subtitles("pas de sous-titres ici")
    with pytest.raises(transcription.TranscriptionError):
        transcription.clean_words([{"w": " ", "s": 0, "e": 1}])
    with pytest.raises(transcription.TranscriptionError):
        transcription.get_transcriber("inconnu")


def test_whisper_model_load_failure_is_explicit(monkeypatch):
    import faster_whisper

    def boom(*a, **k):
        raise OSError("network unreachable")
    monkeypatch.setattr(faster_whisper, "WhisperModel", boom)
    monkeypatch.setattr(transcription.FasterWhisperTranscriber, "_model", None)
    with pytest.raises(transcription.TranscriptionError, match="Hugging Face"):
        transcription.FasterWhisperTranscriber().transcribe(None, None, 10, lambda f: None)


def test_clean_words_enforces_order():
    out = transcription.clean_words([{"w": "a", "s": 1.0, "e": 0.9}, {"w": "b", "s": 0.5, "e": 1.2}])
    assert out[0]["e"] > out[0]["s"] and out[1]["s"] >= out[0]["e"] - 0.05


def test_merge_punctuation_from_segments():
    words = [{"w": "bonjour", "s": 0, "e": 1}, {"w": "ça", "s": 1, "e": 2}, {"w": "va", "s": 2, "e": 3}]
    out = transcription.merge_punctuation(words, [{"text": " Bonjour, ça va ?"}])
    assert [w["w"] for w in out] == ["Bonjour,", "ça", "va"]


# --------------------------------------------------------------------------- sélection IA (client simulé)
def _fake_anthropic(payload):
    class Msgs:
        def create(self, **kw):
            assert kw["tool_choice"]["name"] == "submit_clips"
            return SimpleNamespace(
                content=[SimpleNamespace(type="tool_use", id="t1", input=payload)],
                usage=SimpleNamespace(input_tokens=1200, output_tokens=300))
    return lambda **kw: SimpleNamespace(messages=Msgs())


def test_anthropic_selector_structured_output(monkeypatch):
    import anthropic
    from app.config import settings
    payload = {"clips": [{
        "start_sentence": 0, "end_sentence": 2, "title_options": ["A", "B", "C"], "hooks": ["h"],
        "description": "d", "hashtags": ["#shorts"], "keywords": ["mot0_1"], "thumbnail_sentence": 1,
        "scores": {"hook": 8, "clarity": 7, "interest": 9, "payoff": 6}, "reason": "Bonne accroche",
    }]}
    monkeypatch.setattr(anthropic, "Anthropic", _fake_anthropic(payload))
    monkeypatch.setattr(settings, "anthropic_api_key", "test")
    words, sents = _sentences()
    res = selection.AnthropicSelector().select(sents, words, "fr", 1, 10, 30)
    assert res.provider == "anthropic" and res.usage == {"in": 1200, "out": 300}
    assert res.proposals[0]["scores"]["hook"] == 8


def test_invalid_ai_output_is_rejected(monkeypatch):
    import anthropic
    from app.config import settings
    bad = {"clips": [{"start_sentence": 0, "end_sentence": 1, "title_options": [], "scores": {"hook": 42}, "reason": "x"}]}
    monkeypatch.setattr(anthropic, "Anthropic", _fake_anthropic(bad))
    monkeypatch.setattr(settings, "anthropic_api_key", "test")
    words, sents = _sentences()
    with pytest.raises(selection.SelectionError, match="invalide"):
        selection.AnthropicSelector().select(sents, words, "fr", 1, 10, 30)


def test_missing_api_key_is_not_retryable(monkeypatch):
    from app.config import settings
    from app.worker import is_retryable
    monkeypatch.setattr(settings, "anthropic_api_key", "")
    words, sents = _sentences()
    with pytest.raises(selection.SelectionError) as e:
        selection.AnthropicSelector().select(sents, words, "fr", 1, 10, 30)
    assert not is_retryable(e.value)


def test_score_is_explainable_and_bounded():
    sub = {"hook": 10, "clarity": 10, "pace": 10, "interest": 10, "payoff": 10}
    assert scoring.combine(sub) == 100
    assert scoring.combine({k: 99 for k in sub}) == 100
    pace, details = scoring.measured_pace(W("un deux trois quatre cinq six", step=0.35), 0, 2.1)
    assert 0 <= pace <= 10 and details["words_per_second"] > 0


# --------------------------------------------------------------------------- cadrage
def test_plan_shots_ignores_jitter_and_follows_real_moves():
    samples = [(i * 0.4, 0.30 + (0.02 if i % 2 else 0)) for i in range(10)]
    samples += [(4 + i * 0.4, 0.75) for i in range(10)]
    shots = framing.plan_shots(samples)
    assert len(shots) == 2 and shots[1][1] == pytest.approx(0.75)
    assert framing.plan_shots([(0, None), (0.4, None)]) == [(0.0, 0.5)]


def test_dynamic_crop_expression_renders(tmp_path, sample_video):
    out = tmp_path / "o.mp4"
    render(RenderSpec(source=sample_video, src_width=1280, src_height=720, fps=25,
                      segments=[(1.0, 3.0), (5.0, 7.0)], shots=[(0.0, 0.2), (2.0, 0.8)],
                      ass_file=None, output=out), on_progress=None)
    info = probe(out)
    assert (info.width, info.height) == (1080, 1920) and abs(info.duration - 4.0) < 0.3


def test_face_detection_on_frames_without_faces(sample_video):
    samples = framing.sample_face_centers(sample_video, [(0, 2)])
    assert samples and all(c is None for _, c in samples)
