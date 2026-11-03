"""No provider calls: hostile code and a normal completion against local stubs only."""
import http.server
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest

BUILD = Path(__file__).resolve().parents[2] / 'skills/build/sandbox_run.py'
spec = importlib.util.spec_from_file_location('relay_sandbox', BUILD)
sandbox = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sandbox)


@unittest.skipUnless(sys.platform == 'darwin', 'relay-only sandbox currently supported on macOS')
class RelaySandbox(unittest.TestCase):
    def test_hostile_package_cannot_read_keys_process_environments_or_direct_provider(self):
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers['content-length']))
                self.send_response(200); self.end_headers()
                self.wfile.write(b'{"choices":[{"message":{"content":"stub"}}]}')
            def log_message(self, *args):
                pass
        relay = http.server.HTTPServer(('127.0.0.1', 0), Handler)
        direct = http.server.HTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=relay.serve_forever, daemon=True).start()
        # Initial environment is intentionally populated with a fake sentinel in another process.
        holder = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], env={**os.environ, 'OPENROUTER_API_KEY': 'fake-upstream-sentinel'})
        try:
            with tempfile.TemporaryDirectory() as folder:
                script = Path(folder) / 'hostile.py'
                script.write_text('''import os, json, subprocess, urllib.request, socket, ctypes
assert os.environ['OPENROUTER_API_KEY'] == 'per-run-capability'
assert 'fake-upstream-sentinel' not in str(dict(os.environ))
try:
    proc = subprocess.run(['/bin/ps','eww','-p',PID], capture_output=True, text=True)
    assert 'fake-upstream-sentinel' not in proc.stdout
except PermissionError:
    pass
libc = ctypes.CDLL(None, use_errno=True)
mib = (ctypes.c_int * 3)(1,49,int(PID)); size=ctypes.c_size_t(65536); buf=ctypes.create_string_buffer(size.value)
assert libc.sysctl(mib,3,buf,ctypes.byref(size),None,0) != 0
assert b'fake-upstream-sentinel' not in buf.raw
try:
    socket.create_connection(('127.0.0.1',DIRECT), timeout=1)
    raise AssertionError('direct provider connection escaped')
except (PermissionError, OSError):
    pass
req=urllib.request.Request(BASE+'/chat/completions', data=b'{}',headers={'Authorization':'Bearer '+os.environ['OPENROUTER_API_KEY']})
assert json.load(urllib.request.urlopen(req))['choices'][0]['message']['content']=='stub'
print('confined and relay completion passed')
'''.replace('PID', repr(str(holder.pid))).replace('DIRECT', str(direct.server_port)).replace('BASE', repr('http://127.0.0.1:%d/v1' % relay.server_port)))
                result = sandbox.run_python(script, work=folder, env={'OPENROUTER_API_KEY': 'per-run-capability'}, relay_port=relay.server_port)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('confined and relay completion passed', result.stdout)
        finally:
            holder.terminate(); holder.wait()
            relay.shutdown(); relay.server_close(); direct.server_close()

    def test_profile_has_only_one_relay_endpoint(self):
        profile = sandbox.macos_profile('/private/tmp/work', relay_port=12345)
        self.assertIn('(deny network*)', profile)
        self.assertIn('(deny process-info*)', profile)
        self.assertIn('(remote ip "localhost:12345")', profile)
        with self.assertRaises(ValueError):
            sandbox.macos_profile('/private/tmp/work', relay_port=True)


if __name__ == '__main__':
    unittest.main()
