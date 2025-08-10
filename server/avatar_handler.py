# server/avatar_handler.py
from typing import Tuple

def strip_and_extract_cues(text: str) -> Tuple[str, list[str]]:
    """
    Pulls [[CUE_*]] tags from the end of a reply and returns (clean_text, cues_list).
    Your frontend can map these to avatar animations (smile, clap, think, etc.).
    """
    cues = []
    clean = text
    while "[[CUE_" in clean:
        # naive parse: remove last [[CUE_...]] if at end
        idx = clean.rfind("[[CUE_")
        if idx == -1:
            break
        tail = clean[idx:]
        if "]]" in tail:
            cues.append(tail.strip("[]"))
            clean = clean[:idx].rstrip()
        else:
            break
    return clean, cues
