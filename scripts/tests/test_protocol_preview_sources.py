import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]

class PreviewSources(unittest.TestCase):
    def test_full_passage_and_note_survive_the_preview_and_click_payload(self):
        with tempfile.TemporaryDirectory() as td:
            project=Path(td)
            for src,dest in [('runtime/hsenv','hsenv'),('skills/preview','skills/preview'),('artifact-kit','artifact-kit')]:
                shutil.copytree(ROOT/'pack'/src,project/'.opencode'/dest,ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
            p=json.loads((ROOT/'app/src/main/fixtures/protocol-draft.json').read_text())
            passage='A complete original sentence for this invented test. '*100
            note='A source qualification. '*80
            p['stages']['question']['content']=[{'id':'passage','value':passage,'cite':{'label':'verbatim','source':'survey','page':1,'note':note}}]
            (project/'protocol.json').write_text(json.dumps(p))
            result=subprocess.run([sys.executable,str(project/'.opencode/skills/preview/make_preview.py')],cwd=project,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            html=(project/'artifacts/preview.html').read_text()
            data=json.loads(re.search(r'id="hs-preview">(.*?)</script>',html,re.S)[1])
            key=data['arms'][0]['participants'][0]['screens'][0]['key']
            items=data['screens'][key]['items']
            item=next(i for i in items if i.get('text')==passage)
            self.assertEqual(item['cite']['quote'],passage)
            self.assertEqual(item['cite']['note'],note)
            self.assertNotIn("getAttribute('data-quote').slice",html)

if __name__=='__main__':unittest.main()
