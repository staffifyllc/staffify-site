#!/usr/bin/env python3
"""Publish a committed Staffify release through Git, never a local Vercel upload."""
import argparse, subprocess, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
def git(*args):
    r = subprocess.run(['git', '-C', str(ROOT), *args], capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError('Git operation failed: ' + args[0] + '. Raw output withheld because the remote may contain credentials.')
    return r.stdout.strip()
def check():
    git('fetch', 'origin')
    if git('status', '--porcelain', '--untracked-files=no'):
        raise RuntimeError('Commit or preserve unfinished changes first; never deploy a dirty checkout.')
    tip = git('rev-parse', 'origin/main')
    head = git('rev-parse', 'HEAD')
    if git('merge-base', tip, head) != tip:
        raise RuntimeError('Outdated branch: merge origin/main and resolve changes before releasing. Never roll production back to a stale checkout.')
    return head
if __name__ == '__main__':
    p = argparse.ArgumentParser(); p.add_argument('--publish', action='store_true'); a = p.parse_args()
    try:
        head = check()
        print('Fresh, committed release:', head)
        if a.publish:
            git('push', 'origin', head + ':refs/heads/main')
            print('Pushed exact reviewed commit to main. Verify Vercel Ready and public HTML before reporting live.')
        else:
            print('Check only; nothing published.')
    except RuntimeError as e:
        print('RELEASE BLOCKED:', e, file=sys.stderr); sys.exit(1)
