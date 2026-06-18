"""
Unit tests for _compute_scores — the pure contribution-scoring function.

Tests cover: normal distribution, zero-contribution members, no edits at all,
non-member edits ignored, single member, percentages summing to 100.
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from bson import ObjectId
from routers.contributions import _compute_scores


def _member(name: str, email: str) -> dict:
    return {"_id": ObjectId(), "name": name, "email": email}


def _stats(email: str, chars: int, edits: int = 1) -> dict:
    return {"name": email, "edits": edits, "chars_added": chars}


# ── helpers ──────────────────────────────────────────────────────────────────

def score_for(scores: list[dict], email: str) -> float | None:
    for s in scores:
        if s["email"] == email.lower():
            return s["score"]
    return None


# ── tests ─────────────────────────────────────────────────────────────────────

def test_two_members_proportional():
    alice = _member("Alice", "alice@test.com")
    bob = _member("Bob", "bob@test.com")
    stats = {
        "alice@test.com": _stats("alice@test.com", chars=300),
        "bob@test.com": _stats("bob@test.com", chars=100),
    }
    scores = _compute_scores(stats, [alice, bob])
    assert len(scores) == 2
    assert score_for(scores, "alice@test.com") == 75.0
    assert score_for(scores, "bob@test.com") == 25.0


def test_percentages_sum_to_100():
    members = [_member(f"u{i}", f"u{i}@test.com") for i in range(4)]
    stats = {
        "u0@test.com": _stats("u0@test.com", chars=50),
        "u1@test.com": _stats("u1@test.com", chars=150),
        "u2@test.com": _stats("u2@test.com", chars=200),
        "u3@test.com": _stats("u3@test.com", chars=100),
    }
    scores = _compute_scores(stats, members)
    total = sum(s["score"] for s in scores)
    # Allow 0.1 rounding tolerance per member
    assert abs(total - 100.0) <= len(members) * 0.1


def test_zero_contribution_member_gets_zero():
    alice = _member("Alice", "alice@test.com")
    bob = _member("Bob", "bob@test.com")
    stats = {
        "alice@test.com": _stats("alice@test.com", chars=500),
        # bob not in stats — made no edits
    }
    scores = _compute_scores(stats, [alice, bob])
    assert len(scores) == 2
    assert score_for(scores, "alice@test.com") == 100.0
    assert score_for(scores, "bob@test.com") == 0.0


def test_non_member_edits_ignored():
    alice = _member("Alice", "alice@test.com")
    stats = {
        "alice@test.com": _stats("alice@test.com", chars=200),
        "teacher@school.edu": _stats("teacher@school.edu", chars=9999),  # not a group member
    }
    scores = _compute_scores(stats, [alice])
    # Only alice should appear; teacher is excluded
    assert len(scores) == 1
    assert score_for(scores, "alice@test.com") == 100.0
    assert score_for(scores, "teacher@school.edu") is None


def test_no_edits_at_all_returns_all_zeros():
    alice = _member("Alice", "alice@test.com")
    bob = _member("Bob", "bob@test.com")
    scores = _compute_scores({}, [alice, bob])
    assert len(scores) == 2
    assert all(s["score"] == 0.0 for s in scores)


def test_single_member_all_edits():
    alice = _member("Alice", "alice@test.com")
    stats = {"alice@test.com": _stats("alice@test.com", chars=1000)}
    scores = _compute_scores(stats, [alice])
    assert len(scores) == 1
    assert score_for(scores, "alice@test.com") == 100.0


def test_scores_sorted_descending():
    members = [_member(f"u{i}", f"u{i}@test.com") for i in range(3)]
    stats = {
        "u0@test.com": _stats("u0@test.com", chars=10),
        "u1@test.com": _stats("u1@test.com", chars=80),
        "u2@test.com": _stats("u2@test.com", chars=10),
    }
    scores = _compute_scores(stats, members)
    values = [s["score"] for s in scores]
    assert values == sorted(values, reverse=True)


def test_email_case_insensitive():
    """Stats key uses lowercase; member email stored with mixed case should still match."""
    alice = _member("Alice", "Alice@Test.COM")
    stats = {"alice@test.com": _stats("alice@test.com", chars=400)}
    scores = _compute_scores(stats, [alice])
    assert len(scores) == 1
    assert scores[0]["score"] == 100.0


def test_edits_field_preserved_in_output():
    alice = _member("Alice", "alice@test.com")
    stats = {"alice@test.com": _stats("alice@test.com", chars=100, edits=7)}
    scores = _compute_scores(stats, [alice])
    assert scores[0]["edits"] == 7


def test_chars_added_field_preserved():
    alice = _member("Alice", "alice@test.com")
    stats = {"alice@test.com": _stats("alice@test.com", chars=250)}
    scores = _compute_scores(stats, [alice])
    assert scores[0]["chars_added"] == 250


def test_empty_group_returns_empty():
    scores = _compute_scores({"someone@test.com": _stats("someone@test.com", chars=100)}, [])
    assert scores == []
