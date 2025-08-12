#!/usr/bin/env python3
"""
git_wizard.py — small helper for common Git chores

Features:
  1) Commit all changes (prompts for a message)
  2) Show history (graph with dates/times)
  3) Checkout a specific revision (auto-stash if you have local changes)
  4) Restore a single file from a specific revision (without switching branches)
  5) Push the current branch to origin

Run:  python3 git_wizard.py
"""

import subprocess as sp
import sys
import os
from datetime import datetime

# ---------------- helpers ----------------
def run(cmd, check=True, capture=True, cwd=None):
    """Run a shell command and return stdout text."""
    res = sp.run(cmd, check=check, cwd=cwd, text=True,
                 stdout=sp.PIPE if capture else None,
                 stderr=sp.STDOUT if capture else None)
    return (res.stdout or "").strip() if capture else ""

def safe_run(cmd):
    """Run a shell command; return (ok, output)."""
    try:
        out = run(cmd, check=True, capture=True)
        return True, out
    except sp.CalledProcessError as e:
        return False, e.stdout or str(e)

def confirm(q, default="y"):
    yn = "[Y/n]" if default.lower().startswith("y") else "[y/N]"
    while True:
        ans = input(f"{q} {yn} ").strip().lower()
        if not ans:
            return default.lower().startswith("y")
        if ans in ("y", "yes"): return True
        if ans in ("n", "no"):  return False
        print("Please answer y or n.")

def repo_root():
    ok, out = safe_run(["git", "rev-parse", "--show-toplevel"])
    if not ok:
        print("❌ Not inside a Git repository. Aborting.")
        sys.exit(1)
    return out

def current_branch():
    ok, out = safe_run(["git", "rev-parse", "--abbrev-ref", "HEAD"])
    return out if ok else "(unknown)"

def has_uncommitted_changes():
    ok, out = safe_run(["git", "status", "--porcelain"])
    return ok and bool(out.strip())

def pretty_status():
    ok, out = safe_run(["git", "status", "-sb"])
    print(out)

def show_history(limit=30):
    fmt = "%C(yellow)%h%Creset  %Cgreen%ad%Creset  %C(bold cyan)%d%Creset %s %C(blue)<%an>"
    cmd = ["git", "log", f"--max-count={limit}", "--graph", "--decorate",
           "--date=local", f"--pretty=format:{fmt}"]
    ok, out = safe_run(cmd)
    if ok:
        print(out)
    else:
        print("❌ Could not get history:\n", out)

def commit_all():
    print("\n— Stage all changes —")
    ok, out = safe_run(["git", "add", "-A"])
    if not ok:
        print("❌ git add failed:\n", out); return

    # Show what will be committed
    ok, diff = safe_run(["git", "status", "--short"])
    print("\nChanges to commit:")
    print(diff or "(none)")

    # If nothing staged, bail politely
    if not diff.strip():
        print("Nothing to commit.")
        return

    print("\nEnter a commit message. Press ENTER for a single-line message.")
    msg = input("Commit message: ").strip()
    if not msg:
        msg = f"Update on {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"

    ok, out = safe_run(["git", "commit", "-m", msg])
    if ok:
        print(out)
    else:
        print("❌ Commit failed:\n", out); return

    if confirm("Push to origin now?"):
        br = current_branch()
        ok, out = safe_run(["git", "push", "-u", "origin", br])
        print(out if ok else f"❌ Push failed:\n{out}")

def checkout_revision():
    print("\n— Checkout a revision (whole repo) —")
    show_history(20)
    rev = input("\nEnter a commit SHA / tag / branch to checkout (blank to cancel): ").strip()
    if not rev: return

    if has_uncommitted_changes():
        print("You have local changes.")
        if confirm("Stash them first? Recommended."):
            msg = f"git_wizard auto-stash {datetime.now().isoformat(timespec='seconds')}"
            ok, out = safe_run(["git", "stash", "push", "-u", "-m", msg])
            print(out if ok else f"❌ Stash failed:\n{out}")
        else:
            print("Continuing without stashing…")

    if confirm(f"Checkout '{rev}' (detached if not a branch)?"):
        ok, out = safe_run(["git", "checkout", rev])
        print(out if ok else f"❌ Checkout failed:\n{out}")
        if ok and confirm("Create a new branch here?"):
            newb = input("New branch name: ").strip()
            if newb:
                ok2, out2 = safe_run(["git", "switch", "-c", newb])
                print(out2 if ok2 else f"❌ Branch create failed:\n{out2}")

def restore_file_from_revision():
    print("\n— Restore a single file from a past revision (no branch switch) —")
    show_history(15)
    rev = input("\nRevision (SHA / tag / branch): ").strip()
    if not rev: return
    path = input("Path to file to restore (e.g., static/app.js): ").strip()
    if not path: return
    if not os.path.exists(path):
        print("⚠️  File doesn't exist in working tree; it will be created from the revision if present.")

    # Prefer modern 'git restore -s', fall back to older 'git checkout <rev> -- <path>'
    ok, out = safe_run(["git", "restore", "-s", rev, "--", path])
    if ok:
        print(f"Restored {path} from {rev}.\nRemember to commit if you want to keep it.")
        return

    print("git restore not available or failed; trying legacy checkout…")
    ok2, out2 = safe_run(["git", "checkout", rev, "--", path])
    print((f"Restored {path} from {rev} (legacy)."
           if ok2 else f"❌ Could not restore file:\n{out2}"))

def push_current():
    br = current_branch()
    if confirm(f"Push current branch '{br}' to origin?"):
        ok, out = safe_run(["git", "push", "-u", "origin", br])
        print(out if ok else f"❌ Push failed:\n{out}")

def main():
    root = repo_root()
    os.chdir(root)
    print(f"\n📁 Repo: {root}")
    print(f"🌿 Branch: {current_branch()}\n")
    pretty_status()

    while True:
        print("\nWhat do you want to do?")
        print("  1) Commit ALL changes")
        print("  2) Show history")
        print("  3) Checkout a revision (whole repo)")
        print("  4) Restore a single file from a revision")
        print("  5) Push current branch")
        print("  6) Quit")
        choice = input("> ").strip()

        try:
            if choice == "1": commit_all()
            elif choice == "2": show_history(40)
            elif choice == "3": checkout_revision()
            elif choice == "4": restore_file_from_revision()
            elif choice == "5": push_current()
            elif choice == "6" or choice.lower() in ("q","quit","exit"):
                print("Bye!"); break
            else:
                print("Pick 1–6.")
        except KeyboardInterrupt:
            print("\n(Interrupted)")

if __name__ == "__main__":
    main()
