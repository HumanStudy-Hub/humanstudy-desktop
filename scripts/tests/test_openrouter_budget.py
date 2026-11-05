import json
import sys
import threading
import tempfile
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from openrouter_budget import BudgetRelay


class BudgetTests(unittest.TestCase):
    def test_usage_and_budget_gate(self):
        calls = []

        class Stub(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                calls.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps({'id': 'stub-generation', 'usage': {'cost': .1}}).encode())

        server = HTTPServer(('127.0.0.1', 0), Stub)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        meta = {'pricing': {'prompt': '.001', 'completion': '.001'}, 'context_length': 100,
                'top_provider': {'max_completion_tokens': 100}}
        try:
            with BudgetRelay('not-a-real-key', 'test', .25, meta, 'http://127.0.0.1:%d' % server.server_port) as relay:
                def request(token=None):
                    return urllib.request.urlopen(urllib.request.Request(relay.base_url + '/chat/completions',
                        data=json.dumps({'model': 'test', 'messages': [{'role': 'user', 'content': 'hello'}]}).encode(),
                        headers={'Authorization': 'Bearer ' + (token or relay.token)}))
                with request() as response:
                    self.assertEqual(json.load(response)['id'], 'stub-generation')
                with self.assertRaises(urllib.error.HTTPError) as error:
                    request()
                self.assertEqual(error.exception.code, 402)
                with self.assertRaises(urllib.error.HTTPError) as error:
                    request('bad')
                self.assertEqual(error.exception.code, 403)
                self.assertEqual(len(calls), 1)
                self.assertAlmostEqual(relay.charged, .1)
                self.assertEqual(relay.records[0]['costUsd'], .1)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_stream_without_done_keeps_full_reservation(self):
        done = False

        class Stub(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                self.rfile.read(int(self.headers['Content-Length']))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'data: {"id":"stub", "usage":{"cost":0.01}}\n\n')
                if done:
                    self.wfile.write(b'data: [DONE]\n\n')

        server = HTTPServer(('127.0.0.1', 0), Stub)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        meta = {'pricing': {'prompt': '.001', 'completion': '.001'}, 'context_length': 100,
                'top_provider': {'max_completion_tokens': 100}}
        try:
            for done in (False, True):
                with BudgetRelay('dummy', 'test', .25, meta, 'http://127.0.0.1:%d' % server.server_port) as relay:
                    request = urllib.request.Request(relay.base_url + '/chat/completions',
                        data=json.dumps({'model': 'test', 'stream': True, 'messages': []}).encode(),
                        headers={'Authorization': 'Bearer ' + relay.token})
                    with urllib.request.urlopen(request) as response:
                        response.read()
                self.assertAlmostEqual(relay.charged, .01 if done else .2)
                self.assertEqual(relay.records[0]['costUsd'], .01 if done else None)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_custom_model_is_registered_and_key_is_an_environment_reference(self):
        from batch_build import opencode_env
        with tempfile.TemporaryDirectory() as folder:
            env = opencode_env({'HUMANSTUDY_DESKTOP_KEY': 'temporary-run-token'},
                               'anthropic/custom-model', Path(folder), 'http://127.0.0.1:1234/v1')
        config = json.loads(env['OPENCODE_CONFIG_CONTENT'])
        provider = config['provider']['humanstudy']
        self.assertEqual(config['small_model'], config['model'])
        self.assertIn('anthropic/custom-model', provider['models'])
        self.assertEqual(provider['options']['baseURL'], 'http://127.0.0.1:1234/v1')
        self.assertEqual(provider['options']['apiKey'], '{env:HUMANSTUDY_DESKTOP_KEY}')
        self.assertNotIn('temporary-run-token', env['OPENCODE_CONFIG_CONTENT'])

    def test_rejects_unbudgeted_features_and_prices(self):
        meta = {'pricing': {'prompt': '.001', 'completion': '.001'}, 'context_length': 100}
        with BudgetRelay('dummy', 'test', 3, meta) as relay:
            for patch in [{'n': 2}, {'service_tier': 'priority'}, {'model': 'other'}, {'plugins': [{'id': 'web'}]},
                          {'tools': [{'type': 'web_search'}]},
                          {'messages': [{'content': [{'type': 'image_url'}]}]}]:
                with self.assertRaises(ValueError):
                    relay.validate({'model': 'test', **patch})
        with self.assertRaises(ValueError):
            BudgetRelay('dummy', 'test', float('nan'), meta)
        with self.assertRaises(ValueError):
            BudgetRelay('dummy', 'test', 3, {**meta, 'pricing': {**meta['pricing'], 'request': '.01'}})


if __name__ == '__main__':
    unittest.main()
