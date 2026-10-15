import importlib.util,tempfile,subprocess
from pathlib import Path
def module(n,f):
 s=importlib.util.spec_from_file_location(n,Path(__file__).parent/f);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
g=module('guard','claude-website-guard.py');m=module('release','release-website.py')
for cmd,blocked in [('vercel --prod --yes',True),('vercel promote old-url',True),('vercel inspect www.gostaffify.com',False),('python3 scripts/release-website.py --publish',False)]:
 assert bool(g.decision({'hook_event_name':'PreToolUse','cwd':'/tmp/staffify-site','tool_name':'Bash','tool_input':{'command':cmd}}))==blocked
assert g.decision({'hook_event_name':'PreToolUse','cwd':'/tmp/unrelated','tool_name':'Bash','tool_input':{'command':'vercel --prod'}}) is None
with tempfile.TemporaryDirectory() as d:
 p=Path(d);remote=p/'remote';w=p/'work'
 def run(*a,cwd=None):
  r=subprocess.run(['git',*a],cwd=cwd,capture_output=True);assert r.returncode==0
 run('init','--bare',str(remote));run('clone',str(remote),str(w));run('config','user.email','test@example.test',cwd=w);run('config','user.name','Test',cwd=w);run('checkout','-b','main',cwd=w)
 (w/'a').write_text('a');run('add','a',cwd=w);run('commit','-m','base',cwd=w);run('push','origin','main',cwd=w);m.ROOT=w;m.check()
 (w/'a').write_text('dirty')
 try:m.check();raise AssertionError('dirty accepted')
 except RuntimeError:pass
 run('checkout','--','a',cwd=w);run('checkout','-b','old',cwd=w);run('checkout','main',cwd=w);(w/'a').write_text('new');run('commit','-am','new',cwd=w);run('push','origin','main',cwd=w);run('checkout','old',cwd=w)
 try:m.check();raise AssertionError('stale accepted')
 except RuntimeError:pass
print('PASS: production hook, read-only/unrelated exemptions, clean/dirty/stale release checks')
