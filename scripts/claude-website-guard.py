#!/usr/bin/env python3
"""Scoped Claude hook: route Staffify work to shared source, block direct uploads."""
import json, re, subprocess, sys
from pathlib import Path
SHARED = '/Users/paulchareth/Documents/Codex/2026-09-22/ca-x20/work/staffify-team-visuals'
MESSAGE = ('Staffify website source of truth: origin/main in ' + SHARED + '. Read WEBSITE_RELEASE.md before edits. '
           'Do not publish finance-cloud, old Claude checkouts or scratchpad copies. Preserve unfinished work; merge latest main. '
           'Use python3 scripts/release-website.py --publish for an authorized release. No direct Vercel production uploads, promotions or rollbacks.')
def scoped(cwd, text):
    if re.search(r'staffify|sfy-(?:stats|testimonial)', cwd + ' ' + text, re.I): return True
    try:
        root = subprocess.run(['git','-C',cwd,'rev-parse','--show-toplevel'],capture_output=True,text=True,timeout=2).stdout.strip()
        if not root: return False
        data = json.loads((Path(root)/'.vercel/project.json').read_text())
        return data.get('projectId') == 'prj_J4FaeeIYGKs4KcoLR3nUCGa4jvoY'
    except Exception: return False

def decision(data):
    event = data.get('hook_event_name',''); cwd = data.get('cwd','')
    inp = data.get('tool_input',{}); text = json.dumps(inp)
    if event in ('SessionStart','UserPromptSubmit'):
        if scoped(cwd, data.get('prompt','')) or 'Claude Code' in cwd:
            return {'hookSpecificOutput':{'hookEventName':event,'additionalContext':MESSAGE}}
        return None
    tool = data.get('tool_name','')
    if not scoped(cwd,text): return None
    command = inp.get('command','')
    direct = (re.search(r'\b(vercel|vc)\b',command) and re.search(r'--prod\b|--target[= ]+production|\b(promote|rollback)\b|\balias\s+(set|rm)\b|/deployments.*(?:POST|PATCH)',command))
    connector = 'vercel' in tool.lower() and any(x in tool.lower() for x in ('create_deployment','promote','rollback','assign_alias'))
    if direct or connector:
        return {'hookSpecificOutput':{'hookEventName':'PreToolUse','permissionDecision':'deny','permissionDecisionReason':MESSAGE}}
    return None
if __name__ == '__main__':
    result = decision(json.load(sys.stdin))
    if result: print(json.dumps(result))
