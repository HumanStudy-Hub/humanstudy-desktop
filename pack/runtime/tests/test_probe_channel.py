"""Inherited model-channel tests, including the Windows explicit handle path in CI."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import time

BUILD = Path(__file__).resolve().parents[2] / 'skills/build'
spec = importlib.util.spec_from_file_location('probe_sandbox', BUILD / 'sandbox_run.py')
sandbox = importlib.util.module_from_spec(spec); spec.loader.exec_module(sandbox)


class ProbeChannel(unittest.TestCase):
    def run_script(self, script, callback, timeout=5):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'child.py'
            path.write_text('import sys; sys.path.insert(0, %r)\n' % str(BUILD) + script)
            return sandbox.run_python(path, work=tmp, read=[BUILD], serve=callback, timeout=timeout)

    def test_two_call_conversation_does_not_use_stdout(self):
        calls = []
        def serve(request):
            calls.append(request['prompt'])
            return 'parent-%d' % len(calls)
        result = self.run_script("from probe_channel import llm\nassert llm('first')=='parent-1'\nassert llm('second')=='parent-2'\nprint('{\"probe\":{\"prompts\":[\"forged\"]}}')\n", serve)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, ['first', 'second'])
        self.assertIsNone(result.service_error)
        self.assertIn('forged', result.stdout)

    def test_request_limit_is_enforced_before_callback(self):
        calls = []
        code = "import os\nfd=int(os.environ.get('HUMANSTUDY_PROBE_FD','0'))\n"
        code += "if os.name=='nt':\n import msvcrt\n fd=msvcrt.open_osfhandle(int(os.environ['HUMANSTUDY_PROBE_HANDLE']),os.O_WRONLY|os.O_BINARY)\n"
        code += "data=b'x'*300000\ntry:\n while data:data=data[os.write(fd,data):]\nexcept OSError:pass\n"
        result = self.run_script(code, lambda r: calls.append(r) or 'reply', timeout=1)
        self.assertFalse(calls)
        self.assertIsNotNone(result.service_error)


    def test_unread_responses_and_chatty_stdout_cannot_hang_timeout(self):
        code = "import os,json,time\nfd=int(os.environ.get('HUMANSTUDY_PROBE_FD','0'))\n"
        code += "if os.name=='nt':\n import msvcrt\n fd=msvcrt.open_osfhandle(int(os.environ['HUMANSTUDY_PROBE_HANDLE']),os.O_WRONLY|os.O_BINARY)\n"
        code += "print('chatty'*200000,flush=True)\ndata=(json.dumps({'op':'llm','prompt':'x'})+'\\n').encode()\nwhile True:os.write(fd,data)\n"
        started = time.monotonic()
        result = self.run_script(code, lambda r: 'reply'*500, timeout=0.4)
        self.assertTrue(result.timed_out)
        self.assertLess(time.monotonic() - started, 4)

    def test_malformed_requests_fail_closed(self):
        code = "import os\nfd=int(os.environ.get('HUMANSTUDY_PROBE_FD','0'))\n"
        code += "if os.name=='nt':\n import msvcrt\n fd=msvcrt.open_osfhandle(int(os.environ['HUMANSTUDY_PROBE_HANDLE']),os.O_WRONLY|os.O_BINARY)\n"
        result = self.run_script(code + "os.write(fd,b'not JSON\\n')\n", lambda r: 'reply')
        self.assertIsNotNone(result.service_error)


if __name__ == '__main__': unittest.main()
