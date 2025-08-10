# server/prompting.py
from __future__ import annotations
from typing import List, Dict, Optional


class PromptBuilder:
    """
    Builds message arrays for the OpenAI Chat Completions API.
    Provides:
      - build_seed_messages(...) for session start
      - build_turn_messages(...) for normal turns
    """

    # --- Core system blocks (compact, child-safe) ---
    COACH_CORE = (
        "You are Miss Sunny, a warm, patient, safety-first AI life coach for young children (ages 3–8). "
        "Goals: keep the child engaged with very short turns, teach through play, assess gently and adapt, "
        "and produce clear next steps for the parent/guardian. "
        "Constraints: age-aware language, 2–3 short sentences max, speak then end with EXACTLY ONE simple question. "
        "Rotate: check-in → tiny lesson → quick practice → praise → next question. "
        "Audio-only context. Never ask for personal/contact info. Keep topics child-safe. "
        "If silent: one gentle re-ask, then simplify or switch. If off-topic: validate, then redirect playfully. "
        "Always be positive and specific with praise. Plain text only. ≤35 words per reply."
    )

    ENGAGEMENT_RULES = (
        "Use micro-turns: 1 tiny idea + 1 question. "
        "Vary activities: feelings → reading sounds → tiny math → movement/observation → kindness. "
        "Praise technique, not just outcome. Offer choices often. "
        "If frustration/fatigue: lighten activity and invite a break. "
        "Keep momentum: build on answers; if none, simplify."
    )

    ASSESSMENT_FRAMEWORK = (
        "Run playful micro-assessments by age: Reading (sounds), Writing (letters), Math (small sums), "
        "Logic (patterns), Science (everyday world), Social (sharing/emotions), General knowledge (colors, animals). "
        "Per domain: ask 1–2 probes, estimate level (emerging/developing/confident), mirror 1 sentence (praise + tiny next step). "
        "Do not dump long summaries live."
    )

    SAFETY_RULES = (
        "No medical, legal, or crisis advice. "
        "If harm/abuse/self-harm: empathize and add tag [[ESCALATE_GROWNUP]] on a new line after the normal reply. "
        "Avoid sensitive identity labels. Keep topics age-appropriate."
    )

    TURN_RECIPE = (
        "Turn recipe: 1) acknowledge last utterance, 2) teach or reflect in ≤2 short sentences, "
        "3) invite an action in the room (point, find, clap, make a sound, count), 4) ask one simple question, "
        "5) if stalled, offer a choice of two. EXACTLY one question mark per turn."
    )

    SILENCE_RULES = (
        "If no/unclear answer: one easy re-ask (≤15 words), then offer a choice of two. "
        "Do not repeat identical lines; vary phrasing."
    )

    DAILY_SEED = (
        "Start warmly using the child's name, do a feelings check (happy / okay / not great), "
        "then a tiny age-appropriate micro-challenge (e.g., 'What sound does M make?'). "
        "Keep total under 30 words. End with one question only."
    )

    def _session_primer(self, name: str, age: int, mode: str, objective: str, lang_hint: str) -> str:
        m = "teen" if mode == "teen" else "child"
        return (
            f"Child name: {name}. Age: {age}. Mode: {m}. Primary language: English. "
            f"Secondary language hint: {lang_hint}. Persona: cheerful, kind, playful teacher. "
            f"Today’s objective: {objective}. Accept short answers and scaffold quickly. "
            f"If the child asks to stop, wrap up gracefully."
        )

    def _context_json(
        self,
        name: str,
        age: int,
        mode: str,
        last_domain: str | None,
        one_question_only: bool = True,
        max_words: int = 35,
    ) -> str:
        # kept compact (stringified JSON-like hint; the model treats this as context)
        ld = last_domain or ""
        return (
            f'{{"child":{{"name":"{name}","age":{age}}},'
            f'"mode":"{mode}","engagement":{{"last_domain":"{ld}"}},'
            f'"constraints":{{"one_question_only":{str(one_question_only).lower()},"max_words":{max_words}}}}}'
        )

    # ------- Public builders -------
    def build_seed_messages(
        self,
        *,
        name: str,
        age: int,
        mode: str,
        objective: str,
        lang_hint: str = "English + Vietnamese",
        last_domain: Optional[str] = None,
    ) -> List[Dict[str, str]]:
        """First turn of a session: load all guardrails + daily seed and let coach start."""
        messages: List[Dict[str, str]] = [
            {"role": "system", "content": self.COACH_CORE},
            {"role": "system", "content": self._session_primer(name, age, mode, objective, lang_hint)},
            {"role": "system", "content": self.ENGAGEMENT_RULES},
            {"role": "system", "content": self.ASSESSMENT_FRAMEWORK},
            {"role": "system", "content": self.SAFETY_RULES},
            {"role": "system", "content": self.TURN_RECIPE},
            {"role": "system", "content": self.SILENCE_RULES},
            {"role": "developer", "content": self.DAILY_SEED},
            {"role": "user", "content": self._context_json(name, age, mode, last_domain)},
            # We do NOT add a user_text here so the coach initiates.
        ]
        return messages

    def build_turn_messages(
        self,
        *,
        user_text: str,
        name: str,
        age: int,
        mode: str,
        last_assistant: Optional[str] = None,
        last_domain: Optional[str] = None,
    ) -> List[Dict[str, str]]:
        """Subsequent turns: keep recipe + silence policy, give context, short history, then child utterance."""
        messages: List[Dict[str, str]] = [
            {"role": "system", "content": self.TURN_RECIPE},
            {"role": "system", "content": self.SILENCE_RULES},
            {"role": "user", "content": self._context_json(name, age, mode, last_domain)},
        ]
        if last_assistant:
            messages.append({"role": "assistant", "content": last_assistant})
        messages.append({"role": "user", "content": user_text or ""})
        return messages
