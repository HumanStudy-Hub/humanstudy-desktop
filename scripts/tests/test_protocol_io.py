import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'pack/skills/build'))
import protocol_io

class ProtocolCheckpoints(unittest.TestCase):
    def test_checkpoints_preserve_content_and_refuse_stale_human_overwrites(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td)
            h=protocol_io.apply_patch(root,{'schema_version':'1','id':'test','meta':{'title':'Study'},'arms':[{'id':'blocked','runnable':False,'why':'Not yet read'}]},'absent')
            h2=protocol_io.apply_patch(root,{'meta':{'scope':'Read only'}},h)
            p=json.loads((root/'protocol.json').read_text())
            self.assertEqual(p['meta'],{'title':'Study','scope':'Read only'})
            p['meta']['title']='Researcher edit'
            (root/'protocol.json').write_text(json.dumps(p))
            before=(root/'protocol.json').read_bytes()
            with self.assertRaisesRegex(ValueError,'changed since'):
                protocol_io.apply_patch(root,{'meta':{'title':'Agent overwrite'}},h2)
            self.assertEqual((root/'protocol.json').read_bytes(),before)

    def test_refuses_published_held_text_edits(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);p=root/'protocol.json'
            p.write_text(json.dumps({'schema_version':'1','id':'test','distribution':{'held':{'a':{}}}}))
            h=hashlib.sha256(p.read_bytes()).hexdigest()
            with self.assertRaisesRegex(ValueError,'Published wording'):
                protocol_io.apply_patch(root,{'meta':{'title':'Changed'}},h)

if __name__=='__main__':unittest.main()
