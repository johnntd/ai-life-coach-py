from openai import OpenAI
import config

client = OpenAI(api_key=config.OPENAI_API_KEY)

def build_messages(name, age, lang, mode, objective, history, user_text):
    from prompts.master_prompt import MASTER_PROMPT
    sys = MASTER_PROMPT.replace("{{name}}", name)\
                       .replace("{{age}}", str(age))\
                       .replace("{{lang}}", lang)\
                       .replace("{{mode}}", mode)\
                       .replace("{{objective}}", objective)
    msgs = [{"role": "system", "content": sys}]
    # include short history window (assistant/user pairs)
    for h in history[-6:]:
        msgs.append({"role": h["role"], "content": h["content"]})
    msgs.append({"role": "user", "content": user_text})
    return msgs

def chat(name="Emily", age=5, lang="en", mode="child",
         objective="gentle warm‑up",
         history=None, user_text="Hello!"):
    history = history or []
    messages = build_messages(name, age, lang, mode, objective, history, user_text)
    # Primary call
    try:
        resp = client.chat.completions.create(
            model=config.PRIMARY_MODEL,
            messages=messages,
            max_completion_tokens=config.MAX_COMPLETION_TOKENS,
            temperature=config.TEMPERATURE_PRIMARY
        )
        text = resp.choices[0].message.content.strip()
        return text + f" [[MODEL:{config.PRIMARY_MODEL}]]", config.PRIMARY_MODEL
    except Exception as e:
        # Fallback
        resp = client.chat.completions.create(
            model=config.FALLBACK_MODEL,
            messages=messages,
            max_completion_tokens=config.MAX_COMPLETION_TOKENS,
            temperature=config.TEMPERATURE_FALLBACK
        )
        text = resp.choices[0].message.content.strip()
        return text + f" [[MODEL:{config.FALLBACK_MODEL}]]", config.FALLBACK_MODEL
