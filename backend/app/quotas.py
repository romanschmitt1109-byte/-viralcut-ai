"""Quotas mensuels par offre et suivi des coûts des services externes."""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .config import PLANS, PlanLimits, settings
from .models import UsageRecord, User


class QuotaExceeded(Exception):
    pass


def plan_of(user: User) -> PlanLimits:
    return PLANS.get(user.plan, PLANS["free"])


def _month_start() -> datetime:
    n = datetime.now(timezone.utc)
    return datetime(n.year, n.month, 1, tzinfo=timezone.utc)


def usage_this_month(db: Session, user_id: str) -> dict[str, float]:
    rows = db.execute(
        select(UsageRecord.kind, func.sum(UsageRecord.amount), func.sum(UsageRecord.cost_eur))
        .where(UsageRecord.user_id == user_id, UsageRecord.created_at >= _month_start())
        .group_by(UsageRecord.kind)
    ).all()
    out: dict[str, float] = {"video_minutes": 0.0, "cost_eur": 0.0}
    for kind, amount, cost in rows:
        out[kind] = float(amount or 0)
        out["cost_eur"] += float(cost or 0)
    return out


def check_video_quota(db: Session, user: User, duration_s: float) -> None:
    plan = plan_of(user)
    minutes = duration_s / 60.0
    if minutes > plan.max_video_minutes:
        raise QuotaExceeded(
            f"Vidéo de {minutes:.0f} min : l'offre {plan.name} accepte au maximum {plan.max_video_minutes} min par vidéo."
        )
    used = usage_this_month(db, user.id)["video_minutes"]
    if used + minutes > plan.monthly_video_minutes:
        raise QuotaExceeded(
            f"Quota mensuel atteint : {used:.0f}/{plan.monthly_video_minutes} min utilisées, "
            f"cette vidéo nécessite {minutes:.1f} min."
        )


def record(db: Session, user_id: str, kind: str, amount: float, provider: str = "", project_id: str | None = None) -> None:
    cost = 0.0
    if kind == "asr_minutes" and provider == "openai":
        cost = amount * settings.cost_per_asr_minute
    elif kind == "llm_tokens_in":
        cost = amount / 1000 * settings.cost_per_1k_llm_input_tokens
    elif kind == "llm_tokens_out":
        cost = amount / 1000 * settings.cost_per_1k_llm_output_tokens
    db.add(UsageRecord(user_id=user_id, project_id=project_id, kind=kind, amount=amount, provider=provider, cost_eur=cost))
