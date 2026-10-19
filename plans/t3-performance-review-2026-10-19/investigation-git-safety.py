"""Harmless bare-discovery fixture; no hooks, network, or user Git configuration."""
from pathlib import Path
import tempfile, subprocess, os, json
output = Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix='git-safety-', dir=output) as fixture:
    environment = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    environment.update(GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_NOSYSTEM='1', GIT_OPTIONAL_LOCKS='0')
    def git(*arguments):
        result = subprocess.run(['git', *arguments], cwd=fixture, env=environment, text=True, capture_output=True)
        return {'code': result.returncode, 'stdout': result.stdout.strip().replace(fixture, '<fixture>'), 'stderr': result.stderr.strip().replace(fixture, '<fixture>')}
    results = {'version': git('--version'), 'init': git('init', '--bare', '--quiet', '.')}
    results['setMarker'] = git('--git-dir', fixture, 'config', 'audit.syntheticMarker', 'fixture-only')
    results['implicitConfig'] = git('config', '--get', 'audit.syntheticMarker')
    results['implicitRoot'] = git('rev-parse', '--git-common-dir')
    results['guardedRoot'] = git('-c', 'safe.bareRepository=explicit', 'rev-parse', '--git-common-dir')
    results['explicitRoot'] = git('-c', 'safe.bareRepository=explicit', '--git-dir', fixture, 'rev-parse', '--git-common-dir')
    (output / 'investigation-git-safety.json').write_text(json.dumps(results, indent=2) + '\n')
    assert results['implicitConfig']['stdout'] == 'fixture-only'
    assert results['implicitRoot']['code'] == 0
    assert results['guardedRoot']['code'] != 0
    assert results['explicitRoot']['code'] == 0
    print('4 harmless Git discovery checks passed')
